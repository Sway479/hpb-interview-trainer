import test from 'node:test';
import assert from 'node:assert/strict';
import { cases, getCase } from '../packages/core/src/cases.ts';
import { getAssessmentCriteria, getAssessmentMetadata, summarizeAssessmentScores } from '../packages/core/src/assessment.ts';
import type { Feedback, Session, Turn } from '../packages/core/src/types.ts';
import { feedbackPrompt, validateFeedback } from '../server/feedback.ts';

const definition = getCase('ruq-01');
const criteria = getAssessmentCriteria(definition);
const spoken = {
  time: '疼痛是什么时候开始的？是一直痛还是一阵阵痛？',
  pain: '您能说一下哪里疼、是什么感觉、有多重，会不会牵到别处吗？',
  identity: '您好，我是住院医师王医生，请问您怎么称呼？',
  inappropriate: '不用核对您的身份，我不接受您的纠正。',
  dismissive: '别说你的担心了，我不想听。',
};
const learner = (id: string, text: string, extra: Partial<Turn> = {}): Turn => ({
  id, text, role: 'learner', at: '2026-10-21T00:00:00.000Z', source: 'typed', final: true, ...extra,
});
const session = (turns: Turn[] = [learner('time', spoken.time), learner('pain', spoken.pain), learner('identity', spoken.identity),
  learner('inappropriate', spoken.inappropriate), learner('dismissive', spoken.dismissive)]): Session => ({
  id: 'fbdab410-8389-4cf0-901b-c6ef67532000', caseId: definition.id, caseVersion: definition.version, caseTitle: definition.title,
  createdAt: '2026-10-21T00:00:00.000Z', endedAt: '2026-10-21T00:10:00.000Z', status: 'feedback_pending', turns,
  summary: { history: '总结中自称已经问全所有项目，但不能替代问诊原文。', reasoning: '目前待核实。', plan: '继续核实。', uncertainty: '仍有未知。' },
});
function payload() {
  return { items: criteria.map(criterion => ({ criterionId: criterion.id,
    status: 'insufficient_evidence', score: null as number | null, comment: '学员未询问这个项目。',
    evidence: [] as { turnId: string; quote: string }[], notScoredReason: 'insufficient_evidence' as string | null,
    zeroEvidence: null as { turnId: string; quote: string; problem: string } | null,
  })) };
}
function grade(value: ReturnType<typeof payload>, source = session()) { return validateFeedback(JSON.stringify(value), definition, source, 'qwen3.8-flash'); }
function assign(value: ReturnType<typeof payload>, id: string, score: number, turnId: keyof typeof spoken) {
  const item = value.items.find(entry => entry.criterionId === id)!;
  Object.assign(item, { score, status: score === 2 ? 'observed' : 'to_improve', comment: '引文支持该锚点的自动预评，待教师核对。',
    evidence: [{ turnId, quote: spoken[turnId] }], notScoredReason: null });
  return item;
}

test('assessment metadata names the adaptation, links primary sources, and reveals no hidden case content', () => {
  const publicMetadata = getAssessmentMetadata();
  assert.equal(publicMetadata.id, 'hpb-voice-formative-assessment'); assert.equal(publicMetadata.version, '0.1');
  assert.equal(publicMetadata.name, '本课题改编的语音问诊形成性量规v0.1'); assert.equal(publicMetadata.adapted, true);
  assert.ok(publicMetadata.sources.some(source => source.url === 'https://cdn.dal.ca/content/dam/dalhousie/pdf/faculty/medicine/departments/core-units/postgrad/Medical-Interview-CCG.pdf'));
  assert.ok(publicMetadata.sources.some(source => source.url === 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3948635/'));
  const local = publicMetadata.sources.find(source => source.kind === 'local_adaptation');
  assert.equal(local?.url, null); assert.match(local?.note ?? '', /待专家校订/);
  const serialized = JSON.stringify(publicMetadata);
  for (const hidden of cases.flatMap(item => [item.id, item.opening, ...item.facts.map(fact => fact.patientWords)]))
    assert.ok(!serialized.includes(hidden));
  assert.equal((publicMetadata as any).criteria, undefined); assert.equal((publicMetadata as any).rubric, undefined);
  assert.ok(publicMetadata.limitations.some(line => line.includes('尚未验证')));
  publicMetadata.sources.length = 0; assert.equal(getAssessmentMetadata().sources.length, 3);
});

test('each case has five content items and seven distinct process criteria with traceable local anchors', () => {
  const sourceIds = new Set(getAssessmentMetadata().sources.map(source => source.id));
  for (const item of cases) {
    assert.equal(item.version, '1.1.0');
    const list = getAssessmentCriteria(item);
    assert.equal(list.length, 12); assert.equal(new Set(list.map(criterion => criterion.id)).size, 12);
    assert.equal(list.filter(criterion => criterion.group === 'case_history').length, 5);
    assert.equal(list.filter(criterion => criterion.group === 'communication_process').length, 7);
    assert.ok(item.rubric.every(criterion => !['communication', 'reasoning', 'safety'].includes(criterion.id)));
    assert.ok(list.every(criterion => criterion.maxScore === 2 && criterion.sourceIds.every(id => sourceIds.has(id))));
    assert.ok(list.every(criterion => criterion.anchors['0'] && criterion.anchors['1'] && criterion.anchors['2'] && criterion.anchors.null));
    assert.ok(list.filter(criterion => criterion.group === 'case_history').every(criterion => criterion.id.startsWith(`case.${item.id}.`)));
  }
  assert.throws(() => getAssessmentCriteria({ ...definition, rubric: [...definition.rubric, definition.rubric[0]] }), /ID重复/);
});

test('the Flash prompt includes every anchored criterion and keeps submitted summary separate from observed turns', () => {
  const source = session(); const prompt = feedbackPrompt(definition, source); const input = JSON.parse(prompt.input);
  assert.deepEqual(input.criteria.map((item: any) => item.id), criteria.map(item => item.id));
  assert.deepEqual(input.independentSummary, source.summary); assert.deepEqual(input.transcript, source.turns);
  assert.deepEqual(Object.keys(input.case).sort(), ['id', 'version']);
  assert.ok(input.criteria.every((item: any) => item.group && item.sourceIds.length && item.anchors['2']));
  assert.match(prompt.instructions, /未提到绝不能自动记0/); assert.match(prompt.instructions, /不在本量规中追加总结分/);
  assert.match(prompt.instructions, /zeroEvidence/);
});

test('all-null, not-applicable and unobservable items remain unscored rather than becoming zero performance', () => {
  const value = payload(); value.items[0].notScoredReason = 'not_applicable'; value.items[1].notScoredReason = 'unobservable';
  const result = grade(value);
  assert.ok(result.items.every(item => item.score === null && item.status === 'insufficient_evidence'));
  assert.equal(result.items[0].notScoredReason, 'not_applicable'); assert.equal(result.items[1].notScoredReason, 'unobservable');
  assert.ok(!result.items.some(item => item.comment === '学员未询问这个项目。'));
  for (const group of Object.values(result.scoreSummary!)) {
    assert.equal(group.score, 0); assert.equal(group.maxScore, 0); assert.equal(group.scoredItems, 0); assert.equal(group.coverage, 0);
  }
  assert.equal(result.scoreSummary!.case_history.totalItems, 5); assert.equal(result.scoreSummary!.communication_process.totalItems, 7);
  assert.ok(!result.overview.includes('0分')); assert.match(result.overview, /12项当前未能评分/);
  assert.equal((result.scoreSummary as any).overall, undefined);
});

test('group scores include only assessed denominators and distinguish an evidenced zero from an unscored item', () => {
  const value = payload();
  assign(value, 'case.ruq-01.timeline', 2, 'time'); assign(value, 'case.ruq-01.pain', 1, 'pain');
  assign(value, 'process.identity', 1, 'identity');
  const zero = assign(value, 'process.empathy_plain_language', 0, 'dismissive');
  zero.comment = '原文直接压制患者表达担忧。'; zero.zeroEvidence = { turnId: 'dismissive', quote: spoken.dismissive, problem: '明确拒绝倾听患者担忧' };
  const result = grade(value), groups = result.scoreSummary!;
  assert.deepEqual(groups.case_history, { group: 'case_history', label: '病例信息采集', score: 3, maxScore: 4, scoredItems: 2, totalItems: 5, coverage: 2 / 5 });
  assert.deepEqual(groups.communication_process, { group: 'communication_process', label: '可观察的语言沟通过程', score: 1, maxScore: 4, scoredItems: 2, totalItems: 7, coverage: 2 / 7 });
  assert.equal(result.items.find(item => item.criterionId === zero.criterionId)?.score, 0);
  assert.equal(result.reviewStatus, 'pending'); assert.equal(result.assessment?.adapted, true);
  assert.ok(result.items.every(item => item.maxScore === 2 && item.group && item.sourceIds?.length));
});

test('a full score contradicted by its own omission claim is unscored and excluded from the denominator', () => {
  const value = payload();
  assign(value, 'case.ruq-01.timeline', 2, 'time');
  const contradictory = assign(value, 'process.identity', 2, 'identity');
  contradictory.comment = '学员未询问患者姓名，身份核对尚不充分。';
  const result = grade(value);
  const item = result.items.find(entry => entry.criterionId === contradictory.criterionId)!;
  assert.equal(item.score, null);
  assert.equal(item.status, 'insufficient_evidence');
  assert.equal(item.notScoredReason, 'insufficient_evidence');
  assert.deepEqual(item.evidence, contradictory.evidence, 'retain the real quotation for teacher review');
  assert.ok(!item.comment.includes('充分实现'));
  assert.match(item.comment, /暂不计分/);
  assert.equal(result.scoreSummary!.communication_process.scoredItems, 0);
  assert.equal(result.scoreSummary!.communication_process.maxScore, 0);
  assert.equal(result.scoreSummary!.case_history.score, 2, 'an independent supported full score remains assessed');
  assert.equal(result.scoreSummary!.case_history.maxScore, 2);
});

test('zero requires cited direct-problem evidence and rejects explanations based only on missing information', () => {
  for (const mutation of ['no_direct_quote', 'omission_inference', 'foreign_direct_quote'] as const) {
    const value = payload(); const item = assign(value, 'process.identity', 0, 'time');
    if (mutation === 'omission_inference') {
      item.zeroEvidence = { turnId: 'time', quote: spoken.time, problem: '学员未询问身份' }; item.comment = '学员没有询问身份。';
    }
    if (mutation === 'foreign_direct_quote') item.zeroEvidence = { turnId: 'inappropriate', quote: spoken.inappropriate, problem: '明确拒绝身份核对' };
    assert.equal(grade(value).items.find(entry => entry.criterionId === item.criterionId)?.score, null, mutation);
  }
  const value = payload(); const item = assign(value, 'process.identity', 0, 'inappropriate');
  item.comment = '原文明确拒绝身份核对及患者纠正。';
  item.zeroEvidence = { turnId: 'inappropriate', quote: spoken.inappropriate, problem: '明确拒绝身份核对及纠正' };
  const result = grade(value); assert.equal(result.items.find(entry => entry.criterionId === item.criterionId)?.score, 0);
  assert.deepEqual(result.items.find(entry => entry.criterionId === item.criterionId)?.zeroEvidence, item.zeroEvidence);
  assert.equal(result.scoreSummary!.communication_process.maxScore, 2); assert.equal(result.scoreSummary!.communication_process.score, 0);
});

test('forged, partial, interrupted, unverified, patient-only and summary-only citations cannot carry points', () => {
  const source = session([
    learner('time', spoken.time), learner('partial', spoken.time, { final: false, source: 'asr' }),
    learner('interrupted', spoken.time, { interrupted: true }),
    learner('patient', spoken.time, { role: 'patient', source: 'model' }),
    learner('unverified', spoken.time, { role: 'patient', source: 'model', verification: 'paraphrase_unverified' }),
  ]);
  for (const bad of [
    { turnId: 'missing', quote: spoken.time }, { turnId: 'time', quote: '伪造原文' },
    { turnId: 'partial', quote: spoken.time }, { turnId: 'interrupted', quote: spoken.time },
    { turnId: 'patient', quote: spoken.time }, { turnId: 'unverified', quote: spoken.time },
    { turnId: 'summary.history', quote: source.summary!.history },
  ]) {
    const value = payload(); const item = assign(value, 'case.ruq-01.timeline', 2, 'time'); item.evidence = [bad];
    assert.equal(grade(value, source).items[0].score, null, bad.turnId);
  }
  const mixed = payload(); const item = assign(mixed, 'case.ruq-01.timeline', 2, 'time');
  item.evidence.push({ turnId: 'missing', quote: '伪造的补充引文' });
  assert.equal(grade(mixed, source).items[0].score, null, 'one invalid citation must invalidate the scored judgment');
  const stray = payload(); const strayItem = assign(stray, 'case.ruq-01.timeline', 2, 'time');
  strayItem.zeroEvidence = { turnId: 'missing', quote: '无效的额外引文', problem: '无出处的额外判定' };
  assert.equal(grade(stray, source).items[0].score, null, 'invalid evidence in an extra basis field must not be ignored');
});

test('strict project coverage rejects missing, duplicate or unknown IDs and bounded score metadata cannot be inflated', () => {
  const missing = payload(); missing.items.pop(); assert.throws(() => grade(missing), /缺失|重复|陌生/);
  const duplicate = payload(); duplicate.items[1] = { ...duplicate.items[0] }; assert.throws(() => grade(duplicate), /缺失|重复|陌生/);
  const unknown = payload(); unknown.items[0].criterionId = 'process.invented'; assert.throws(() => grade(unknown), /缺失|重复|陌生/);
  const inflated = payload(); inflated.items[0].score = 100; assert.throws(() => grade(inflated));
  const wrongMax = payload(); (wrongMax.items[0] as any).maxScore = 10; assert.throws(() => grade(wrongMax));
  const wrongGroup = payload(); (wrongGroup.items[0] as any).group = 'communication_process'; assert.throws(() => grade(wrongGroup), /分组/);
  const wrongSource = payload(); (wrongSource.items[0] as any).sourceIds = ['national-official']; assert.throws(() => grade(wrongSource), /来源/);
  const inconsistent = payload(); assign(inconsistent, 'case.ruq-01.timeline', 2, 'time').status = 'insufficient_evidence';
  assert.equal(grade(inconsistent).items[0].score, null);
  const reversed = payload(); reversed.items.reverse(); assert.deepEqual(grade(reversed).items.map(item => item.criterionId), criteria.map(item => item.id));
});

test('old saved feedback remains readable without inventing newly introduced scores', () => {
  const legacy: Feedback = { overview: '历史反馈', items: [{ criterionId: 'timeline', label: '原项目', status: 'observed', comment: '历史说明', evidence: [] }],
    nextPractice: [], model: 'old-model', createdAt: '2026-10-20T00:00:00Z', reviewStatus: 'pending' };
  assert.equal(legacy.assessment, undefined); assert.equal(legacy.scoreSummary, undefined); assert.equal(legacy.items[0].score, undefined);
  assert.throws(() => summarizeAssessmentScores([{ group: 'case_history', score: 3 as any, maxScore: 2 }]));
});
