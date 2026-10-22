import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getCase } from '../packages/core/src/cases.ts';
import { getAssessmentCriteria } from '../packages/core/src/assessment.ts';
import type { Session, Study, Participant, LearnerSummary, Turn } from '../packages/core/src/types.ts';

const repositoryModule = new URL('../apps/mobile/src/platform/repository.ts', import.meta.url).href;
const serviceModule = new URL('../apps/mobile/src/platform/local-service.ts', import.meta.url).href;
const exportModule = new URL('../apps/mobile/src/platform/export-data.ts', import.meta.url).href;
const { LocalRepository } = await import(repositoryModule);
const { LocalService } = await import(serviceModule);
const { researchFiles, toCsv } = await import(exportModule);
const at = '2026-10-21T00:00:00.000Z';
const definition = getCase('ruq-01');
const summary: LearnerSummary = { history: '患者自述腹痛，需要继续核实时间与相关病史。', reasoning: '当前病因尚不确定。', plan: '继续核实症状与既往史。', uncertainty: '检查及体征尚不清楚。' };
const spoken = '您好，我是住院医师王医生，请问您怎么称呼？';
const learner = (): Turn => ({ id: 'introduction', role: 'learner', source: 'typed', final: true, text: spoken, at });
const settings = () => ({ mode: 'standalone', textProfileId: 'text-fixed', voiceProfileId: 'voice-fixed', profiles: [
  { id: 'text-fixed', name: '文本原配置', company: 'qwen', chatUrl: 'https://original.example/v1/chat/completions', chatModel: 'qwen3.8-flash',
    realtimeProtocol: 'none', realtimeUrl: '', realtimeModel: '', voice: '', hasKey: true },
  { id: 'voice-fixed', name: '语音原配置', company: 'openai', chatUrl: 'https://unused.example/v1/chat/completions', chatModel: 'unused',
    realtimeProtocol: 'openai', realtimeUrl: 'wss://voice.example/v1/realtime', realtimeModel: 'gpt-realtime', voice: 'marin', hasKey: true },
] });

class MemoryStorage {
  files = new Map<string, string>();
  failWrite?: (path: string) => boolean;
  async read(path: string) { return this.files.get(path) ?? null; }
  async write(path: string, value: string) { if (this.failWrite?.(path)) throw new Error('injected disk write failure'); this.files.set(path, value); }
  async list(path: string) { return [...this.files.keys()].filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')); }
  async remove(path: string) { this.files.delete(path); }
}
function feedbackText(score: 1 | null = null) {
  return JSON.stringify({ items: getAssessmentCriteria(definition).map(criterion => ({ criterionId: criterion.id,
    score: criterion.id === 'process.identity' ? score : null,
    status: criterion.id === 'process.identity' && score !== null ? 'to_improve' : 'insufficient_evidence',
    comment: '原文支持部分语言行为，其余需教师核对。',
    evidence: criterion.id === 'process.identity' && score !== null ? [{ turnId: 'introduction', quote: spoken }] : [],
    notScoredReason: criterion.id === 'process.identity' && score !== null ? null : 'insufficient_evidence', zeroEvidence: null,
  })) });
}
function fixture(storage = new MemoryStorage()) {
  const repository = new LocalRepository(storage), requests: any[] = [];
  let handler: (request: any) => Promise<any> = async request => ({ text: request.options?.purpose === 'assessment' ? feedbackText(1) : '昨天晚上开始疼的。',
    model: request.profile.chatModel, elapsedMs: 12, requestId: 'local-request', usage: { total_tokens: 25 } });
  const dependencies = { repository, storage,
    credentials: async (ids: string[]) => Object.fromEntries(ids.map(id => [id, { hasKey: true }])),
    audio: { append: async () => {}, blob: async () => new Blob(), remove: async () => {} },
    chat: async (profile: any, instructions: string, input: string, options: any) => {
      const request = { profile: structuredClone(profile), instructions, input, options }; requests.push(request); return handler(request);
    },
  };
  const service = new LocalService(dependencies);
  return { storage, repository, service, requests, dependencies, setChat: (next: typeof handler) => { handler = next; } };
}
async function register(f: ReturnType<typeof fixture>) {
  const study: Study = await f.service.saveStudy({ code: 'STUDY-中文', title: '问诊教学研究', ethicsId: '待核实' });
  const participant: Participant = await f.service.saveParticipant({ studyId: study.id, code: 'P001', group: 'A组', trainingYear: '住培一年级',
    rotationMonths: 3, consent: 'recorded', note: '登记时资料' });
  return { study, participant };
}
async function startResearch(f: ReturnType<typeof fixture>) {
  const { study, participant } = await register(f), config = settings();
  const session: Session = await f.service.start(config, definition.id, { mode: 'research', phase: 'baseline', studyId: study.id, participantId: participant.id });
  return { study, participant, config, session };
}
async function until<T>(pick: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { const value = await pick(); if (value !== undefined && value !== false) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Local mobile data test timed out');
}
function sourceSession(research?: Session['research']): Session { return { id: randomUUID(), caseId: definition.id, caseVersion: definition.version,
  caseTitle: definition.title, createdAt: at, status: 'interview', turns: [], ...(research ? { research } : {}) }; }
function study(code: string): Study { return { id: randomUUID(), code, title: code, createdAt: at, updatedAt: at }; }
function participant(studyId: string, code = 'P001'): Participant { return { id: randomUUID(), studyId, code, consent: 'recorded', createdAt: at, updatedAt: at }; }
function backup(studies: Study[] = [], participants: Participant[] = [], sessions: Session[] = []) {
  return { schemaVersion: '0.2', exportedAt: at, simulatedCases: true, studies, participants, sessions, drafts: {} };
}
/** Independent CSV reader: validate exported cells, including quoted newlines, rather than matching a serializer's formatting. */
function csvRows(csv: string): string[][] {
  csv = csv.replace(/^\uFEFF/, ''); const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') { if (quoted && csv[index + 1] === '"') { field += '"'; index++; } else quoted = !quoted; }
    else if (!quoted && char === ',') { row.push(field); field = ''; }
    else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && csv[index + 1] === '\n') index++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  assert.equal(quoted, false, 'export must contain complete quoted cells');
  if (field || row.length) rows.push([...row, field]); return rows;
}
function csvObjects(csv: string): Record<string, string>[] { const [headers, ...rows] = csvRows(csv); return rows.map(row => Object.fromEntries(headers.map((header, i) => [header, row[i]]))); }

test('research snapshots and model execution profiles survive later registration, settings and returned-object edits', async () => {
  const f = fixture(), { study, participant, config, session } = await startResearch(f);
  const originalResearch = structuredClone(session.research), originalRuntime = structuredClone(session.runtime);
  await f.service.saveStudy({ ...study, code: 'RENAMED', title: '后来修改的项目名称' });
  await f.service.saveParticipant({ ...participant, group: 'B组', trainingYear: '住培二年级', rotationMonths: 8, consent: 'not_recorded', note: '后来更正' });
  config.profiles[0].chatModel = 'different-default-model'; config.profiles[0].chatUrl = 'https://changed.example/v1/chat/completions';
  config.profiles[1].realtimeModel = 'different-realtime';
  session.research!.group = '返回对象被外部改写';
  await f.service.patientReply(config, session.id, '什么时候开始疼的？');
  const persisted: Session = await f.service.get(session.id);
  assert.deepEqual(persisted.research, originalResearch); assert.deepEqual(persisted.runtime, originalRuntime);
  assert.equal(f.requests[0].profile.chatModel, 'qwen3.8-flash'); assert.equal(f.requests[0].profile.chatUrl, 'https://original.example/v1/chat/completions');
  const frozen = await f.service.sessionSettings(config, session.id); assert.equal(frozen.profiles[0].hasKey, undefined);
  assert.equal(frozen.profiles.find((p: any) => p.id === 'voice-fixed').realtimeModel, 'gpt-realtime');
  f.storage.files.delete(`execution/${session.id}.json`);
  const reconstructed = await f.service.sessionSettings(config, session.id);
  assert.equal(reconstructed.profiles.find((p: any) => p.id === reconstructed.textProfileId).chatModel, 'qwen3.8-flash');
  const exported = await f.repository.backup();
  assert.equal(exported.sessions[0].research.group, 'A组'); assert.equal(exported.participants[0].group, 'B组');
  assert.equal(persisted.modelCalls?.[0].profileId, 'text-fixed'); assert.equal(persisted.modelCalls?.[0].requestId, 'local-request');
});

test('failed persistent writes never publish session or registration changes to memory', async () => {
  const f = fixture(), { session, participant } = await startResearch(f);
  const sessionPath = `sessions/${session.id}.json`, oldSession = f.storage.files.get(sessionPath);
  f.storage.failWrite = path => path === sessionPath;
  await assert.rejects(f.service.addTurn(session.id, learner()), /write failure/);
  assert.deepEqual((await f.service.get(session.id)).turns, []); assert.equal(f.storage.files.get(sessionPath), oldSession);
  f.storage.failWrite = path => path === `participants/${participant.id}.json`;
  await assert.rejects(f.service.saveParticipant({ ...participant, group: '不应发布的分组' }), /write failure/);
  assert.equal((await f.service.participants())[0].group, 'A组');
  f.storage.failWrite = undefined; await f.service.addTurn(session.id, learner());
  const restarted = new LocalRepository(f.storage); assert.equal((await restarted.get(session.id)).turns[0].text, spoken);
});

test('feedback interrupted after summary persistence is durably retryable after restart', async () => {
  const f = fixture(), { config, session } = await startResearch(f);
  await f.service.addTurn(session.id, learner()); await f.service.commitEnd(session.id);
  f.setChat(async () => await new Promise(() => {}));
  void f.service.summary(config, session.id, summary).catch(() => undefined);
  await until(async () => (await f.service.get(session.id)).status === 'feedback_pending');
  const restarted = fixture(f.storage), recovered: Session = await restarted.service.get(session.id);
  assert.equal(recovered.status, 'summary'); assert.deepEqual(recovered.summary, summary); assert.equal(recovered.feedback, undefined);
  assert.match(recovered.feedbackError ?? '', /中断/);
  assert.equal(JSON.parse(f.storage.files.get(`sessions/${session.id}.json`)!).status, 'summary');
  const completed: Session = await restarted.service.summary(config, session.id, summary);
  assert.equal(completed.status, 'feedback_ready'); assert.equal(completed.feedback?.assessment?.version, '0.1');
  assert.equal(completed.feedbackAttempts?.[0].accepted, true);
});

test('original model feedback and raw attempts stay separate from teacher correction history and export', async () => {
  const f = fixture(), { config, session } = await startResearch(f);
  await f.service.addTurn(session.id, learner()); await f.service.commitEnd(session.id);
  f.setChat(async () => ({ text: '不符合JSON结构的原始模型回复', model: 'configured-model', elapsedMs: 8 }));
  await assert.rejects(f.service.summary(config, session.id, summary), /总结已保存/);
  assert.equal((await f.service.get(session.id)).status, 'summary'); await assert.rejects(f.service.review(session.id, 'T01', '尚无反馈'), /尚未生成/);
  const raw = feedbackText(1); f.setChat(async () => ({ text: raw, model: 'resolved-model', elapsedMs: 9 }));
  const generated: Session = await f.service.summary(config, session.id, summary), original = structuredClone(generated.feedback);
  const correction = { criterionId: 'process.identity', score: 2, reason: '教师结合原文与录音人工复核后更正。' };
  await f.service.review(session.id, 'T01', '教师第一版备注\n保留原始评分。', [correction]);
  const reviewed: Session = await f.service.review(session.id, 'T02', '教师第二版复核意见，不覆盖模型结果。');
  assert.deepEqual(reviewed.feedback, original); assert.equal(reviewed.reviewHistory?.[0].reviewer, 'T01'); assert.equal(reviewed.review?.reviewer, 'T02');
  assert.deepEqual(reviewed.feedbackAttempts?.map(attempt => [attempt.accepted, attempt.raw]), [[false, '不符合JSON结构的原始模型回复'], [true, raw]]);
  const files: { path: string; content: string }[] = researchFiles(await f.repository.backup(), false);
  const assessments = csvObjects(files.find(file => file.path === 'assessments.csv')!.content);
  assert.equal(assessments.find(row => row.criterion_id === 'process.identity')!.score, '1');
  assert.ok(assessments.every(row => row.grading_origin === 'original_model_preassessment'));
  const reviews = csvObjects(files.find(file => file.path === 'teacher_reviews.csv')!.content);
  assert.equal(JSON.parse(reviews[0].corrections)[0].score, 2); assert.equal(reviews[1].reviewer_code, 'T02');
  assert.equal(JSON.parse(files.find(file => file.path === 'backup.json')!.content).sessions[0].feedbackAttempts[1].raw, raw);
});

test('same-ID import conflicts reject the whole batch without overwriting or adding unrelated rows', async () => {
  const f = fixture(), { session } = await startResearch(f), original = await f.repository.backup();
  const target = fixture(), first = await target.service.importBackup(JSON.stringify(original)); assert.equal(first.sessions, 1);
  const before = [...target.storage.files.entries()].sort();
  const conflicting = structuredClone(original); conflicting.sessions[0].caseTitle = '同一ID的另一份内容'; conflicting.studies.push(study('MUST-NOT-IMPORT'));
  await assert.rejects(target.service.importBackup(JSON.stringify(conflicting)), /同一编号已有不同内容/);
  assert.deepEqual([...target.storage.files.entries()].sort(), before); assert.equal((await target.service.get(session.id)).caseTitle, definition.title);
  const repeated = await target.service.importBackup(JSON.stringify(original)); assert.equal(repeated.sessions, 0); assert.equal(repeated.skipped, 3);
});

test('two collectors merge distinct session UUIDs under one unchanged master registry and repeated imports skip duplicates', async () => {
  const master = fixture(), { study, participant } = await register(master);
  const registryOnly = await master.repository.backup();
  assert.equal(registryOnly.sessions.length, 0);
  const registryJson = JSON.stringify(registryOnly), collectorA = fixture(), collectorB = fixture();
  for (const collector of [collectorA, collectorB]) {
    const imported = await collector.service.importBackup(registryJson);
    assert.equal(imported.studies, 1); assert.equal(imported.participants, 1); assert.equal(imported.sessions, 0);
  }
  const selection = { mode: 'research', phase: 'baseline', studyId: study.id, participantId: participant.id };
  const first: Session = await collectorA.service.start(settings(), definition.id, selection);
  const second: Session = await collectorB.service.start(settings(), definition.id, selection);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(first.id, uuid); assert.match(second.id, uuid); assert.notEqual(first.id, second.id);
  await collectorA.service.addTurn(first.id, { ...learner(), text: '采集端甲的独立问诊原文。' });
  await collectorB.service.addTurn(second.id, { ...learner(), text: '采集端乙的独立问诊原文。' });
  await collectorA.service.commitEnd(first.id); await collectorB.service.commitEnd(second.id);
  const exports = await Promise.all([collectorA.repository.backup(), collectorB.repository.backup()]);
  for (const exported of exports) {
    assert.deepEqual(exported.studies, [study]); assert.deepEqual(exported.participants, [participant]);
    const merged = await master.service.importBackup(JSON.stringify(exported));
    assert.equal(merged.sessions, 1); assert.equal(merged.studies, 0); assert.equal(merged.participants, 0); assert.equal(merged.skipped, 2);
  }
  for (const exported of exports) {
    const repeated = await master.service.importBackup(JSON.stringify(exported));
    assert.equal(repeated.sessions, 0); assert.equal(repeated.studies, 0); assert.equal(repeated.participants, 0); assert.equal(repeated.skipped, 3);
  }
  const merged: Session[] = await master.service.list();
  assert.deepEqual(new Set(merged.map(session => session.id)), new Set([first.id, second.id]));
  assert.ok(merged.every(session => session.research?.studyId === study.id && session.research?.participantId === participant.id));
  assert.deepEqual(new Set(merged.map(session => session.turns[0].text)), new Set(['采集端甲的独立问诊原文。', '采集端乙的独立问诊原文。']));
  assert.deepEqual(await master.service.studies(), [study]); assert.deepEqual(await master.service.participants(), [participant]);
  assert.equal(master.requests.length + collectorA.requests.length + collectorB.requests.length, 0, 'registry distribution and merging need no model or network call');
});

test('import validates project-participant relationships rather than just checking that both IDs exist', async () => {
  const projectA = study('A'), projectB = study('B'), personB = participant(projectB.id);
  for (const kind of ['cross_project', 'missing_project_reference', 'unknown_participant'] as const) {
    const f = fixture(), research: Session['research'] = { mode: 'research', phase: 'baseline', attemptIndex: 1, capturedAt: at,
      ...(kind === 'missing_project_reference' ? {} : { studyId: projectA.id }), participantId: kind === 'unknown_participant' ? randomUUID() : personB.id };
    const source = backup([projectA, projectB], [personB], [sourceSession(research)]);
    await assert.rejects(f.service.importBackup(JSON.stringify(source)), /关联|项目|学员/, kind);
    assert.equal(f.storage.files.size, 0, 'invalid foreign keys must be rejected before writing an import journal');
  }
  const f = fixture(); await f.repository.saveStudy(projectA); await f.repository.saveStudy(projectB); await f.repository.saveParticipant(personB);
  await assert.rejects(f.repository.saveParticipant({ ...personB, studyId: projectA.id }), /不能移动/);
});

test('import rejects malformed nested session data before it can crash history, feedback or export views', async () => {
  const f = fixture(), { config, session } = await startResearch(f);
  await f.service.addTurn(session.id, learner()); await f.service.commitEnd(session.id); await f.service.summary(config, session.id, summary);
  const valid = await f.repository.backup();
  const corruptions: { name: string; change(value: any): void }[] = [
    { name: 'feedback items is not an array', change: value => { value.feedback.items = {}; } },
    { name: 'practice list is null', change: value => { value.feedback.nextPractice = null; } },
    { name: 'runtime text is null', change: value => { value.runtime.text = null; } },
    { name: 'participant code is a React child object', change: value => { value.research.participantCode = { invalid: true }; } },
    { name: 'model calls is not an array', change: value => { value.modelCalls = {}; } },
    { name: 'feedback attempts is not an array', change: value => { value.feedbackAttempts = {}; } },
    { name: 'summary text is an object', change: value => { value.summary.history = { invalid: true }; } },
    { name: 'evidence is not an array', change: value => { value.feedback.items[0].evidence = {}; } },
    { name: 'an imported score exceeds its public contract', change: value => { value.feedback.items[0].score = 100; } },
  ];
  for (const corruption of corruptions) {
    const target = fixture(), input = structuredClone(valid); corruption.change(input.sessions[0]);
    await assert.rejects(target.service.importBackup(JSON.stringify(input)), (error: unknown) => error instanceof Error, corruption.name);
    assert.equal(target.storage.files.size, 0, corruption.name);
  }
});

test('CSV cells preserve Chinese, quotes and newlines while formulas are escaped only in CSV', () => {
  const original = '中文，带"引号"\n第二行\r\n第三行'; const formula = ' \t=HYPERLINK("https://example.invalid","测试")';
  const csv: string = toCsv([{ text: original, formula, note: '@SUM(1,2)', number: -2 }], ['text', 'formula', 'note', 'number']);
  assert.equal(csv.charCodeAt(0), 0xFEFF); assert.ok(csv.endsWith('\r\n'));
  const [headers, row] = csvRows(csv); assert.deepEqual(headers, ['text', 'formula', 'note', 'number']);
  assert.deepEqual(row, [original, `'${formula}`, "'@SUM(1,2)", "'-2"]);
  const source = sourceSession(); source.turns = [{ ...learner(), text: formula }];
  const files: { path: string; content: string }[] = researchFiles(backup([], [], [source]), false);
  assert.equal(JSON.parse(files.find(file => file.path === 'backup.json')!.content).sessions[0].turns[0].text, formula);
  assert.equal(csvObjects(files.find(file => file.path === 'turns.csv')!.content)[0].text, `'${formula}`);
});

test('research CSV tables retain optional fields that first occur in a later row', () => {
  const firstStudy = study('A'), laterStudy = { ...study('B'), ethicsId: '后出现的伦理记录' };
  const firstPerson = participant(firstStudy.id), laterPerson = { ...participant(firstStudy.id, 'P002'), group: '后出现的组别', note: '第二行备注' };
  const session = sourceSession(); session.modelCalls = [
    { at, kind: 'patient_reply', model: 'model-A', elapsedMs: 1 },
    { at, kind: 'assessment', model: 'model-B', elapsedMs: 2, requestId: 'later-request-id', usage: { total_tokens: 12 } },
  ]; session.feedbackAttempts = [{ id: randomUUID(), at, model: 'model-A', raw: '{}', accepted: true },
    { id: randomUUID(), at, model: 'model-B', raw: 'bad', accepted: false, error: '后出现的失败原因' }];
  const files: { path: string; content: string }[] = researchFiles(backup([firstStudy, laterStudy], [firstPerson, laterPerson], [session]), false);
  const table = (name: string) => csvObjects(files.find(file => file.path === name)!.content);
  assert.equal(table('studies.csv')[1].ethicsId, '后出现的伦理记录');
  assert.equal(table('participants.csv')[1].group, '后出现的组别'); assert.equal(table('participants.csv')[1].note, '第二行备注');
  assert.equal(table('model_calls.csv')[1].requestId, 'later-request-id'); assert.deepEqual(JSON.parse(table('model_calls.csv')[1].usage), { total_tokens: 12 });
  assert.equal(table('feedback_attempts.csv')[1].error, '后出现的失败原因');
});

test('an interrupted import keeps a durable journal and replays fully after storage recovers', async () => {
  const f = fixture(), { session } = await startResearch(f), original = await f.repository.backup();
  const storage = new MemoryStorage(), target = fixture(storage); let failed = false;
  storage.failWrite = path => { if (!failed && path.startsWith('participants/')) { failed = true; return true; } return false; };
  await assert.rejects(target.service.importBackup(JSON.stringify(original)), /导入尚未完成/);
  assert.ok(storage.files.has('imports/pending.json'));
  storage.failWrite = undefined; const restored = new LocalRepository(storage); const recovered: Session = await restored.get(session.id);
  assert.deepEqual(recovered, session); assert.equal((await restored.listParticipants()).length, 1); assert.equal((await restored.listStudies()).length, 1);
  assert.equal(storage.files.has('imports/pending.json'), false);
});
