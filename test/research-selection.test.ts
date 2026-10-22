import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DocumentStorage } from '../apps/mobile/src/platform/storage.ts';
import type { ResearchSelection } from '../apps/mobile/src/platform/contracts.ts';
import type { Participant, Session, Study } from '../packages/core/src/types.ts';

const moduleUrl = new URL('../apps/mobile/src/platform/research-selection.ts', import.meta.url).href;
const { loadResearchSelection, saveResearchSelection, validateResearchSelection, RESEARCH_SELECTION_PATH } = await import(moduleUrl);
const { LocalRepository } = await import(new URL('../apps/mobile/src/platform/repository.ts', import.meta.url).href);
const defaultSelection: ResearchSelection = { mode: 'practice', phase: 'training' };

class MemoryStorage implements DocumentStorage {
  files = new Map<string, string>();
  writes: string[] = [];
  failRead = false;
  failWrite = false;
  async read(path: string) {
    if (this.failRead) throw new Error('injected read failure');
    return this.files.get(path) ?? null;
  }
  async write(path: string, data: string) {
    if (this.failWrite) throw new Error('injected write failure');
    this.files.set(path, data); this.writes.push(path);
  }
  async list(path: string) { return [...this.files.keys()].filter(key => key.startsWith(path + '/')); }
  async remove(path: string) { this.files.delete(path); }
}
function fixture() {
  const storage = new MemoryStorage(), studyId = randomUUID(), participantId = randomUUID();
  const registry = { studies: [{ id: studyId }], participants: [{ id: participantId, studyId }] };
  const selection: ResearchSelection = { mode: 'research', phase: 'post', studyId, participantId };
  return { storage, registry, selection };
}
const stored = (selection: unknown) => JSON.stringify({ version: 1, selection });

test('missing preference safely defaults to practice without writing or sharing mutable defaults', async () => {
  const { storage, registry } = fixture();
  const first = await loadResearchSelection(registry, storage);
  assert.deepEqual(first, { selection: defaultSelection });
  first.selection.mode = 'research';
  assert.deepEqual(await loadResearchSelection(registry, storage), { selection: defaultSelection });
  assert.equal(storage.writes.length, 0);
});

test('research binding survives a reload by UUID and writes no sessions, registration data or credentials', async () => {
  const { storage, registry, selection } = fixture();
  const historyPath = `sessions/${randomUUID()}.json`, history = JSON.stringify({ research: { ...selection }, frozen: true });
  const studyPath = `studies/${selection.studyId}.json`;
  storage.files.set(historyPath, history); storage.files.set(studyPath, '{"historical":"registration"}');
  const saved = await saveResearchSelection(selection, registry, storage);
  selection.phase = 'baseline'; saved.participantId = randomUUID();
  const reloaded = await loadResearchSelection(registry, storage);
  assert.deepEqual(reloaded, { selection: { mode: 'research', phase: 'post', studyId: registry.studies[0].id, participantId: registry.participants[0].id } });
  assert.deepEqual(storage.writes, [RESEARCH_SELECTION_PATH]);
  assert.equal(storage.files.get(historyPath), history);
  assert.equal(storage.files.get(studyPath), '{"historical":"registration"}');
  assert.deepEqual(Object.keys(JSON.parse(storage.files.get(RESEARCH_SELECTION_PATH)!)).sort(), ['selection', 'version']);
  assert.deepEqual(Object.keys(reloaded.selection).sort(), ['mode', 'participantId', 'phase', 'studyId']);
});

test('practice mode and each supported timepoint persist without carrying research IDs', async () => {
  const { storage, registry } = fixture();
  for (const phase of ['baseline', 'training', 'post', 'retention'] as const) {
    await saveResearchSelection({ mode: 'practice', phase }, registry, storage);
    assert.deepEqual(await loadResearchSelection(registry, storage), { selection: { mode: 'practice', phase } });
  }
  const practiceWithStaleIds = { mode: 'practice', phase: 'baseline', studyId: 'deleted-study', participantId: 'deleted-participant' };
  assert.deepEqual(validateResearchSelection(practiceWithStaleIds, registry), { mode: 'practice', phase: 'baseline' });
  await saveResearchSelection(practiceWithStaleIds as ResearchSelection, registry, storage);
  assert.deepEqual((await loadResearchSelection(registry, storage)).selection, { mode: 'practice', phase: 'baseline' });
  assert.deepEqual(JSON.parse(storage.files.get(RESEARCH_SELECTION_PATH)!).selection, { mode: 'practice', phase: 'baseline' });
});

test('corruption, unknown fields, unsupported versions and missing identifiers cannot silently become a research binding', async () => {
  const { storage, registry, selection } = fixture();
  const invalid = [
    '{broken', 'null', JSON.stringify({ version: 2, selection }),
    stored({ ...selection, mode: 'other' }), stored({ ...selection, phase: 'other' }),
    stored({ ...selection, studyId: 'not-a-uuid' }), stored({ ...selection, participantId: undefined }),
    stored({ ...selection, apiKey: 'test-only-forbidden-field' }),
  ];
  for (const raw of invalid) {
    storage.files.set(RESEARCH_SELECTION_PATH, raw);
    const result = await loadResearchSelection(registry, storage);
    assert.deepEqual(result.selection, defaultSelection);
    assert.ok(result.warning, 'invalid preferences must produce a user-visible reason');
    assert.equal(storage.files.get(RESEARCH_SELECTION_PATH), raw, 'keep unreadable source data intact');
  }
  assert.equal(storage.writes.length, 0);
});

test('deleted registrations and a participant from another project return practice and never bind a replacement UUID', async () => {
  const { storage, registry, selection } = fixture();
  await saveResearchSelection(selection, registry, storage);
  const invalidRegistries = [
    { studies: [], participants: registry.participants },
    { studies: registry.studies, participants: [] },
    { studies: registry.studies, participants: [{ id: randomUUID(), studyId: selection.studyId! }] },
    { studies: registry.studies, participants: [{ id: selection.participantId!, studyId: randomUUID() }] },
  ];
  for (const current of invalidRegistries) {
    const result = await loadResearchSelection(current, storage);
    assert.deepEqual(result.selection, defaultSelection); assert.ok(result.warning);
  }
  assert.deepEqual(validateResearchSelection(selection, registry), selection);
  assert.throws(() => validateResearchSelection(selection, invalidRegistries[3]), /学员与项目不匹配/);
});

test('invalid save is rejected and does not overwrite the last confirmed preference', async () => {
  const { storage, registry, selection } = fixture();
  await saveResearchSelection(selection, registry, storage);
  const before = storage.files.get(RESEARCH_SELECTION_PATH);
  await assert.rejects(saveResearchSelection({ ...selection, participantId: randomUUID() }, registry, storage), /已不存在/);
  await assert.rejects(saveResearchSelection({ ...selection, participantId: undefined }, registry, storage), /缺少项目或学员/);
  await assert.rejects(saveResearchSelection({ ...selection, apiKey: 'test-only-forbidden-field' } as ResearchSelection, registry, storage), /格式无效/);
  assert.equal(storage.files.get(RESEARCH_SELECTION_PATH), before);
  assert.equal(storage.writes.length, 1);
});

test('read failure produces safe practice with a warning; a failed save rejects and can be retried', async () => {
  const { storage, registry, selection } = fixture();
  await saveResearchSelection(selection, registry, storage);
  storage.failRead = true;
  const failedRead = await loadResearchSelection(registry, storage);
  assert.deepEqual(failedRead.selection, defaultSelection); assert.match(failedRead.warning!, /读取失败/);
  storage.failRead = false; storage.failWrite = true;
  await assert.rejects(saveResearchSelection({ mode: 'practice', phase: 'training' }, registry, storage), /尚未保存/);
  assert.deepEqual((await loadResearchSelection(registry, storage)).selection, selection);
  storage.failWrite = false;
  await saveResearchSelection({ mode: 'practice', phase: 'retention' }, registry, storage);
  assert.deepEqual((await loadResearchSelection(registry, storage)).selection, { mode: 'practice', phase: 'retention' });
});

test('rapid saves finish in invocation order and a reload waits for the last confirmed write', async () => {
  const { registry, selection } = fixture(), storage = new MemoryStorage();
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve; });
  const originalWrite = storage.write.bind(storage);
  let writeCount = 0;
  storage.write = async (path, data) => { if (++writeCount === 1) await firstMayFinish; await originalWrite(path, data); };
  const first = saveResearchSelection(selection, registry, storage);
  const second = saveResearchSelection({ mode: 'practice', phase: 'retention' }, registry, storage);
  const read = loadResearchSelection(registry, storage);
  assert.equal(storage.writes.length, 0, 'no save has been confirmed yet');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual((await read).selection, { mode: 'practice', phase: 'retention' });
  assert.equal(storage.writes.length, 2);
});

test('preference changes leave frozen session snapshots and the v0.2 backup/restore contract unchanged', async () => {
  const { storage, registry, selection } = fixture(), at = '2026-10-22T00:00:00.000Z';
  const repository = new LocalRepository(storage);
  const study: Study = { id: selection.studyId!, code: 'SIMULATED_ONLY', title: '本机绑定测试', createdAt: at, updatedAt: at };
  const participant: Participant = { id: selection.participantId!, studyId: study.id, code: 'SIM-P001', consent: 'not_recorded', createdAt: at, updatedAt: at };
  await repository.saveStudy(study); await repository.saveParticipant(participant);
  const session: Session = { id: randomUUID(), caseId: 'ruq-01', caseVersion: 'test', caseTitle: '虚构病例', createdAt: at,
    status: 'interview', turns: [], research: { ...selection, studyCode: study.code, participantCode: participant.code, attemptIndex: 1, capturedAt: at } };
  await repository.create(session);
  await saveResearchSelection(selection, registry, storage);
  await saveResearchSelection({ mode: 'practice', phase: 'retention' }, registry, storage);
  const backup = await repository.backup();
  assert.deepEqual((await repository.get(session.id)).research, session.research);
  assert.deepEqual(backup.sessions[0].research, session.research);
  assert.deepEqual(Object.keys(backup).sort(), ['drafts', 'exportedAt', 'participants', 'schemaVersion', 'sessions', 'simulatedCases', 'studies']);
  const destination = new MemoryStorage(), restored = new LocalRepository(destination);
  const result = await restored.importBackup(JSON.stringify(backup));
  assert.equal(result.sessions, 1);
  assert.deepEqual((await restored.get(session.id)).research, session.research);
  assert.equal(destination.files.has(RESEARCH_SELECTION_PATH), false, 'device preference is not added to portable research backups');
  assert.deepEqual(await loadResearchSelection(registry, destination), { selection: defaultSelection });
});
