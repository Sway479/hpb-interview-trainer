import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SessionStore } from '../packages/core/src/store.ts';
import { getCase, listCases, patientInstructions } from '../packages/core/src/cases.ts';
import type { LearnerSummary, Session, Turn } from '../packages/core/src/types.ts';
import { feedbackPrompt, validateFeedback } from '../server/feedback.ts';
import { getAssessmentCriteria } from '../packages/core/src/assessment.ts';

const summary: LearnerSummary = {
  history: '患者自述右上腹疼痛一天，需要继续核实时间与伴随症状。',
  reasoning: '现有问诊不足以确定病因。', plan: '继续核对症状和既往病史。', uncertainty: '尚无检查及生命体征。',
};
function fixture(t: TestContext) {
  const root = resolve('.cache', 'tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'core-'));
  t.after(() => { assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  const store = new SessionStore(directory);
  const session = store.create(listCases()[0].id);
  return { store, session, directory };
}
function turn(id: string, overrides: Partial<Turn> = {}): Turn {
  return { id, role: 'learner', text: '您是什么时候开始疼的？', at: new Date().toISOString(), source: 'typed', final: true, ...overrides };
}
function generatedFeedback(session: Session, quote = '您是什么时候开始疼的？') {
  return JSON.stringify({ overview: '学员未系统采集病史，遗漏了所有信息。',
    items: getAssessmentCriteria(getCase(session.caseId)).map(criterion => ({ criterionId: criterion.id, label: '不可信的模型标签',
      status: 'observed', score: 2, comment: '模型判断，待复核。', evidence: [{ turnId: 'learner-1', quote }],
      notScoredReason: null, zeroEvidence: null })),
    nextPractice: ['补上你没有问到的所有问题。'],
  });
}

test('the patient continuation prompt excludes unconfirmed, interrupted and unverified history', () => {
  const history = [
    turn('confirmed-learner', { text: '可靠的已确认医生问句。', source: 'asr' }),
    turn('confirmed-patient', { text: '可靠的已核对患者回答。', role: 'patient', source: 'model', verification: 'matches_flash' }),
    turn('partial', { text: '尚未确认的转录不应延续。', final: false, source: 'asr' }),
    turn('interrupted', { text: '已经打断的患者句子不应延续。', role: 'patient', source: 'model', interrupted: true }),
    turn('unverified', { text: '与Flash不符的患者句子不应延续。', role: 'patient', source: 'model', verification: 'paraphrase_unverified' }),
  ];
  const prompt = patientInstructions(getCase('ruq-01'), history);
  assert.ok(prompt.includes(history[0].text)); assert.ok(prompt.includes(history[1].text));
  for (const excluded of history.slice(2)) assert.ok(!prompt.includes(excluded.text), excluded.id);
  assert.ok(!patientInstructions(getCase('ruq-01'), history.slice(2)).includes('你已发生的对话记录如下'));
  assert.equal(history.length, 5); assert.equal(history[3].interrupted, true);
});

test('feedback is unavailable until a completed interview and submitted independent summary', t => {
  const { store, session } = fixture(t);
  assert.equal(store.get(session.id).feedback, undefined);
  assert.throws(() => store.beginFeedback(session.id, summary), /请先结束/);
  assert.throws(() => feedbackPrompt(getCase(session.caseId), session), /独立总结未提交/);
  assert.throws(() => validateFeedback(generatedFeedback(session), getCase(session.caseId), session, 'test'), /提交独立总结/);
  store.addTurn(session.id, turn('learner-1'));
  const ended = store.end(session.id);
  assert.equal(store.end(session.id).endedAt, ended.endedAt);
  assert.equal(store.get(session.id).feedback, undefined);
  const pending = store.beginFeedback(session.id, summary);
  assert.equal(pending.feedback, undefined);
  assert.throws(() => store.beginFeedback(session.id, summary), /重复提交/);
  const feedback = validateFeedback(generatedFeedback(pending), getCase(session.caseId), pending, 'test');
  store.completeFeedback(session.id, feedback);
  assert.throws(() => store.failFeedback(session.id, '迟到的失败回调'), /反馈状态已改变/);
  assert.equal(store.get(session.id).status, 'feedback_ready');
});

test('fabricated, incomplete, interrupted, or patient-only citations cannot become observed findings', t => {
  const { store, session } = fixture(t);
  store.addTurn(session.id, turn('learner-1', { final: false, source: 'asr' }));
  store.addTurn(session.id, turn('patient-1', { role: 'patient', source: 'model', text: '昨天开始疼的。' }));
  store.end(session.id);
  const pending = store.beginFeedback(session.id, summary);
  const definition = getCase(session.caseId);
  for (const testCase of [
    { turnId: 'learner-1', quote: '您是什么时候开始疼的？' },
    { turnId: 'missing', quote: '不存在的引文' },
    { turnId: 'patient-1', quote: '昨天开始疼的。' },
  ]) {
    const payload = JSON.parse(generatedFeedback(pending));
    payload.items.forEach((item: any) => { item.evidence = [testCase]; item.comment = '学员未询问症状。'; });
    const feedback = validateFeedback(JSON.stringify(payload), definition, pending, 'test');
    assert.ok(feedback.items.every(item => item.status === 'insufficient_evidence'));
    assert.ok(feedback.items.every(item => item.comment.startsWith('当前记录不足以判断')));
    assert.ok(feedback.items.every((item, i) => item.label === getAssessmentCriteria(definition)[i].label && item.score === null));
    assert.ok(!feedback.overview.includes('学员未系统采集'));
    assert.ok(feedback.overview.includes('0条为完整记录'));
    assert.ok(feedback.nextPractice.every(item => item.startsWith('下一轮可练习')));
    assert.ok(!feedback.nextPractice.some(item => item.includes('你没有问到')));
  }
  const interrupted: Session = { ...pending, turns: [turn('learner-1', { interrupted: true })] };
  assert.ok(validateFeedback(generatedFeedback(interrupted), definition, interrupted, 'test').items
    .every(item => item.status === 'insufficient_evidence'));
});

test('insufficient evidence prose remains conservative even when its quote is valid', t => {
  const { store, session } = fixture(t);
  store.addTurn(session.id, turn('learner-1')); store.end(session.id);
  const pending = store.beginFeedback(session.id, summary);
  const payload = JSON.parse(generatedFeedback(pending));
  payload.items.forEach((item: any) => { item.status = 'insufficient_evidence'; item.score = null; item.notScoredReason = 'insufficient_evidence'; item.comment = '学员未采集任何信息。'; });
  const result = validateFeedback(JSON.stringify(payload), getCase(session.caseId), pending, 'test');
  assert.ok(result.items.every(item => item.comment.startsWith('当前记录不足以判断')));
  assert.ok(result.overview.includes('1条为完整记录'));
  assert.ok(!result.overview.includes('遗漏了所有信息'));
});

test('a pending feedback job is durably reset after restart and can be retried', t => {
  const { store, session, directory } = fixture(t);
  store.addTurn(session.id, turn('learner-1')); store.end(session.id); store.beginFeedback(session.id, summary);
  const restarted = new SessionStore(directory);
  const recovered = restarted.get(session.id);
  assert.equal(recovered.status, 'summary'); assert.deepEqual(recovered.summary, summary);
  assert.match(recovered.feedbackError ?? '', /上次反馈生成中断/);
  assert.equal(recovered.feedback, undefined);
  const persisted = JSON.parse(readFileSync(join(directory, `${session.id}.json`), 'utf8'));
  assert.equal(persisted.status, 'summary');
  assert.equal(new SessionStore(directory).get(session.id).status, 'summary');
  assert.equal(restarted.beginFeedback(session.id, summary).status, 'feedback_pending');
});

test('a failed disk write does not publish an unsaved in-memory turn', t => {
  const { store, session, directory } = fixture(t);
  mkdirSync(join(directory, `${session.id}.json.tmp`));
  assert.throws(() => store.addTurn(session.id, turn('learner-1')));
  assert.deepEqual(store.get(session.id).turns, []);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, `${session.id}.json`), 'utf8')).turns, []);
});
