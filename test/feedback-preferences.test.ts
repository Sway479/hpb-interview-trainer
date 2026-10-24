import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getCase } from '../packages/core/src/cases.ts';
import { getAssessmentCriteria } from '../packages/core/src/assessment.ts';
import type { LearnerSummary, Session, TeacherCorrection } from '../packages/core/src/types.ts';
import type { ConnectionSettings } from '../apps/mobile/src/platform/contracts.ts';
import type { DocumentStorage } from '../apps/mobile/src/platform/storage.ts';

const { loadFeedbackPreferences, saveFeedbackPreferences, FEEDBACK_PREFERENCES_PATH, DEFAULT_FEEDBACK_PREFERENCES } =
  await import(new URL('../apps/mobile/src/platform/feedback-preferences.ts', import.meta.url).href);
const { LocalRepository } = await import(new URL('../apps/mobile/src/platform/repository.ts', import.meta.url).href);
const { LocalService } = await import(new URL('../apps/mobile/src/platform/local-service.ts', import.meta.url).href);

class MemoryStorage implements DocumentStorage {
  files = new Map<string, string>(); writes: string[] = []; failRead = false; failWrite = false;
  async read(path: string) { if (this.failRead) throw new Error('injected read failure'); return this.files.get(path) ?? null; }
  async write(path: string, data: string) { if (this.failWrite) throw new Error('injected write failure'); this.files.set(path, data); this.writes.push(path); }
  async list(path: string) { return [...this.files.keys()].filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')); }
  async remove(path: string) { this.files.delete(path); }
}
const definition = getCase('ruq-01'), at = '2026-10-23T00:00:00.000Z';
const spoken = '您好，我是住院医师，请问您怎么称呼？';
const summary: LearnerSummary = { history: '患者自述腹痛，时间及相关病史仍需继续核实。', reasoning: '当前病因未确定。', plan: '继续核实症状与既往史。', uncertainty: '体征及检查未知。' };
const settings: ConnectionSettings = { mode: 'standalone', textProfileId: 'test-profile', voiceProfileId: '', profiles: [
  { id: 'test-profile', name: 'SIMULATED_ONLY', company: 'qwen', chatUrl: 'https://example.invalid/v1/chat/completions', chatModel: 'stub-only', realtimeProtocol: 'none', realtimeUrl: '', realtimeModel: '', voice: '' },
] };
function feedbackText() {
  return JSON.stringify({ items: getAssessmentCriteria(definition).map(item => ({ criterionId: item.id, score: null,
    status: 'insufficient_evidence', comment: '隔离测试，证据需人工核对。', evidence: [], notScoredReason: 'insufficient_evidence', zeroEvidence: null })) });
}
function fixture(storage = new MemoryStorage()) {
  const repository = new LocalRepository(storage), requests: { input: string; instructions: string }[] = [];
  let handler = async () => ({ text: feedbackText(), model: 'stub-only', elapsedMs: 1 });
  const service = new LocalService({ storage, repository,
    credentials: async (ids: string[]) => Object.fromEntries(ids.map(id => [id, { hasKey: true }])),
    audio: { append: async () => {}, blob: async () => new Blob() },
    chat: async (_profile: unknown, instructions: string, input: string) => { requests.push({ input, instructions }); return handler(); },
  });
  return { storage, repository, service, requests, setChat(next: typeof handler) { handler = next; } };
}
async function ended(f: ReturnType<typeof fixture>, mode: 'automatic' | 'manual' = 'manual'): Promise<Session> {
  const session = await f.service.start(settings, definition.id, undefined, mode);
  await f.service.addTurn(session.id, { id: 'intro', at, role: 'learner', source: 'typed', final: true, text: spoken });
  return f.service.commitEnd(session.id);
}

test('new preference defaults are practice automatic/research manual and do not mutate storage or shared defaults', async () => {
  const storage = new MemoryStorage();
  const result = await loadFeedbackPreferences(storage);
  assert.deepEqual(result, { preferences: { version: 1, practice: 'automatic', research: 'manual' } });
  result.preferences.research = 'automatic';
  assert.equal((await loadFeedbackPreferences(storage)).preferences.research, 'manual');
  assert.equal(DEFAULT_FEEDBACK_PREFERENCES.research, 'manual');
  assert.deepEqual(storage.writes, []);
});

test('preferences reload independently and reject unknown fields without touching historical records', async () => {
  const storage = new MemoryStorage(), path = `sessions/${randomUUID()}.json`, original = '{"historical":"原样保留"}';
  storage.files.set(path, original);
  const saved = await saveFeedbackPreferences({ version: 1, practice: 'manual', research: 'automatic' }, storage);
  saved.practice = 'automatic';
  assert.deepEqual((await loadFeedbackPreferences(storage)).preferences, { version: 1, practice: 'manual', research: 'automatic' });
  await assert.rejects(saveFeedbackPreferences({ version: 1, practice: 'manual', research: 'manual', extra: true }, storage), /格式无效/);
  assert.equal(storage.files.get(path), original);
  assert.deepEqual(storage.writes, [FEEDBACK_PREFERENCES_PATH]);
  assert.deepEqual(Object.keys(JSON.parse(storage.files.get(FEEDBACK_PREFERENCES_PATH)!)).sort(), ['practice', 'research', 'version']);
});

test('corrupt, unsupported and unreadable preferences never silently enable automatic generation or replace the source', async () => {
  const storage = new MemoryStorage();
  for (const raw of ['{broken', 'null', '{"version":2,"practice":"automatic","research":"automatic"}', '{"version":1,"practice":"automatic"}', '{"version":1,"practice":"unknown","research":"manual"}']) {
    storage.files.set(FEEDBACK_PREFERENCES_PATH, raw);
    const result = await loadFeedbackPreferences(storage);
    assert.deepEqual(result.preferences, { version: 1, practice: 'manual', research: 'manual' });
    assert.ok(result.warning); assert.equal(storage.files.get(FEEDBACK_PREFERENCES_PATH), raw);
  }
  storage.failRead = true;
  assert.deepEqual((await loadFeedbackPreferences(storage)).preferences, { version: 1, practice: 'manual', research: 'manual' });
  assert.match((await loadFeedbackPreferences(storage)).warning!, /读取失败/);
  assert.equal(storage.writes.length, 0);
});

test('a failed preference save rejects and keeps the last confirmed choice; ordered rapid saves can recover', async () => {
  const storage = new MemoryStorage();
  await saveFeedbackPreferences({ version: 1, practice: 'manual', research: 'manual' }, storage);
  storage.failWrite = true;
  await assert.rejects(saveFeedbackPreferences({ version: 1, practice: 'automatic', research: 'automatic' }, storage), /尚未保存/);
  storage.failWrite = false;
  assert.equal((await loadFeedbackPreferences(storage)).preferences.practice, 'manual');
  await Promise.all([
    saveFeedbackPreferences({ version: 1, practice: 'automatic', research: 'manual' }, storage),
    saveFeedbackPreferences({ version: 1, practice: 'manual', research: 'automatic' }, storage),
  ]);
  assert.deepEqual((await loadFeedbackPreferences(storage)).preferences, { version: 1, practice: 'manual', research: 'automatic' });
});

test('a new session freezes the selected generation mode; changing preferences neither rewrites sessions nor exports device preferences', async () => {
  const f = fixture();
  await saveFeedbackPreferences({ version: 1, practice: 'manual', research: 'manual' }, f.storage);
  const selected = (await loadFeedbackPreferences(f.storage)).preferences;
  const first: Session = await f.service.start(settings, definition.id, undefined, selected.practice);
  const path = `sessions/${first.id}.json`, bytes = f.storage.files.get(path);
  await saveFeedbackPreferences({ version: 1, practice: 'automatic', research: 'automatic' }, f.storage);
  const second: Session = await f.service.start(settings, definition.id, undefined, (await loadFeedbackPreferences(f.storage)).preferences.practice);
  assert.equal(first.runtime?.feedbackGeneration, 'manual'); assert.equal(second.runtime?.feedbackGeneration, 'automatic');
  assert.equal(f.storage.files.get(path), bytes); assert.equal((await f.service.get(first.id)).runtime?.feedbackGeneration, 'manual');
  const backup = await f.repository.backup(), destination = fixture();
  await destination.repository.importBackup(JSON.stringify(backup));
  assert.equal((await destination.service.get(first.id)).runtime?.feedbackGeneration, 'manual');
  assert.equal(destination.storage.files.has(FEEDBACK_PREFERENCES_PATH), false);
  const legacy = structuredClone(backup); delete legacy.sessions[0].runtime.feedbackGeneration;
  const legacyTarget = fixture(); await legacyTarget.repository.importBackup(JSON.stringify(legacy));
  const legacyId = legacy.sessions[0].id, legacyPath = `sessions/${legacyId}.json`, oldBytes = legacyTarget.storage.files.get(legacyPath);
  assert.equal((await new LocalRepository(legacyTarget.storage).get(legacyId)).runtime?.feedbackGeneration, undefined);
  assert.equal(legacyTarget.storage.files.get(legacyPath), oldBytes, 'reading a legacy snapshot must not backfill the new optional property');
  assert.equal(f.requests.length + destination.requests.length + legacyTarget.requests.length, 0);
});

test('manual submission locks and durably saves a summary with zero model calls, then explicit generation uses it once', async () => {
  const f = fixture(), session = await ended(f);
  const saved: Session = await f.service.summary(settings, session.id, summary, { generateFeedback: false });
  assert.equal(saved.status, 'summary'); assert.deepEqual(saved.summary, summary); assert.equal(saved.feedback, undefined);
  assert.equal(f.requests.length, 0); assert.equal(saved.auditEvents?.find(item => item.type === 'summary_submitted')?.reason, 'feedback_deferred');
  const restarted = fixture(f.storage);
  assert.deepEqual((await restarted.service.get(session.id)).summary, summary);
  const bytes = f.storage.files.get(`sessions/${session.id}.json`);
  await assert.rejects(restarted.service.summary(settings, session.id, { ...summary, history: '这是一份事后改变且不应覆盖已提交记录的总结。' }, { generateFeedback: true }), /已提交并锁定/);
  assert.equal(f.storage.files.get(`sessions/${session.id}.json`), bytes); assert.equal(restarted.requests.length, 0);
  const generated: Session = await restarted.service.summary(settings, session.id, summary, { generateFeedback: true });
  assert.equal(generated.status, 'feedback_ready'); assert.equal(restarted.requests.length, 1);
  assert.ok(restarted.requests[0].input.includes(summary.history));
  assert.equal(generated.auditEvents?.find(item => item.type === 'feedback_generation_requested')?.reason, 'manual');
  const originalBytes = f.storage.files.get(`sessions/${session.id}.json`), originalFeedback = structuredClone(generated.feedback);
  assert.deepEqual((await restarted.service.summary(settings, session.id, summary, { generateFeedback: true })).feedback, originalFeedback);
  assert.equal(restarted.requests.length, 1); assert.equal(f.storage.files.get(`sessions/${session.id}.json`), originalBytes);
});

test('zero reliable learner transcript still permits a locked manual summary but never an assessment request', async () => {
  for (const transcript of ['empty', 'unverified', 'interrupted', 'partial'] as const) {
    const f = fixture(), started: Session = await f.service.start(settings, definition.id, undefined, 'manual');
    if (transcript !== 'empty') await f.service.addTurn(started.id, { id: 'not-reliable', at, role: 'learner', source: 'asr', text: spoken,
      final: transcript !== 'partial', ...(transcript === 'unverified' ? { verification: 'paraphrase_unverified' } : {}), ...(transcript === 'interrupted' ? { interrupted: true } : {}) });
    await f.service.commitEnd(started.id);
    const saved: Session = await f.service.summary(settings, started.id, summary, { generateFeedback: false });
    assert.equal(saved.status, 'summary', transcript); assert.deepEqual(saved.summary, summary); assert.equal(saved.feedback, undefined);
    assert.equal(f.requests.length, 0);
    const path = `sessions/${started.id}.json`, bytes = f.storage.files.get(path);
    const restarted = fixture(f.storage);
    await assert.rejects(restarted.service.summary(settings, started.id, summary, { generateFeedback: true }), /没有可靠的学员问诊记录/);
    assert.equal(restarted.requests.length, 0); assert.equal(f.storage.files.get(path), bytes);
    const retained: Session = await restarted.service.get(started.id);
    assert.deepEqual(retained.summary, summary); assert.equal(retained.status, 'summary'); assert.equal(retained.feedback, undefined);
    assert.equal(retained.auditEvents?.some(event => event.type === 'feedback_generation_requested'), false);
  }
});

test('all duplicated learner IDs permit only locked manual saving and never a model request, including after restart', async () => {
  for (const sameText of [true, false]) {
    const f = fixture(), session = await ended(f);
    await f.repository.mutate(session.id, (value: Session) => {
      value.turns = [
        { id: 'SIMULATED_ONLY-ambiguous', at, role: 'learner', source: 'typed', final: true, text: spoken },
        { id: 'SIMULATED_ONLY-ambiguous', at, role: 'learner', source: 'typed', final: true, text: sameText ? spoken : '这是另一个不能相互替代的学员发言。' },
      ];
    });
    const path = `sessions/${session.id}.json`, before = f.storage.files.get(path);
    await assert.rejects(f.service.summary(settings, session.id, summary, { generateFeedback: true }), /没有可靠的学员问诊记录/);
    assert.equal(f.requests.length, 0); assert.equal(f.storage.files.get(path), before);
    assert.equal((await f.service.get(session.id)).summary, undefined);

    const saved: Session = await f.service.summary(settings, session.id, summary, { generateFeedback: false });
    assert.equal(saved.status, 'summary'); assert.deepEqual(saved.summary, summary); assert.equal(saved.feedback, undefined);
    assert.equal(saved.auditEvents?.find(event => event.type === 'summary_submitted')?.reason, 'feedback_deferred');
    const lockedBytes = f.storage.files.get(path), restarted = fixture(f.storage);
    await assert.rejects(restarted.service.summary(settings, session.id, summary, { generateFeedback: true }), /没有可靠的学员问诊记录/);
    await assert.rejects(restarted.service.summary(settings, session.id, { ...summary, plan: '不应改变已锁定的总结。' }, { generateFeedback: false }), /已提交并锁定/);
    assert.equal(restarted.requests.length, 0); assert.equal(f.storage.files.get(path), lockedBytes);
    const retained: Session = await restarted.service.get(session.id);
    assert.deepEqual(retained.summary, summary); assert.deepEqual(retained.turns, saved.turns);
    assert.equal(retained.auditEvents?.some(event => event.type === 'feedback_generation_requested'), false);
  }
});

test('legacy automatic submission and retry keep the original summary and audit each trigger without overwriting raw attempts', async () => {
  const f = fixture(), session = await ended(f, 'automatic');
  f.setChat(async () => ({ text: 'invalid fixture response', model: 'stub-only', elapsedMs: 1 }));
  await assert.rejects(f.service.summary(settings, session.id, summary), /总结已保存/);
  const failed: Session = await f.service.get(session.id);
  assert.equal(failed.status, 'summary'); assert.deepEqual(failed.summary, summary);
  assert.equal(failed.auditEvents?.find(item => item.type === 'feedback_generation_requested')?.reason, 'automatic');
  await assert.rejects(f.service.summary(settings, session.id, { ...summary, plan: '替换总结以提高反馈分数。' }), /已提交并锁定/);
  assert.equal(f.requests.length, 1);
  f.setChat(async () => ({ text: feedbackText(), model: 'stub-only', elapsedMs: 1 }));
  const generated: Session = await f.service.summary(settings, session.id, summary, { generateFeedback: true });
  assert.equal(f.requests.length, 2); assert.deepEqual(generated.summary, summary);
  assert.deepEqual(generated.feedbackAttempts?.map(item => item.accepted), [false, true]);
  assert.equal(generated.feedbackAttempts?.[0].raw, 'invalid fixture response');
  assert.deepEqual(generated.auditEvents?.filter(item => item.type === 'feedback_generation_requested').map(item => item.reason), ['automatic', 'manual_retry']);
});

test('a historical unknown case recovers from each generation failure without leaving feedback pending or requesting a model', async () => {
  const f = fixture(), id = randomUUID();
  const historical: Session = { id, caseId: 'historical-removed-case', caseVersion: 'old-test', caseTitle: 'SIMULATED_ONLY',
    createdAt: at, endedAt: at, status: 'summary', turns: [{ id: 'intro', at, role: 'learner', source: 'typed', final: true, text: spoken }] };
  await f.repository.create(historical);
  await f.service.summary(settings, id, summary, { generateFeedback: false });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.service.summary(settings, id, summary, { generateFeedback: true }), /总结已保存.*病例不存在/);
    const recovered: Session = await f.service.get(id);
    assert.equal(recovered.status, 'summary'); assert.deepEqual(recovered.summary, summary); assert.deepEqual(recovered.turns, historical.turns);
    assert.equal(recovered.runtime, undefined, 'do not backfill an old runtime snapshot during failure recovery');
    assert.equal(recovered.feedback, undefined); assert.equal(recovered.modelCalls, undefined); assert.equal(f.requests.length, 0);
    assert.match(recovered.feedbackError!, /病例不存在/);
  }
  const retained: Session = await new LocalRepository(f.storage).get(id);
  assert.equal(retained.status, 'summary'); assert.deepEqual(retained.summary, summary);
  assert.deepEqual(retained.auditEvents?.filter(event => event.type === 'feedback_generation_requested').map(event => event.reason), ['manual', 'manual_retry']);
});

test('generation requested while a manual summary save is pending waits for the durable save and then generates', async () => {
  const f = fixture(), session = await ended(f);
  const saved = f.service.summary(settings, session.id, summary, { generateFeedback: false });
  const generated = f.service.summary(settings, session.id, summary, { generateFeedback: true });
  const [first, second]: Session[] = await Promise.all([saved, generated]);
  assert.equal(first.status, 'summary'); assert.equal(second.status, 'feedback_ready');
  assert.equal(f.requests.length, 1); assert.deepEqual(second.summary, summary);
});

test('a failed initial summary write makes no model request and publishes no locked summary', async () => {
  const f = fixture(), session = await ended(f), path = `sessions/${session.id}.json`, bytes = f.storage.files.get(path);
  f.storage.failWrite = true;
  await assert.rejects(f.service.summary(settings, session.id, summary), /write failure/);
  assert.equal(f.requests.length, 0); assert.equal((await f.service.get(session.id)).summary, undefined);
  assert.equal(f.storage.files.get(path), bytes);
  f.storage.failWrite = false;
  assert.equal((await f.service.summary(settings, session.id, summary, { generateFeedback: false })).status, 'summary');
  assert.equal(f.requests.length, 0);
});

test('concurrent generation requests coalesce only for the same locked summary', async () => {
  const f = fixture(), session = await ended(f); let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  f.setChat(async () => { await ready; return { text: feedbackText(), model: 'stub-only', elapsedMs: 1 }; });
  const first = f.service.summary(settings, session.id, summary, { generateFeedback: true });
  const duplicate = f.service.summary(settings, session.id, summary, { generateFeedback: true });
  await assert.rejects(f.service.summary(settings, session.id, { ...summary, reasoning: '不应覆盖的另一份推断。' }, { generateFeedback: true }), /已提交并锁定/);
  release(); const results = await Promise.all([first, duplicate]);
  assert.equal(f.requests.length, 1); assert.deepEqual(results[0].feedback, results[1].feedback);
});

test('teacher corrections persist separately and never mutate original feedback, accepted raw response or frozen runtime', async () => {
  const f = fixture(), session = await ended(f), generated: Session = await f.service.summary(settings, session.id, summary, { generateFeedback: true });
  const original = structuredClone(generated.feedback), attempts = structuredClone(generated.feedbackAttempts), runtime = structuredClone(generated.runtime);
  const correction: TeacherCorrection = { criterionId: 'process.identity', score: 1, reason: '教师回看原文后记录部分实现，保留AI原结果。' };
  const reviewed: Session = await f.service.review(session.id, 'SIM-T01', '隔离测试教师复核备注。', [correction]);
  correction.reason = '外部改动不应进入保存记录。';
  const restored = await new LocalRepository(f.storage).get(session.id);
  assert.equal(reviewed.review?.corrections?.[0].score, 1); assert.notEqual(restored.review?.corrections?.[0].reason, correction.reason);
  assert.deepEqual(restored.feedback, original); assert.deepEqual(restored.feedbackAttempts, attempts); assert.deepEqual(restored.runtime, runtime);
  await assert.rejects(f.service.review(session.id, 'SIM-T01', '错误项目应拒绝。', [{ criterionId: 'missing', score: 1, reason: '不存在的评分项' }]), /修正项目或理由无效/);
  assert.deepEqual((await f.repository.backup()).sessions[0].feedback, original);
  assert.equal(f.requests.length, 1);
});
