import { z } from 'zod';
import { DEFAULT_RESEARCH_SELECTION, type Participant, type ResearchSelection, type Study } from './contracts';
import { documents, type DocumentStorage } from './storage';

export const RESEARCH_SELECTION_PATH = 'preferences/research-selection.json';
export interface ResearchSelectionRegistry {
  studies: readonly Pick<Study, 'id'>[];
  participants: readonly Pick<Participant, 'id' | 'studyId'>[];
}
export interface ResearchSelectionResult {
  selection: ResearchSelection;
  warning?: string;
}

const selectionSchema = z.object({
  mode: z.enum(['practice', 'research']),
  phase: z.enum(['baseline', 'training', 'post', 'retention']),
  studyId: z.string().uuid().optional(),
  participantId: z.string().uuid().optional(),
}).strict();
const storedSchema = z.object({ version: z.literal(1), selection: z.unknown() }).strict();
const writing = new WeakMap<DocumentStorage, Promise<void>>();
const safePractice = (warning?: string): ResearchSelectionResult => ({
  selection: { ...DEFAULT_RESEARCH_SELECTION },
  ...(warning ? { warning } : {}),
});

/** Validate UUID relationships, never substitute another registration with the same displayed code. */
export function validateResearchSelection(value: unknown, registry: ResearchSelectionRegistry): ResearchSelection {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const normalized = input?.mode === 'practice' ? { ...input, studyId: undefined, participantId: undefined } : value;
  const parsed = selectionSchema.safeParse(normalized);
  if (!parsed.success) throw new Error('下次训练绑定格式无效，请重新设置。');
  const selection = parsed.data;
  if (selection.mode === 'practice') return { mode: selection.mode, phase: selection.phase };
  if (!selection.studyId || !selection.participantId)
    throw new Error('科研训练缺少项目或学员绑定，请重新选择。');
  const study = registry.studies.find(item => item.id === selection.studyId);
  const participant = registry.participants.find(item => item.id === selection.participantId);
  if (!study || !participant)
    throw new Error('原训练绑定的项目或学员已不存在，请重新选择。');
  if (participant.studyId !== study.id)
    throw new Error('原训练绑定的学员与项目不匹配，请重新选择。');
  return { mode: selection.mode, phase: selection.phase, studyId: study.id, participantId: participant.id };
}

/** Call after registrations are loaded. Invalid saved data is retained, but never used for a new session. */
export async function loadResearchSelection(
  registry: ResearchSelectionRegistry,
  storage: DocumentStorage = documents,
): Promise<ResearchSelectionResult> {
  let raw: string | null;
  try {
    await writing.get(storage);
    raw = await storage.read(RESEARCH_SELECTION_PATH);
  } catch {
    return safePractice('下次训练绑定读取失败，当前使用练习模式；请检查本机存储后重新设置。');
  }
  if (raw === null) return safePractice();
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return safePractice('已保存的下次训练绑定不是有效配置，已改用练习模式；请重新设置。'); }
  const parsed = storedSchema.safeParse(value);
  if (!parsed.success) return safePractice('已保存的下次训练绑定无法识别，已改用练习模式；请重新设置。');
  try { return { selection: validateResearchSelection(parsed.data.selection, registry) }; }
  catch (error) { return safePractice((error instanceof Error ? error.message : '训练绑定无效。') + '当前已改用练习模式。'); }
}

/** A resolved promise means the private document write completed; callers must await it before showing success. */
export async function saveResearchSelection(
  value: ResearchSelection,
  registry: ResearchSelectionRegistry,
  storage: DocumentStorage = documents,
): Promise<ResearchSelection> {
  const selection = validateResearchSelection(value, registry);
  // Keep rapid saves in invocation order, including after a failed write.
  const task = (writing.get(storage) ?? Promise.resolve()).then(async () => {
    try { await storage.write(RESEARCH_SELECTION_PATH, JSON.stringify({ version: 1, selection })); }
    catch { throw new Error('下次训练绑定尚未保存，请检查设备存储后重试。'); }
  });
  writing.set(storage, task.then(() => undefined, () => undefined));
  await task;
  return { ...selection };
}
