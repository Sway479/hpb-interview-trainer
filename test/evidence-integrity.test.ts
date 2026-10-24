import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceResolver } from '../packages/core/src/evidence.ts';
import { getAssessmentCriteria, getAssessmentMetadata } from '../packages/core/src/assessment.ts';
import { getCase } from '../packages/core/src/cases.ts';
import { validateFeedback } from '../packages/core/src/feedback.ts';
import { buildInterviewResultExplanation, formatInterviewResultExplanation } from '../packages/core/src/result-explanation.ts';
import type { Session, Turn } from '../packages/core/src/types.ts';

const definition = getCase('ruq-01'), criteria = getAssessmentCriteria(definition);
const at = '2026-10-23T00:00:00.000Z', feedbackAt = '2026-10-23T00:10:00.000Z';
const quote = '您好，我是住院医师，请问您怎么称呼，现在可以开始吗？';
const learner = (id = 'learner-1', overrides: Partial<Turn> = {}): Turn => ({
  id, role: 'learner', text: quote, at, source: 'typed', final: true, ...overrides,
});
function source(turns = [learner()]): Session {
  return { id: 'SIMULATED_ONLY-evidence-integrity', caseId: definition.id, caseTitle: definition.title,
    caseVersion: definition.version, createdAt: at, status: 'feedback_pending', turns,
    summary: { history: 'SIMULATED_ONLY：虚构病例原文核对。', reasoning: '尚待核实。', plan: '继续核实。', uncertainty: '尚不明确。' } };
}
function grade(session: Session, reference = { turnId: 'learner-1', quote }) {
  const payload = { items: criteria.map(item => ({ criterionId: item.id, score: 2, status: 'observed',
    comment: '合成结构测试原评，语义仍需教师核对。', evidence: [reference] })) };
  return validateFeedback(JSON.stringify(payload), definition, session, 'SIMULATED_ONLY-no-api');
}

test('exact, unique and complete source is consistently usable without mutating the original', () => {
  const turns = [Object.freeze(learner())], before = JSON.stringify(turns);
  const resolved = createEvidenceResolver(Object.freeze(turns)).resolve({ turnId: 'learner-1', quote });
  assert.equal(resolved.turn, turns[0]); assert.equal(resolved.reliable, true); assert.equal(resolved.canNavigate, true);
  assert.equal(resolved.issue, undefined); assert.equal(JSON.stringify(turns), before);
});

for (const identical of [true, false]) {
  test(`duplicate turn IDs are never resolved or scored, including ${identical ? 'identical' : 'conflicting'} text`, () => {
    for (const reverse of [false, true]) {
      const turns = [learner(), learner('learner-1', { text: identical ? quote : '另一个不能相互替代的句子。' })];
      if (reverse) turns.reverse();
      const resolver = createEvidenceResolver(turns), reference = { turnId: 'learner-1', quote };
      assert.equal(resolver.uniqueTurn(reference.turnId), undefined);
      assert.deepEqual(resolver.resolve(reference), { reliable: false, canNavigate: false, issue: 'duplicate_turn_id' });
      const value = source(turns), before = JSON.stringify(value), feedback = grade(value);
      assert.ok(feedback.items.every(item => item.score === null && item.evidence.length === 0));
      assert.match(feedback.overview, /其中0条为完整记录/);
      assert.equal(JSON.stringify(value), before, 'new validation cannot rewrite the original record');
      value.feedback = { ...feedback, createdAt: feedbackAt, items: criteria.map(item => ({
        criterionId: item.id, label: item.label, status: 'observed', score: 2, comment: '历史原评保留。', evidence: [reference],
      })) };
      const report = buildInterviewResultExplanation(value);
      assert.equal(report.reliableLearnerTurns, 0); assert.equal(report.strengths.length, 0);
      assert.equal(report.improvements.length, 0); assert.equal(report.unresolved.length, criteria.length);
      assert.equal(value.feedback.items[0].score, 2, 'read-only explanation retains the historical AI score');
    }
  });
}

test('empty quotes cannot be treated as exact matches or provide an original-text jump', () => {
  const resolver = createEvidenceResolver([learner()]);
  for (const empty of ['', '   ', '\n\t']) {
    const resolved = resolver.resolve({ turnId: 'learner-1', quote: empty });
    assert.equal(resolved.reliable, false); assert.equal(resolved.canNavigate, false); assert.equal(resolved.issue, 'empty_quote');
  }
  assert.ok(grade(source(), { turnId: 'learner-1', quote: '   ' }).items.every(item => item.score === null));
});

test('uniquely located but unreliable sources remain reviewable while excluded from behavior evidence', () => {
  for (const candidate of [
    { turn: learner('learner-1', { final: false }), issue: 'incomplete_turn' },
    { turn: learner('learner-1', { interrupted: true }), issue: 'interrupted_turn' },
    { turn: learner('learner-1', { verification: 'paraphrase_unverified' }), issue: 'unverified_turn' },
    { turn: learner('learner-1', { text: '这是另一句。' }), issue: 'quote_mismatch' },
  ]) {
    const resolved = createEvidenceResolver([candidate.turn]).resolve({ turnId: 'learner-1', quote });
    assert.equal(resolved.reliable, false); assert.equal(resolved.canNavigate, true); assert.equal(resolved.issue, candidate.issue);
    assert.ok(grade(source([candidate.turn])).items.every(item => item.score === null));
  }
  assert.deepEqual(createEvidenceResolver([]).resolve({ turnId: 'missing', quote }),
    { reliable: false, canNavigate: false, issue: 'missing_turn' });
});

test('ambiguous zero-score citation cannot be rescued by another unique learner quote', () => {
  const value = source([learner(), learner(), learner('unique')]);
  const payload = { items: criteria.map(item => ({ criterionId: item.id, score: 0, status: 'to_improve',
    comment: '合成记录中的明确不当行为。', evidence: [{ turnId: 'unique', quote }],
    zeroEvidence: { turnId: 'learner-1', quote, problem: '合成不当行为依据。' } })) };
  const feedback = validateFeedback(JSON.stringify(payload), definition, value, 'SIMULATED_ONLY-no-api');
  assert.ok(feedback.items.every(item => item.score === null && item.zeroEvidence === undefined));
});

test('derived report carries exact existing feedback, frozen versions and review revision without new timestamps', () => {
  const value = source(); value.feedback = { ...grade(value), createdAt: feedbackAt };
  value.runtime = { appVersion: 'SIMULATED_ONLY-app', engineVersion: 'SIMULATED_ONLY-engine',
    patientPromptVersion: 'SIMULATED_ONLY-patient', feedbackPromptVersion: 'SIMULATED_ONLY-feedback',
    assessmentId: getAssessmentMetadata().id, assessmentVersion: getAssessmentMetadata().version,
    text: { profileId: 'stub', company: 'custom', endpoint: 'https://example.invalid', model: 'SIMULATED_ONLY-model' } };
  value.reviewHistory = [{ reviewer: 'SIMULATED_ONLY-first', notes: '第一次复核。', at }];
  value.review = { reviewer: 'SIMULATED_ONLY-second', notes: '第二次复核。', at: feedbackAt };
  const before = JSON.stringify(value), report = buildInterviewResultExplanation(value);
  assert.equal(report.feedbackCreatedAt, feedbackAt); assert.equal(report.assessmentId, getAssessmentMetadata().id);
  assert.equal(report.reviewRevision, 2);
  assert.deepEqual(report.runtimeVersions, { appVersion: value.runtime.appVersion, engineVersion: value.runtime.engineVersion,
    patientPromptVersion: value.runtime.patientPromptVersion, feedbackPromptVersion: value.runtime.feedbackPromptVersion });
  const plain = formatInterviewResultExplanation(report);
  assert.match(plain, /原反馈生成时间：2026-10-23T00:10:00\.000Z/);
  assert.match(plain, /原量规ID：hpb-voice-formative-assessment/);
  assert.match(plain, /反馈提示词 SIMULATED_ONLY-feedback/); assert.match(plain, /本机教师复核：第2版/);
  assert.match(plain, /时间来自设备时钟/); assert.match(plain, /不是当前查看时间/);
  assert.equal(JSON.stringify(value), before);
  assert.deepEqual(buildInterviewResultExplanation(value), report, 'same source produces the same derived report');
});

test('legacy provenance stays missing instead of being filled with current versions', () => {
  const value = source(); value.feedback = grade(value); delete value.feedback.assessment;
  const report = buildInterviewResultExplanation(value);
  assert.equal(report.runtimeVersions, undefined); assert.equal(report.assessmentId, undefined);
  const plain = formatInterviewResultExplanation(report);
  assert.match(plain, /原量规ID：旧版未记录/); assert.match(plain, /App 旧版未记录/);
  assert.match(plain, /反馈提示词 旧版未记录/); assert.equal(report.reviewRevision, undefined);
  const pending = source(); assert.match(formatInterviewResultExplanation(buildInterviewResultExplanation(pending)), /原反馈生成时间：尚未生成/);
});
