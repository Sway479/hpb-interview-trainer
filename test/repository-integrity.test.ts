import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Session, Study, Participant, LearnerSummary } from '../packages/core/src/types.ts';
import type { DocumentStorage } from '../apps/mobile/src/platform/storage.ts';

const { LocalRepository } = await import(new URL('../apps/mobile/src/platform/repository.ts', import.meta.url).href);
const { researchFiles } = await import(new URL('../apps/mobile/src/platform/export-data.ts', import.meta.url).href);
const at = '2026-10-23T00:00:00.000Z';
const summary: LearnerSummary = { history: 'SIMULATED_ONLY：患者自述腹痛，仍需继续核实病史。', reasoning: '病因尚未确定。', plan: '继续采集病史。', uncertainty: '体征及检查未知。' };
class MemoryStorage implements DocumentStorage {
  files = new Map<string, string>();
  writes: string[] = [];
  failRead?: string;
  failWrite?: string;
  async read(path: string) { if (this.failRead === path) throw new Error('injected read failure'); return this.files.get(path) ?? null; }
  async write(path: string, data: string) { if (this.failWrite === path) throw new Error('injected write failure'); this.files.set(path, data); this.writes.push(path); }
  async list(path: string) { return [...this.files.keys()].filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')); }
  async remove(path: string) { this.files.delete(path); }
}
function session(): Session { return { id: randomUUID(), caseId: 'ruq-01', caseVersion: '0.1', caseTitle: 'SIMULATED_ONLY', createdAt: at, status: 'summary', turns: [] }; }
function study(): Study { return { id: randomUUID(), code: 'SIMULATED_ONLY', title: '隔离软件测试', createdAt: at, updatedAt: at }; }
function participant(studyId: string): Participant { return { id: randomUUID(), studyId, code: 'SIMULATED_ONLY', consent: 'not_applicable', createdAt: at, updatedAt: at }; }
function backup(sessions: Session[], studies: Study[] = [], participants: Participant[] = []) {
  return { schemaVersion: '0.2', exportedAt: at, simulatedCases: true, studies, participants, sessions, drafts: {} };
}
async function fixture() {
  const storage = new MemoryStorage(), repository = new LocalRepository(storage), value = session();
  await repository.create(value);
  return { storage, repository, value, path: `sessions/${value.id}.json`, draftPath: `drafts/${value.id}.json` };
}

test('schema-invalid mutations preserve original persisted bytes, in-memory record and restart visibility', async () => {
  const f = await fixture(), original = f.storage.files.get(f.path), writes = f.storage.writes.length;
  const invalidChanges: ((value: Session) => void)[] = [
    value => { value.review = { reviewer: 'SIMULATED_ONLY', notes: '隔离测试', at, corrections: [{ criterionId: 'process.identity', score: 1, reason: '长'.repeat(6001) }] }; },
    value => { value.turns.push({ id: 'SIMULATED_ONLY', role: 'learner', source: 'typed', at, final: true, text: '长'.repeat(20001) }); },
    value => { value.reviewHistory = Array.from({ length: 1001 }, () => ({ reviewer: 'SIMULATED_ONLY', notes: '隔离测试', at })); },
    value => { value.id = randomUUID(); },
  ];
  for (const change of invalidChanges) {
    await assert.rejects(f.repository.mutate(f.value.id, change));
    assert.equal(f.storage.files.get(f.path), original);
    assert.deepEqual(await f.repository.get(f.value.id), f.value);
    const restarted = new LocalRepository(f.storage);
    assert.deepEqual(await restarted.get(f.value.id), f.value);
    assert.equal(restarted.warnings.length, 0);
  }
  assert.equal(f.storage.writes.length, writes, 'invalid state must be rejected before any disk write');
  await f.repository.mutate(f.value.id, (value: Session) => { value.endedAt = at; });
  assert.equal((await new LocalRepository(f.storage).get(f.value.id)).endedAt, at, 'a rejected change must not poison the write queue');
});

test('valid mutations publish to memory only after persistence succeeds', async () => {
  const f = await fixture(), original = f.storage.files.get(f.path);
  f.storage.failWrite = f.path;
  await assert.rejects(f.repository.mutate(f.value.id, (value: Session) => { value.endedAt = at; }), /write failure/);
  assert.equal(f.storage.files.get(f.path), original);
  assert.deepEqual(await f.repository.get(f.value.id), f.value);
  f.storage.failWrite = undefined;
  assert.deepEqual(await new LocalRepository(f.storage).get(f.value.id), f.value);
});

test('a corrupt draft remains recoverable while other records and valid drafts can be exported', async () => {
  const f = await fixture(), good = session(), raw = '{SIMULATED_ONLY：损坏草稿原文\n';
  await f.repository.create(good);
  await f.repository.saveDraft(good.id, summary);
  f.storage.files.set(f.draftPath, raw);
  await assert.rejects(f.repository.getDraft(f.value.id), /原文件保留/);
  await assert.rejects(f.repository.getDraft(f.value.id), /原文件保留/);
  assert.equal(f.repository.warnings.filter((warning: {path: string}) => warning.path === f.draftPath).length, 1, 'repeated failures must not duplicate warnings');
  assert.equal(f.repository.warnings[0].raw, raw);
  const exported = await f.repository.backup();
  assert.equal(exported.sessions.length, 2);
  assert.deepEqual(exported.drafts?.[good.id], summary);
  assert.equal(exported.drafts?.[f.value.id], undefined, 'malformed data must not enter the restorable backup');
  const files = researchFiles(exported, false, f.repository.warnings);
  assert.ok(files.some((file: { path: string; content: string }) => file.path.startsWith('recovery/') && file.content === raw));
  assert.equal(f.storage.files.get(f.draftPath), raw);
  const restored = new LocalRepository(new MemoryStorage());
  assert.equal((await restored.importBackup(JSON.stringify(exported))).sessions, 2);
  const restarted = new LocalRepository(f.storage);
  await assert.rejects(restarted.getDraft(f.value.id), /原文件保留/);
  assert.equal(restarted.warnings[0].raw, raw);
  assert.equal(f.storage.files.get(f.draftPath), raw);
});

test('draft read failures stay visible without preventing session backup, retaining any previously read source', async () => {
  const f = await fixture(), raw = '{SIMULATED_ONLY:invalid';
  f.storage.files.set(f.draftPath, raw);
  await assert.rejects(f.repository.getDraft(f.value.id));
  f.storage.failRead = f.draftPath;
  const exported = await f.repository.backup();
  assert.equal(exported.sessions.length, 1);
  assert.equal(f.repository.warnings.length, 1);
  assert.equal(f.repository.warnings[0].raw, raw);
  assert.equal(f.storage.files.get(f.draftPath), raw);
});

test('draft warnings clear only after successful reads, confirmed absence, successful save or explicit deletion', async () => {
  for (const action of ['read', 'missing', 'save', 'delete'] as const) {
    const f = await fixture();
    f.storage.files.set(f.draftPath, '{SIMULATED_ONLY:invalid');
    await assert.rejects(f.repository.getDraft(f.value.id));
    f.storage.failWrite = f.draftPath;
    await assert.rejects(f.repository.saveDraft(f.value.id, summary));
    assert.equal(f.repository.warnings.length, 1, 'a failed save must not acknowledge the warning');
    f.storage.failWrite = undefined;
    if (action === 'read') { f.storage.files.set(f.draftPath, JSON.stringify(summary)); await f.repository.getDraft(f.value.id); }
    if (action === 'missing') { f.storage.files.delete(f.draftPath); assert.equal(await f.repository.getDraft(f.value.id), null); }
    if (action === 'save') await f.repository.saveDraft(f.value.id, summary);
    if (action === 'delete') await f.repository.saveDraft(f.value.id, null);
    assert.equal(f.repository.warnings.length, 0, action);
  }
});

test('queued stale draft writes cannot overwrite a submitted summary and deletion remains available', async () => {
  const f = await fixture();
  await f.repository.saveDraft(f.value.id, summary);
  const originalDraft = f.storage.files.get(f.draftPath);
  const submitted = f.repository.mutate(f.value.id, (value: Session) => { value.summary = structuredClone(summary); });
  const staleWrite = f.repository.saveDraft(f.value.id, { ...summary, plan: '过期草稿不得覆盖。' });
  await submitted;
  await assert.rejects(staleWrite, /已提交|过期草稿/);
  assert.equal(f.storage.files.get(f.draftPath), originalDraft);
  assert.deepEqual((await f.repository.get(f.value.id)).summary, summary);
  const restarted = new LocalRepository(f.storage);
  await assert.rejects(restarted.saveDraft(f.value.id, summary), /已提交|过期草稿/);
  await restarted.saveDraft(f.value.id, null);
  assert.equal(f.storage.files.has(f.draftPath), false);
  assert.deepEqual((await new LocalRepository(f.storage).get(f.value.id)).summary, summary);
});

test('draft writes are rejected for non-editable session states even without a summary', async () => {
  for (const status of ['feedback_pending', 'feedback_ready', 'reviewed'] as const) {
    const f = await fixture();
    await f.repository.mutate(f.value.id, (value: Session) => { value.status = status; });
    await assert.rejects(f.repository.saveDraft(f.value.id, summary), /状态已改变/);
    assert.equal(f.storage.files.has(f.draftPath), false);
    await f.repository.saveDraft(f.value.id, null);
  }
});

test('research imports missing either registration ID reject the whole batch before writing a journal', async () => {
  for (const missing of ['both', 'study', 'participant'] as const) {
    const storage = new MemoryStorage(), repository = new LocalRepository(storage), project = study(), learner = participant(project.id), value = session();
    value.research = { mode: 'research', phase: 'baseline', attemptIndex: 1, capturedAt: at,
      ...(missing !== 'both' && missing !== 'study' ? { studyId: project.id } : {}),
      ...(missing !== 'both' && missing !== 'participant' ? { participantId: learner.id } : {}),
    };
    await assert.rejects(repository.importBackup(JSON.stringify(backup([session(), value], [project], [learner]))), /必须同时关联/);
    assert.equal(storage.files.size, 0, missing);
    assert.deepEqual(storage.writes, [], missing);
  }
});

test('complete research links import while practice and legacy snapshots keep their compatibility', async () => {
  const storage = new MemoryStorage(), repository = new LocalRepository(storage), project = study(), learner = participant(project.id);
  const research = session(), practice = session(), legacy = session();
  research.research = { mode: 'research', studyId: project.id, participantId: learner.id, phase: 'baseline', attemptIndex: 1, capturedAt: at };
  practice.research = { mode: 'practice', phase: 'training', attemptIndex: 1, capturedAt: at };
  const original = backup([research, practice, legacy], [project], [learner]);
  const counts = await repository.importBackup(JSON.stringify(original));
  assert.equal(counts.sessions, 3);
  const restarted = new LocalRepository(storage);
  assert.deepEqual(await restarted.get(research.id), research);
  assert.deepEqual(await restarted.get(practice.id), practice);
  assert.deepEqual(await restarted.get(legacy.id), legacy);
  assert.equal((await restarted.importBackup(JSON.stringify(original))).skipped, 5);
});

test('identical historical research records with missing IDs are not silently accepted by deduplication', async () => {
  const f = await fixture();
  const historical = await f.repository.mutate(f.value.id, (value: Session) => { value.research = { mode: 'research', phase: 'baseline', attemptIndex: 1, capturedAt: at }; });
  const original = f.storage.files.get(f.path), writes = f.storage.writes.length;
  await assert.rejects(f.repository.importBackup(JSON.stringify(backup([historical]))), /必须同时关联/);
  assert.equal(f.storage.files.get(f.path), original);
  assert.equal(f.storage.writes.length, writes);
});
