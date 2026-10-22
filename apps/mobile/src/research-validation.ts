import { z } from 'zod';
import { LocalError, participantSchema, studySchema } from './platform/repository';

// Read the form limits from the same schemas used to save and restore records.
// Validation never rewrites the editor value; normalization remains in the repository.
export const researchFieldLimits = {
  studyCode: studySchema.shape.code.maxLength ?? undefined,
  studyTitle: studySchema.shape.title.maxLength ?? undefined,
  ethicsId: studySchema.shape.ethicsId.unwrap().maxLength ?? undefined,
  participantCode: participantSchema.shape.code.maxLength ?? undefined,
  trainingYear: participantSchema.shape.trainingYear.unwrap().maxLength ?? undefined,
  group: participantSchema.shape.group.unwrap().maxLength ?? undefined,
  note: participantSchema.shape.note.unwrap().maxLength ?? undefined,
  rotationMonthsMin: participantSchema.shape.rotationMonths.unwrap().minValue ?? undefined,
  rotationMonthsMax: participantSchema.shape.rotationMonths.unwrap().maxValue ?? undefined,
};

const studyFormSchema = studySchema.pick({ code: true, title: true, ethicsId: true }).strip();
const participantFormSchema = participantSchema.pick({
  studyId: true, code: true, trainingYear: true, rotationMonths: true,
  group: true, consent: true, note: true,
}).strip();
type FormKind = 'study' | 'participant';
const fieldNames: Record<FormKind, Record<string, string>> = {
  study: { code: '项目编号', title: '项目名称', ethicsId: '伦理批件或备案编号' },
  participant: { studyId: '研究项目', code: '学员编号', trainingYear: '培训年级',
    rotationMonths: '相关轮转月数', group: '组别', consent: '同意状态', note: '登记备注' },
};

function validationMessage(error: z.ZodError, kind?: FormKind): string {
  const issue = error.issues[0];
  const field = issue?.path[0];
  const label = kind && typeof field === 'string' ? fieldNames[kind][field] : undefined;
  if (!issue || !label) return '登记资料格式不正确，请检查后重试。';
  if (field === 'rotationMonths') return `相关轮转月数须为 ${researchFieldLimits.rotationMonthsMin} 至 ${researchFieldLimits.rotationMonthsMax} 之间的数字。`;
  if (field === 'studyId' || field === 'consent') return `请选择有效的${label}。`;
  if (issue.code === 'too_big') return `${label}最多 ${issue.maximum} 个字符，请缩短后保存。`;
  if (issue.code === 'too_small') return `请输入${label}，不能只填写空格。`;
  return `${label}格式不正确，请重新填写。`;
}

export function validateStudyForm(input: unknown): string | undefined {
  const result = studyFormSchema.safeParse(input);
  return result.success ? undefined : validationMessage(result.error, 'study');
}

export function validateParticipantForm(input: unknown): string | undefined {
  const result = participantFormSchema.safeParse(input);
  return result.success ? undefined : validationMessage(result.error, 'participant');
}

export function researchErrorMessage(error: unknown, kind?: FormKind): string {
  if (error instanceof z.ZodError) return validationMessage(error, kind);
  // Repository errors are authored user messages, rather than raw validator/native errors.
  if (error instanceof LocalError) return error.message;
  const storageMessages = new Set([
    '本机数据库无法打开，请检查设备存储空间。',
    '本机数据保存未完成，请检查设备可用空间后重试。',
    '下次训练绑定尚未保存，请检查设备存储后重试。',
    '训练登记尚未读取完成，请刷新后重试。',
  ]);
  if (error instanceof Error && storageMessages.has(error.message)) return error.message;
  return '操作未完成，请检查输入或设备存储后重试。';
}
