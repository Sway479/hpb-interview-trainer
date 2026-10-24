import test from 'node:test';
import assert from 'node:assert/strict';
import { getAssessmentCriteria, getAssessmentMetadata } from '../packages/core/src/assessment.ts';
import { getCase } from '../packages/core/src/cases.ts';
import { buildInterviewResultExplanation, formatInterviewResultExplanation } from '../packages/core/src/result-explanation.ts';
import type { AssessmentScore, FeedbackItem, Session, Turn } from '../packages/core/src/types.ts';



const definition = getCase('ruq-01');
const criteria = getAssessmentCriteria(definition);
const at = '2026-10-23T00:00:00.000Z';
const quote = '请问什么时候开始疼的？';
const exportModule = new URL('../apps/mobile/src/platform/export-data.ts', import.meta.url).href;
const { researchFiles } = await import(exportModule);

/** Parse CSV independently, including quoted commas and newlines. */
function csvObjects(csv: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  csv = csv.replace(/^\uFEFF/, '');
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && char === ',') { row.push(field); field = ''; }
    else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && csv[index + 1] === '\n') index++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  assert.equal(quoted, false);
  if (field || row.length) rows.push([...row, field]);
  const [headers, ...data] = rows;
  return data.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]])));
}

function turn(id = 'learner-1', overrides: Partial<Turn> = {}): Turn {
  return { id, role: 'learner', text: quote, source: 'typed', final: true, at, ...overrides };
}
function item(id = 'case.ruq-01.timeline', score: AssessmentScore = 1, overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  const criterion = criteria.find(value => value.id === id)!;
  return {
    criterionId: id, label: criterion.label, score, maxScore: 2, group: criterion.group,
    sourceIds: [...criterion.sourceIds], status: score === null ? 'insufficient_evidence' : score === 2 ? 'observed' : 'to_improve',
    comment: '记录支持该条目的一部分，需结合锚点核对。', evidence: [{ turnId: 'learner-1', quote }],
    ...(score === null ? { notScoredReason: 'insufficient_evidence' as const } : {}), ...overrides,
  };
}
function session(items = [item()], overrides: Partial<Session> = {}): Session {
  return {
    id: 'SIMULATED_ONLY-result-explanation', caseId: definition.id, caseVersion: definition.version,
    caseTitle: definition.title, createdAt: at, status: 'feedback_ready', turns: [turn()],
    feedback: {
      overview: '历史原始反馈摘要，保留不改写。', items,
      nextPractice: ['历史自动练习建议，不能直接认定为学员不足。'], model: 'SIMULATED_ONLY-no-api',
      createdAt: at, reviewStatus: 'pending', assessment: getAssessmentMetadata(),
    }, ...overrides,
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('result explanation links a partial observation to a specific goal, practice question and completion check', () => {
  const report = buildInterviewResultExplanation(session([
    item('process.closure', 1), item('case.ruq-01.timeline', 1),
  ]));
  assert.equal(report.available, true);
  assert.equal(report.improvements.length, 2);
  const closure = report.improvements.find(value => value.criterionId === 'process.closure')!;
  assert.equal(closure.origin, 'automatic');
  assert.equal(closure.originalScore, 1);
  assert.deepEqual(closure.evidence, [{ turnId: 'learner-1', quote }]);
  assert.match(closure.finding, /AI原评.*部分实现/);
  assert.match(closure.practice.goal, /概括.*病史.*纠正.*核实/);
  assert.match(closure.practice.question, /小结.*补充/);
  assert.match(closure.practice.completion, /三部分.*未来计划不能代替/);
  assert.match(report.improvements[1].practice.goal, /起病.*诱因.*持续或间歇/);
  assert.match(closure.warnings.join(' '), /偏高或跨轮漏评/);
});

test('evidence-supported explicit inappropriate behavior is prioritized before partial completion', () => {
  const text = '你不需要解释，我就按我说的记录。';
  const zero = item('process.focused_followup', 0, {
    comment: '原文显示拒绝患者澄清。', evidence: [{ turnId: 'learner-1', quote: text }],
    zeroEvidence: { turnId: 'learner-1', quote: text, problem: '拒绝患者澄清并强加预设记录。' },
  });
  const report = buildInterviewResultExplanation(session([
    item('process.opening', 1, { evidence: [{ turnId: 'learner-1', quote: text }] }), zero,
  ], { turns: [turn('learner-1', { text })] }));
  assert.equal(report.practicePlan[0].criterionId, zero.criterionId);
  assert.equal(report.practicePlan[0].score, 0);
  assert.match(report.practicePlan[0].finding, /有出处不等于.*语义判断已被证实/);
});

for (const reason of ['insufficient_evidence', 'not_applicable', 'unobservable'] as const) {
  test(`an unscored ${reason} item is unresolved, never a proved deficiency or priority practice`, () => {
    const report = buildInterviewResultExplanation(session([item('process.patient_perspective', null, {
      notScoredReason: reason, comment: '学员遗漏了所有应问的内容。',
    })]));
    assert.equal(report.improvements.length, 0);
    assert.equal(report.strengths.length, 0);
    assert.equal(report.practicePlan.length, 0);
    assert.equal(report.unresolved.length, 1);
    const plain = formatInterviewResultExplanation(report);
    assert.doesNotMatch(plain, /学员遗漏了所有/);
    assert.match(plain, /不能据此判断已全面掌握/);
    if (reason === 'not_applicable') assert.match(report.unresolved[0].finding, /本次不适用/);
    if (reason === 'unobservable') assert.match(report.unresolved[0].finding, /无法观察/);
  });
}

for (const corrected of [null, 1, 2] as const) {
  test(`teacher correction ${String(corrected)} stays separate from the AI original and leaves other items automatic`, () => {
    const value = session([item('process.opening', 2), item('process.closure', 1)]);
    value.review = {
      reviewer: 'SIMULATED_ONLY-teacher', notes: '整体意见不等于逐项确认。', at,
      corrections: [{ criterionId: 'process.opening', score: corrected, reason: '本机教师结合原始材料作出的独立意见。' }],
    };
    const before = JSON.stringify(value);
    const report = buildInterviewResultExplanation(freeze(value));
    const all = [...report.strengths, ...report.improvements, ...report.unresolved];
    const teacher = all.find(entry => entry.criterionId === 'process.opening')!;
    assert.equal(teacher.origin, 'teacher');
    assert.equal(teacher.originalScore, 2);
    assert.equal(teacher.score, corrected);
    assert.equal(teacher.disposition, corrected === null ? 'unresolved' : corrected === 2 ? 'strength' : 'improve');
    assert.match(teacher.teacherReason!, /教师/);
    assert.equal(all.find(entry => entry.criterionId === 'process.closure')!.origin, 'automatic');
    assert.equal(report.reviewNote, value.review.notes);
    assert.equal(JSON.stringify(value), before);
  });
}

test('a general teacher review note does not turn uncorrected AI items into teacher ratings', () => {
  const value = session();
  value.review = { reviewer: 'SIMULATED_ONLY-teacher', notes: '记录已浏览，仍需核对各条目。', at };
  const report = buildInterviewResultExplanation(value);
  assert.equal(report.improvements[0].origin, 'automatic');
  assert.equal(report.improvements[0].teacherReason, undefined);
});

test('missing feedback produces a pending explanation without inventing findings', () => {
  const value = session(); delete value.feedback;
  const report = buildInterviewResultExplanation(value);
  assert.equal(report.available, false);
  assert.equal(report.strengths.length + report.improvements.length + report.unresolved.length, 0);
  assert.equal(report.practicePlan.length, 0);
  assert.match(formatInterviewResultExplanation(report), /反馈尚未生成/);
});

test('legacy feedback with no numeric score is not reconstructed from its observed status', () => {
  const legacy = item('process.opening', 2); delete legacy.score;
  const report = buildInterviewResultExplanation(session([legacy]));
  assert.equal(report.strengths.length, 0);
  assert.equal(report.improvements.length, 0);
  assert.equal(report.unresolved[0].originalScore, undefined);
  assert.equal(report.unresolved[0].score, null);
});

for (const variant of ['missing_assessment', 'wrong_assessment_id', 'wrong_assessment_version', 'wrong_case_version', 'unknown_case'] as const) {
  test(`unmatched ${variant} does not apply the current anchors or infer a deficiency`, () => {
    const value = session([item('process.opening', 1)]);
    if (variant === 'missing_assessment') delete value.feedback!.assessment;
    if (variant === 'wrong_assessment_id') value.feedback!.assessment!.id = 'old-unmatched-rubric';
    if (variant === 'wrong_assessment_version') value.feedback!.assessment!.version = 'old-version';
    if (variant === 'wrong_case_version') value.caseVersion = 'old-case-version';
    if (variant === 'unknown_case') value.caseId = 'SIMULATED_ONLY-unknown-case';
    const report = buildInterviewResultExplanation(value);
    assert.equal(report.improvements.length, 0);
    assert.equal(report.strengths.length, 0);
    assert.equal(report.unresolved.length, 1);
    assert.match(report.unresolved[0].finding, /版本依据/);
    assert.equal(report.practicePlan.length, 0);
    assert.doesNotMatch(report.unresolved[0].practice.question, /还有哪些问题希望一起讨论/,
      'do not apply the current opening example to an unmatched historical rubric');
    assert.match(report.unresolved[0].practice.completion, /没有版本依据时不套用新版锚点/);
  });
}

const invalidEvidence = [
  { name: 'no evidence', turns: [turn()], evidence: [] },
  { name: 'unknown turn', turns: [turn()], evidence: [{ turnId: 'missing', quote }] },
  { name: 'fabricated quote', turns: [turn()], evidence: [{ turnId: 'learner-1', quote: '不存在的原文。' }] },
  { name: 'partial transcript', turns: [turn('learner-1', { final: false })], evidence: [{ turnId: 'learner-1', quote }] },
  { name: 'interrupted turn', turns: [turn('learner-1', { interrupted: true })], evidence: [{ turnId: 'learner-1', quote }] },
  { name: 'unverified transcript', turns: [turn('learner-1', { verification: 'paraphrase_unverified' })], evidence: [{ turnId: 'learner-1', quote }] },
  { name: 'patient-only evidence', turns: [turn('learner-1', { role: 'patient' })], evidence: [{ turnId: 'learner-1', quote }] },
  { name: 'duplicated turn ID', turns: [turn(), turn('learner-1', { text: '另一个不相同的句子。' })], evidence: [{ turnId: 'learner-1', quote }] },
];
for (const candidate of invalidEvidence) {
  test(`${candidate.name} cannot support a learner performance finding`, () => {
    const report = buildInterviewResultExplanation(session([item('process.opening', 2, { evidence: candidate.evidence })], { turns: candidate.turns }));
    assert.equal(report.strengths.length, 0);
    assert.equal(report.improvements.length, 0);
    assert.equal(report.unresolved.length, 1);
    assert.equal(report.practicePlan.length, 0);
  });
}

test('one valid quote does not rescue a rating that also relies on invalid citations', () => {
  const report = buildInterviewResultExplanation(session([item('process.opening', 2, {
    evidence: [{ turnId: 'learner-1', quote }, { turnId: 'missing', quote: '伪造的另一半行为证据。' }],
  })]));
  assert.equal(report.strengths.length, 0);
  assert.equal(report.improvements.length, 0);
  assert.equal(report.unresolved.length, 1);
  assert.match(report.unresolved[0].warnings.join(' '), /原引用/);
});

test('all occurrences of a duplicated criterion are unresolved instead of contradictory findings', () => {
  const report = buildInterviewResultExplanation(session([item('process.opening', 2), item('process.opening', 1)]));
  assert.equal(report.strengths.length, 0);
  assert.equal(report.improvements.length, 0);
  assert.equal(report.unresolved.length, 2);
  assert.equal(report.practicePlan.length, 0);
});

test('a missing-behavior assertion cannot become a zero-score deficiency through a generic zero rationale', () => {
  const report = buildInterviewResultExplanation(session([item('process.opening', 0, {
    comment: '学员没有询问患者议题。',
    zeroEvidence: { turnId: 'learner-1', quote, problem: '明确不当问诊方式。' },
  })]));
  assert.equal(report.improvements.length, 0);
  assert.equal(report.unresolved.length, 1);
  assert.equal(report.practicePlan.length, 0);
});

test('all-full-score feedback never produces pass, global competence or an invented percentage', () => {
  const report = buildInterviewResultExplanation(session(criteria.map(value => item(value.id, 2))));
  assert.equal(report.improvements.length, 0);
  assert.equal(report.practicePlan.length, 0);
  assert.equal(report.strengths.length, criteria.length);
  assert.match(report.headline, /不据此判定已合格或全面掌握/);
  const plain = formatInterviewResultExplanation(report);
  assert.doesNotMatch(plain, /考核通过|已经合格|完全掌握|\d+\s*%|百分制总分/);
});

test('report generation and plaintext formatting leave the entire original object unchanged', () => {
  const value = session([item('process.closure', 1), item('process.opening', null)]);
  value.review = { reviewer: 'SIMULATED_ONLY-teacher', notes: '保留原始评分和历史意见。', at };
  value.reviewHistory = [{ reviewer: 'SIMULATED_ONLY-previous', notes: '原始历史复核。', at }];
  value.feedbackAttempts = [{ id: 'original', at, model: 'SIMULATED_ONLY', raw: '{"raw":"unchanged"}', accepted: true }];
  const before = structuredClone(value);
  const serialized = JSON.stringify(value);
  const report = buildInterviewResultExplanation(freeze(value));
  const plain = formatInterviewResultExplanation(report);
  assert.deepEqual(value, before);
  assert.equal(JSON.stringify(value), serialized);
  assert.equal(typeof plain, 'string');
  assert.match(plain, /^问诊考核结果说明（形成性）\n/);
  assert.ok(plain.includes(`原文[learner-1]：“${quote}”`));
  assert.match(plain, /改进目标：/);
  assert.match(plain, /练习问法（非本次原文）：/);
  assert.match(plain, /完成标志：/);
  assert.match(plain, /教师整体意见：保留原始评分和历史意见。/);
  assert.doesNotMatch(plain, /<section|<div|```|\[object Object\]/);
});

test('research export adds derived JSON and text explanations without rewriting backup or original AI assessment cells', () => {
  const source = session([
    item('process.opening', 2), item('process.closure', 1), item('process.patient_perspective', null),
  ]);
  source.review = {
    reviewer: 'SIMULATED_ONLY-teacher', notes: '第一项未计分；第二项教师复核为充分实现。', at,
    corrections: [
      { criterionId: 'process.opening', score: null, reason: '教师认为记录不足，暂不判断。' },
      { criterionId: 'process.closure', score: 2, reason: '教师结合录音认为已完成。' },
    ],
  };
  source.feedbackAttempts = [{ id: 'original', at, model: 'SIMULATED_ONLY', raw: '{"retain":"raw"}', accepted: true }];
  const unfinished = session([], { id: 'SIMULATED_ONLY-unfinished' }); delete unfinished.feedback;
  const backup = { schemaVersion: '0.2', exportedAt: at, simulatedCases: true,
    studies: [], participants: [], sessions: [source, unfinished], drafts: { [unfinished.id]: {
      history: 'SIMULATED_ONLY尚未提交', reasoning: '', plan: '', uncertainty: '',
    } } };
  const before = structuredClone(backup);
  const originalJson = JSON.stringify(backup, null, 2);
  const files: { path: string; content: string }[] = researchFiles(freeze(backup), false);
  const content = (path: string) => {
    const file = files.find(value => value.path === path);
    assert.ok(file, `missing export file ${path}`);
    return file.content;
  };
  assert.equal(content('backup.json'), originalJson);
  assert.deepEqual(JSON.parse(content('backup.json')), before);
  assert.deepEqual(backup, before);

  const rows = csvObjects(content('assessments.csv'));
  assert.deepEqual(rows.map(row => [row.criterion_id, row.score, row.grading_origin]), [
    ['process.opening', '2', 'original_model_preassessment'],
    ['process.closure', '1', 'original_model_preassessment'],
    ['process.patient_perspective', '', 'original_model_preassessment'],
  ]);
  const exported = JSON.parse(content('interview-result-explanations.json'));
  assert.equal(exported.length, 1, 'a pending record has no invented feedback explanation');
  assert.equal(exported[0].sessionId, source.id);
  assert.equal(exported[0].improvements.length, 0);
  assert.equal(exported[0].practicePlan.length, 0);
  assert.deepEqual(exported[0].unresolved.map((value: { criterionId: string }) => value.criterionId),
    ['process.opening', 'process.patient_perspective']);
  assert.equal(exported[0].strengths[0].origin, 'teacher');
  assert.equal(exported[0].strengths[0].originalScore, 1);
  assert.equal(exported[0].strengths[0].score, 2);
  assert.equal(content(`result-explanations/${source.id}.txt`), formatInterviewResultExplanation(buildInterviewResultExplanation(source)));
  assert.equal(files.some(value => value.path === `result-explanations/${unfinished.id}.txt`), false);
  const manifest = JSON.parse(content('manifest.json'));
  assert.equal(manifest.resultExplanations.derived, true);
  assert.match(manifest.resultExplanations.restoration, /backup.json/);
  assert.match(content('README.txt'), /不重新评分、不覆盖原始结果/);
  assert.equal(new Set(files.map(value => value.path)).size, files.length);
});

test('exported explanation JSON can be formatted again without duplicating priority items', () => {
  const source = session([item('process.opening'), item('process.closure'), item('case.ruq-01.timeline'), item('process.identity')]);
  const report = buildInterviewResultExplanation(source);
  assert.equal(formatInterviewResultExplanation(JSON.parse(JSON.stringify(report))), formatInterviewResultExplanation(report));
});
