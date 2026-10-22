import test from 'node:test';
import assert from 'node:assert/strict';

const { researchFieldLimits, validateStudyForm, validateParticipantForm, researchErrorMessage } =
  await import(new URL('../apps/mobile/src/research-validation.ts', import.meta.url).href);
const { studySchema, participantSchema, LocalError } =
  await import(new URL('../apps/mobile/src/platform/repository.ts', import.meta.url).href);
const studyId = '00000000-0000-4000-8000-000000000001';
const participantId = '00000000-0000-4000-8000-000000000002';
const at = '2026-10-22T00:00:00.000Z';
const timestamps = { createdAt: at, updatedAt: at };
const project = () => ({ code: 'SIMULATED_ONLY', title: '离线表单验证', ethicsId: '' });
const participant = () => ({ studyId, code: 'SIMULATED_ONLY-P001', consent: 'not_recorded' });

test('research form limits match stored and restored research records', () => {
  assert.deepEqual(researchFieldLimits, { studyCode: 64, studyTitle: 200, ethicsId: 120,
    participantCode: 64, trainingYear: 50, group: 100, note: 2000, rotationMonthsMin: 0, rotationMonthsMax: 600 });
});

test('study fields accept the storage boundary and reject one extra character in Chinese', () => {
  for (const [field, maximum, label] of [['code', 64, '项目编号'], ['title', 200, '项目名称'], ['ethicsId', 120, '伦理批件或备案编号']] as const) {
    const value = { ...project(), [field]: '项'.repeat(maximum) };
    assert.equal(validateStudyForm(value), undefined);
    assert.equal(studySchema.safeParse({ ...value, id: studyId, ...timestamps }).success, true);
    const overflow = { ...value, [field]: value[field].concat('超') };
    assert.equal(studySchema.safeParse({ ...overflow, id: studyId, ...timestamps }).success, false);
    assert.equal(validateStudyForm(overflow), `${label}最多 ${maximum} 个字符，请缩短后保存。`);
  }
});

test('participant fields share the storage boundaries including previously shorter group and note fields', () => {
  for (const [field, maximum, label] of [['code', 64, '学员编号'], ['trainingYear', 50, '培训年级'], ['group', 100, '组别'], ['note', 2000, '登记备注']] as const) {
    const fieldValue = '学'.repeat(maximum);
    const value = { ...participant(), [field]: fieldValue };
    assert.equal(validateParticipantForm(value), undefined);
    assert.equal(participantSchema.safeParse({ ...value, id: participantId, ...timestamps }).success, true);
    const overflow = { ...value, [field]: fieldValue.concat('超') };
    assert.equal(participantSchema.safeParse({ ...overflow, id: participantId, ...timestamps }).success, false);
    assert.equal(validateParticipantForm(overflow), `${label}最多 ${maximum} 个字符，请缩短后保存。`);
  }
});

test('blank required fields are rejected after trimming, while optional fields remain optional', () => {
  assert.equal(validateStudyForm({ ...project(), code: ' \t ' }), '请输入项目编号，不能只填写空格。');
  assert.equal(validateStudyForm({ ...project(), title: '　' }), '请输入项目名称，不能只填写空格。');
  assert.equal(validateParticipantForm({ ...participant(), code: ' ' }), '请输入学员编号，不能只填写空格。');
  assert.equal(validateStudyForm({ code: 'P', title: '项目' }), undefined);
  assert.equal(validateParticipantForm(participant()), undefined);
  assert.equal(validateParticipantForm({ ...participant(), studyId: 'not-a-uuid' }), '请选择有效的研究项目。');
  assert.equal(validateParticipantForm({ ...participant(), consent: 'invalid' }), '请选择有效的同意状态。');
});

test('rotation months preserve the existing numeric contract including fractional saved values', () => {
  for (const rotationMonths of [undefined, 0, 1.5, 600]) {
    const input = { ...participant(), rotationMonths };
    assert.equal(validateParticipantForm(input), undefined);
    assert.equal(participantSchema.safeParse({ ...input, id: participantId, ...timestamps }).success, true);
  }
  for (const rotationMonths of [-0.1, 600.1, Number.NaN, Number.POSITIVE_INFINITY, '3']) {
    assert.equal(validateParticipantForm({ ...participant(), rotationMonths }), '相关轮转月数须为 0 至 600 之间的数字。');
  }
});

test('valid and oversized editor values are checked without truncating or mutating existing records', () => {
  const existing = { ...participant(), id: participantId, ...timestamps,
    code: '  ' + 'P'.repeat(64) + '  ', trainingYear: '  ' + '年'.repeat(50) + '  ',
    group: '组'.repeat(100), note: '注'.repeat(2000), rotationMonths: 1.5 };
  const original = JSON.stringify(existing);
  assert.equal(validateParticipantForm(existing), undefined);
  assert.equal(JSON.stringify(existing), original);
  const oversized = { ...project(), id: studyId, ...timestamps, code: 'P'.repeat(80) };
  const oversizedOriginal = JSON.stringify(oversized);
  assert.match(validateStudyForm(oversized), /项目编号最多 64/);
  assert.equal(JSON.stringify(oversized), oversizedOriginal);
});

test('repository validator errors are translated without displaying raw Zod JSON or submitted content', () => {
  const result = studySchema.safeParse({ ...project(), id: studyId, ...timestamps, code: 'PRIVATE_INPUT_'.repeat(8) });
  assert.equal(result.success, false);
  const message = researchErrorMessage(result.error, 'study');
  assert.equal(message, '项目编号最多 64 个字符，请缩短后保存。');
  assert.doesNotMatch(message, /PRIVATE_INPUT|too_big|maximum|origin|\{|\[/);
  assert.equal(researchErrorMessage(result.error), '登记资料格式不正确，请检查后重试。');
});

test('known duplicate and storage messages remain useful while arbitrary error payloads stay hidden', () => {
  assert.equal(researchErrorMessage(new LocalError('项目代码已存在。'), 'study'), '项目代码已存在。');
  const storageMessage = '本机数据保存未完成，请检查设备可用空间后重试。';
  assert.equal(researchErrorMessage(new Error(storageMessage)), storageMessage);
  for (const error of [new Error('[{"code":"too_big","input":"PRIVATE_INPUT"}]'),
    new Error('native payload PRIVATE_INPUT'), { message: '{"private":"PRIVATE_INPUT"}' }, 'PRIVATE_INPUT']) {
    const message = researchErrorMessage(error);
    assert.match(message, /操作未完成/);
    assert.doesNotMatch(message, /PRIVATE_INPUT|too_big|native|\{|\[/);
  }
});
