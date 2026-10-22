import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Session, Turn } from '../packages/core/src/types.ts';

const realtimeModule = new URL('../apps/mobile/src/platform/realtime.ts', import.meta.url).href;
const providerModule = new URL('../apps/mobile/src/platform/providers.ts', import.meta.url).href;
const { NativeRealtime, DirectInterview, probeRealtime } = await import(realtimeModule);
const { completeChat } = await import(providerModule);
type Event = Record<string, any>;
type SocketEvent = { id: string; type: 'open' | 'message' | 'error' | 'close'; data?: string; code?: number };
const profile = (protocol = 'qwen') => ({ id: `voice-${protocol}`, name: protocol, company: protocol,
  chatUrl: 'https://text.example/v1', chatModel: 'qwen3.8-flash', realtimeProtocol: protocol,
  realtimeUrl: 'wss://voice.example/realtime', realtimeModel: protocol === 'qwen' ? 'qwen-audio-3.1-realtime-plus' : 'gpt-realtime',
  voice: protocol === 'qwen' ? 'longanqian_v3.1' : 'marin' });
const turn = (id: string, extra: Partial<Turn> = {}): Turn => ({ id, role: 'learner', source: 'asr', final: true,
  text: id, at: '2026-10-21T00:00:00.000Z', ...extra });
async function until<T>(pick: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { const result = pick(); if (result !== undefined && result !== false) return result; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Local direct voice test timed out');
}
class FakeNative {
  listeners = new Set<(event: SocketEvent) => void>();
  opened: Event[] = []; sent: Event[] = []; closed: string[] = []; responses: Event[] = []; httpCalls: Event[] = [];
  autoReady = true;
  private lastItem = new Map<string, Event>();
  emit(event: Event, socketId = this.opened.at(-1)?.id) { for (const listener of this.listeners) listener({ id: socketId, type: 'message', data: JSON.stringify(event) }); }
  async addListener(_name: string, listener: (event: SocketEvent) => void) {
    this.listeners.add(listener); return { remove: async () => { this.listeners.delete(listener); } };
  }
  async openSocket(options: Event) {
    this.opened.push(options); for (const listener of this.listeners) listener({ id: options.id, type: 'open' });
    this.emit({ type: 'session.created', session: {} }, options.id);
  }
  async sendSocket(options: { id: string; data: string }) {
    const event = JSON.parse(options.data); this.sent.push({ ...event, socketId: options.id });
    if (event.type === 'session.update' && this.autoReady) this.emit({ type: 'session.updated', session: event.session }, options.id);
    if (event.type === 'conversation.item.create') {
      this.lastItem.set(options.id, event.item);
      this.emit({ type: 'conversation.item.done', item: event.item }, options.id);
    }
    if (event.type === 'response.create') this.responses.push({ id: `response-${this.responses.length + 1}`, socketId: options.id, item: this.lastItem.get(options.id) });
  }
  async closeSocket(options: { id: string }) { this.closed.push(options.id); }
  async http(options: Event): Promise<{ status: number; body: string }> {
    return new Promise(resolve => { this.httpCalls.push({ ...options,
      complete: (text: string) => resolve({ status: 200, body: JSON.stringify({ model: 'qwen3.8-flash', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] }) }),
      fail: () => resolve({ status: 503, body: JSON.stringify({ error: { message: 'fixture unavailable' } }) }) }); });
  }
  created(response: Event) { this.emit({ type: 'response.created', response: { id: response.id } }, response.socketId); }
  tool(response: Event, protocol = 'qwen', status = 'completed') {
    this.created(response);
    const item = { id: `item-${response.id}`, type: 'function_call', call_id: `call-${response.id}`, name: 'lookup_patient_reply', arguments: '{"question":"本轮问题"}' };
    if (protocol === 'openai') this.emit({ type: 'response.output_item.added', response_id: response.id, item }, response.socketId);
    this.emit({ type: 'response.function_call_arguments.done', response_id: response.id, item_id: item.id, call_id: item.call_id,
      ...(protocol === 'qwen' ? { name: item.name } : {}), arguments: item.arguments }, response.socketId);
    this.emit({ type: 'response.done', response: { id: response.id, status, output: [item] } }, response.socketId);
  }
  voice(response: Event, text: string, protocol = 'qwen', finish = true) {
    this.created(response); const prefix = protocol === 'openai' ? 'response.output_audio' : 'response.audio';
    this.emit({ type: `${prefix}_transcript.delta`, response_id: response.id, item_id: `voice-${response.id}`, delta: text }, response.socketId);
    this.emit({ type: `${prefix}_transcript.done`, response_id: response.id, item_id: `voice-${response.id}`, transcript: text }, response.socketId);
    this.emit({ type: `${prefix}.delta`, response_id: response.id, item_id: `voice-${response.id}`, delta: 'AQACAA==' }, response.socketId);
    if (finish) this.emit({ type: 'response.done', response: { id: response.id, status: 'completed', output: [] } }, response.socketId);
  }
}

async function fixture(t: TestContext, protocol = 'qwen', extra: Event = {}) {
  const native = new FakeNative(), voice = profile(protocol), text = { ...profile(), id: 'text-qwen' };
  const settings = { mode: 'standalone', profiles: [voice, text], voiceProfileId: voice.id, textProfileId: text.id };
  let current: Session = { id: `local-${Math.random()}`, caseId: 'ruq-01', caseVersion: '1.1.0', caseTitle: '本地测试',
    createdAt: '2026-10-21T00:00:00.000Z', status: 'interview', turns: [turn('existing-confirmed-history')] };
  const owners = new Map<string, unknown>(), audio: Event[] = [], events: Event[] = []; let ends = 0;
  const services = {
    get: async () => structuredClone(current),
    addTurn: async (_id: string, value: Turn) => { assert.equal(current.status, 'interview', 'transcript writes must finish before commitEnd');
      const index = current.turns.findIndex(t => t.id === value.id); if (index < 0) current.turns.push(structuredClone(value)); else current.turns[index] = structuredClone(value); },
    appendAudio: async (_id: string, role: string, value: string, sampleRate: number) => { audio.push({ role, audio: value, sampleRate }); },
    flushAudio: async () => {}, commitEnd: async () => { ends++; current.status = 'summary'; return structuredClone(current); },
    patientReply: async (_settings: unknown, _id: string, question: string) => completeChat(text, '固定病例指令', question, { transport: native }),
    setRecordings: async (_id: string, recordings: { learner: boolean; patient: boolean }) => { current.recordings = recordings; },
    recordAudioFailure: async (_id: string, role: string, message: string) => { current.auditEvents = [...(current.auditEvents ?? []), {
      id: `audio-failure-${role}`, at: '2026-10-21T00:00:00.000Z', type: 'recording_incomplete', reason: `${role}: ${message}` }]; },
    sessionSettings: async (value: unknown) => value,
    claimVoice: async (id: string, owner: unknown) => { if (owners.has(id)) throw new Error('already owned'); owners.set(id, owner); },
    releaseVoice: async (id: string, owner: unknown) => { if (owners.get(id) === owner) owners.delete(id); },
  };
  const interview = new DirectInterview(settings, current.id, services, (event: Event) => events.push(event), { transport: native,
    finishMinimumMs: 10, finishGraceMs: 180, ...extra });
  t.after(async () => { await interview.close(); });
  await interview.connect();
  return { native, interview, settings, services, events, audio, owners, session: () => structuredClone(current), ends: () => ends,
    response: async (index: number) => until(() => native.responses[index]) };
}

test('direct realtime uses distinct documented Qwen and OpenAI schemas, rates, tools and reliable history', async t => {
  for (const protocol of ['qwen', 'openai']) {
    const native = new FakeNative(), events: Event[] = [];
    const client = new NativeRealtime(profile(protocol), { transport: native, instructions: '呈现层', tools: [{ type: 'function', function: { name: 'lookup', description: '病例', parameters: { type: 'object' } } }],
      history: [turn('keep-question'), turn('keep-answer', { role: 'patient', source: 'model', verification: 'matches_flash' }),
        turn('partial', { final: false }), turn('interrupted', { interrupted: true }), turn('unverified', { verification: 'paraphrase_unverified' })],
      onEvent: (event: Event) => events.push(event) });
    t.after(() => client.close()); await client.connect();
    const session = native.sent.find(e => e.type === 'session.update')!.session;
    assert.equal(client.inputSampleRate, protocol === 'qwen' ? 16000 : 24000);
    if (protocol === 'qwen') { assert.equal(session.input_audio_format, 'pcm'); assert.equal(session.enable_search, false); assert.equal(session.tools[0].function.name, 'lookup'); assert.equal(session.tool_choice, undefined); assert.equal(session.audio, undefined); }
    else { assert.equal(session.type, 'realtime'); assert.deepEqual(session.output_modalities, ['audio']); assert.equal(session.audio.input.format.rate, 24000); assert.equal(session.audio.output.format.rate, 24000); assert.equal(session.tools[0].name, 'lookup'); assert.equal(session.tools[0].function, undefined); assert.equal(session.modalities, undefined); }
    const restored = native.sent.filter(e => e.type === 'conversation.item.create').map(e => e.item.content[0].text);
    assert.deepEqual(restored, ['keep-question', 'keep-answer']); assert.equal(native.responses.length, 0);
    assert.equal(native.opened[0].profileId, `voice-${protocol}`); assert.equal(native.opened[0].headers, undefined);
  }
});

test('a voice probe only configures a session and always releases its native socket listener', async () => {
  const native = new FakeNative(); const result = await probeRealtime(profile(), { transport: native });
  assert.equal(result.ok, true); assert.equal(native.responses.length, 0); assert.equal(native.closed.length, 1); assert.equal(native.listeners.size, 0);
  const unsupported = await probeRealtime({ ...profile(), realtimeProtocol: 'none' }, { transport: native });
  assert.equal(unsupported.ok, false); assert.equal(native.opened.length, 1);
});

test('native failure classifications explain recovery without echoing untrusted messages, headers or keys', async t => {
  const malicious = { message: 'UNTRUSTED_NATIVE_MESSAGE sk-ws-fixture-credential', errorType: 'UNTRUSTED_EXCEPTION_TYPE',
    headers: { Authorization: 'Bearer opaque-fixture-credential', 'x-private-header': 'UNTRUSTED_HEADER_VALUE' },
    apiKey: 'UNTRUSTED_KEY_FIELD' };
  const cases = [
    { fields: { failureKind: 'timeout', stage: 'connected', timeoutKind: 'pong' }, beforeReady: false, expected: [/心跳/, /未获回应/, /重新连接/] },
    { fields: { failureKind: 'authentication', stage: 'handshake', httpStatus: 401 }, beforeReady: true, expected: [/鉴权被拒绝/, /HTTP 401/, /密钥与权限/] },
    { fields: { failureKind: 'authentication', stage: 'handshake', httpStatus: 403 }, beforeReady: true, expected: [/鉴权被拒绝/, /HTTP 403/, /密钥与权限/] },
    { fields: { failureKind: 'network', stage: 'connected' }, beforeReady: false, expected: [/连接中断/, /重新连接/] },
    { fields: { failureKind: 'untrusted-classification', stage: 'UNTRUSTED_STAGE', httpStatus: 'UNTRUSTED_STATUS' }, beforeReady: false, expected: [/网络或鉴权失败/] },
  ];
  for (const scenario of cases) {
    const native = new FakeNative(), events: Event[] = [];
    native.autoReady = !scenario.beforeReady;
    const client = new NativeRealtime(profile(), { transport: native, instructions: '本地分类测试。', onEvent: (event: Event) => events.push(event) });
    t.after(() => client.close());
    const connected = client.connect();
    const rejected = scenario.beforeReady ? assert.rejects(connected, (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const expected of scenario.expected) assert.match(error.message, expected);
      for (const value of ['UNTRUSTED_', 'fixture-credential', 'opaque-fixture']) assert.ok(!error.message.includes(value));
      return true;
    }) : undefined;
    if (scenario.beforeReady) await until(() => native.sent.some(event => event.type === 'session.update'));
    else await connected;
    const event = { id: native.opened[0].id, type: 'error' as const, ...scenario.fields, ...malicious };
    for (const listener of native.listeners) listener(event);
    if (rejected) await rejected;
    const forwarded = await until(() => events.find(event => event.type === 'error'));
    for (const expected of scenario.expected) assert.match(forwarded.error.message, expected);
    const visible = JSON.stringify(events);
    for (const value of ['UNTRUSTED_', 'sk-ws-fixture-credential', 'opaque-fixture-credential', 'Authorization', 'x-private-header'])
      assert.ok(!visible.includes(value), `native detail must not be forwarded: ${value}`);
    await until(() => native.closed.length === 1 && native.listeners.size === 0);
    assert.equal(client.isReady, false);
  }
});

test('both realtime protocols require tool -> selected chat HTTP -> matching function output before forwarding voice', async t => {
  for (const protocol of ['qwen', 'openai']) {
    const f = await fixture(t, protocol); f.interview.sendText('什么时候开始疼的？');
    f.native.tool(await f.response(0), protocol); const request = await until(() => f.native.httpCalls[0]);
    assert.equal(request.profileId, 'text-qwen'); assert.equal(JSON.parse(request.body).enable_thinking, false);
    request.complete('昨天晚上开始疼的。');
    const spoken = await f.response(1); assert.equal(spoken.item.type, 'function_call_output');
    assert.equal(spoken.item.call_id, 'call-response-1'); assert.equal(JSON.parse(spoken.item.output).answer, '昨天晚上开始疼的。');
    f.native.voice(spoken, '昨天晚上开始疼的。', protocol);
    await until(() => f.events.find(e => e.type === 'audio'));
    await until(() => f.session().turns.find(turn => turn.role === 'patient' && turn.final));
    const patient = f.session().turns.find(turn => turn.role === 'patient')!;
    assert.equal(patient.verification, 'matches_flash'); assert.equal(f.audio.find(a => a.role === 'patient')?.sampleRate, 24000);
  }
});

test('unapproved realtime speech is never delivered or stored and its controller is released', async t => {
  const f = await fixture(t); f.interview.sendText('问题');
  f.native.voice(await f.response(0), '绕过病例工具的无依据回答。');
  await until(() => f.native.closed.length > 0 && !f.owners.size);
  assert.equal(f.events.filter(e => e.type === 'audio').length, 0);
  assert.ok(!f.session().turns.some(turn => turn.role === 'patient'));
  assert.ok(f.events.some(e => e.type === 'error')); assert.equal(f.session().status, 'interview');
});

test('an interrupted chat call cannot approve late audio or keep the next question locked', async t => {
  const f = await fixture(t); f.interview.sendText('旧问题'); f.native.tool(await f.response(0));
  const old = await until(() => f.native.httpCalls[0]); f.interview.interrupt();
  f.interview.sendText('新的问题'); f.native.tool(await f.response(1));
  const current = await until(() => f.native.httpCalls[1]); current.complete('新回答。');
  const spoken = await f.response(2); f.native.voice(spoken, '新回答。'); await until(() => f.events.find(e => e.type === 'audio'));
  old.complete('过期的旧回答。'); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.native.sent.filter(e => e.item?.type === 'function_call_output').length, 1);
  assert.ok(!f.session().turns.some(turn => turn.text === '过期的旧回答。')); assert.equal(f.native.closed.length, 0);
});

test('speech starting before an old tool-result response.created revokes it without disconnecting', async t => {
  const f = await fixture(t); f.interview.sendText('旧问题'); f.native.tool(await f.response(0));
  (await until(() => f.native.httpCalls[0])).complete('过期的获批回答。'); const old = await f.response(1);
  f.native.emit({ type: 'input_audio_buffer.speech_started', item_id: 'new-speech' });
  await until(() => f.events.find(e => e.type === 'speech_started'));
  f.native.voice(old, '过期的获批回答。'); await until(() => f.events.filter(e => e.type === 'response_done').length >= 2);
  assert.equal(f.events.filter(e => e.type === 'audio').length, 0); assert.equal(f.native.closed.length, 0);
  assert.ok(!f.events.some(e => e.type === 'error')); assert.ok(!f.session().turns.some(turn => turn.text === '过期的获批回答。'));
});

test('cancelled tool arguments never call the text provider and a busy rejected question is not recorded', async t => {
  const f = await fixture(t); f.interview.sendText('已接受问题');
  assert.throws(() => f.interview.sendText('未接受问题'), /生成回答/);
  f.native.tool(await f.response(0), 'qwen', 'cancelled'); await until(() => f.events.find(e => e.type === 'response_done'));
  assert.equal(f.native.httpCalls.length, 0); assert.ok(!f.session().turns.some(turn => turn.text === '未接受问题'));
});

test('patient paraphrases stay unconfirmed, and playback interruption also revokes an already generated turn', async t => {
  const f = await fixture(t, 'openai'); f.interview.sendText('问题'); f.native.tool(await f.response(0), 'openai');
  (await until(() => f.native.httpCalls[0])).complete('昨天开始疼痛。'); const spoken = await f.response(1);
  f.native.voice(spoken, '昨天开始疼的。', 'openai');
  await until(() => f.events.find(e => e.type === 'quality_warning'));
  const patient = await until(() => f.session().turns.find(turn => turn.role === 'patient'));
  assert.equal(patient.final, false); assert.equal(patient.verification, 'paraphrase_unverified');
  f.interview.interruptPlayback(`voice-${spoken.id}`, 120);
  await until(() => f.native.sent.find(e => e.type === 'conversation.item.truncate'));
  assert.equal(f.native.sent.find(e => e.type === 'conversation.item.truncate')?.audio_end_ms, 120);
  await until(() => f.session().turns.find(turn => turn.role === 'patient' && turn.interrupted));
});

test('finish seals VAD at the selected rate, drains delayed final ASR, shares one commit and releases ownership', async t => {
  const f = await fixture(t, 'openai', { finishGraceMs: 300 });
  f.interview.sendAudio('AQACAA==');
  f.native.emit({ type: 'input_audio_buffer.speech_started', item_id: 'last-question' });
  f.native.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'last-question', delta: '有没有' });
  await until(() => f.events.find(e => e.type === 'turn' && !e.turn.final));
  const first = f.interview.finish(), second = f.interview.finish(); assert.equal(first, second);
  setTimeout(() => f.native.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'last-question', transcript: '有没有药物过敏？' }), 60);
  const ended = await first; assert.equal(ended.status, 'summary'); assert.equal(f.ends(), 1); assert.equal(f.owners.size, 0);
  const tail = f.native.sent.filter(e => e.type === 'input_audio_buffer.append').at(-1)!;
  assert.equal(atob(tail.audio).length, 24000 * 2 * 0.8); assert.ok(!f.native.sent.some(e => e.type === 'input_audio_buffer.commit'));
  assert.ok(ended.turns.some((turn: Turn) => turn.text === '有没有药物过敏？' && turn.final)); assert.equal(f.native.listeners.size, 0);
  assert.equal(f.audio.find(a => a.role === 'learner')?.sampleRate, 24000);
});

test('a current text-provider error closes the socket and releases the interview without ending it', async t => {
  const f = await fixture(t); f.interview.sendText('问题'); f.native.tool(await f.response(0));
  (await until(() => f.native.httpCalls[0])).fail();
  await until(() => f.native.closed.length > 0 && !f.owners.size);
  assert.equal(f.session().status, 'interview'); assert.equal(f.native.listeners.size, 0); assert.ok(f.events.some(e => e.type === 'error'));
});

test('reconnection resolves frozen session profiles before validating a changed or disabled default', async t => {
  const f = await fixture(t, 'qwen'); await f.interview.close();
  const changed = { ...f.settings, profiles: [{ ...profile('openai'), realtimeProtocol: 'none' }], voiceProfileId: 'no-longer-selected' };
  let frozenBeforeClaim = false;
  const services = { ...f.services, sessionSettings: async (incoming: unknown) => { assert.equal(incoming, changed); frozenBeforeClaim = true; return f.settings; },
    claimVoice: async (id: string, owner: unknown) => { assert.equal(frozenBeforeClaim, true); await f.services.claimVoice(id, owner); } };
  const resumed = new DirectInterview(changed, f.session().id, services, () => {}, { transport: f.native });
  t.after(() => resumed.close()); await resumed.connect();
  assert.equal(resumed.inputSampleRate, 16000); assert.equal(resumed.profile.realtimeModel, 'qwen-audio-3.1-realtime-plus');
  assert.equal(f.native.opened.at(-1)!.profileId, 'voice-qwen');
});

test('finish ignores a late text result and prevents storage writes after the summary has been committed', async t => {
  const f = await fixture(t); f.interview.sendText('即将结束的问题'); f.native.tool(await f.response(0));
  const request = await until(() => f.native.httpCalls[0]); const ended = await f.interview.finish();
  assert.equal(ended.status, 'summary'); assert.equal(f.owners.size, 0);
  request.complete('结束后到达的过期患者回答。'); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.native.sent.filter(e => e.item?.type === 'function_call_output').length, 0);
  assert.ok(!f.session().turns.some(turn => turn.text === '结束后到达的过期患者回答。')); assert.equal(f.ends(), 1);
});

test('a realtime ready timeout releases socket resources instead of leaving a hanging voice lease', async () => {
  const native = new FakeNative(); native.autoReady = false;
  const result = await probeRealtime(profile(), { transport: native, readyTimeoutMs: 30 });
  assert.equal(result.ok, false); assert.match(result.message, /超时/); assert.equal(native.listeners.size, 0); assert.equal(native.closed.length, 1);
});

test('a direct cloud failure stops recorder tracks, closes audio contexts and resets microphone state', async t => {
  const f = await fixture(t, 'openai'); await f.interview.close();
  const replacements: Record<string, unknown> = { window: { isSecureContext: true, AudioWorkletNode: function () {} },
    navigator: { mediaDevices: { getUserMedia: async () => ({}) } }, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(replacements)) { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); }
  t.after(() => { for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  const audioModule = new URL('../apps/mobile/src/audio.ts', import.meta.url).href;
  const { VoiceConnection } = await import(audioModule);
  let trackStops = 0, recorderQuits = 0, playerCloses = 0, inputRate = 0, recorderStatus = 'ended';
  const track = { enabled: true, applyConstraints: async () => {}, stop: () => { trackStops++; } };
  const inputContext = { state: 'running', close: async () => { inputContext.state = 'closed'; } };
  const outputContext = { state: 'running', close: async () => { playerCloses++; outputContext.state = 'closed'; } };
  const recorder = { stream: { getAudioTracks: () => [track], getTracks: () => [track] }, source: { context: inputContext },
    getStatus: () => recorderStatus, begin: async () => { recorderStatus = 'paused'; }, record: async () => { recorderStatus = 'recording'; },
    pause: async () => { recorderStatus = 'paused'; }, quit: async () => { recorderQuits++; recorderStatus = 'ended'; } };
  const player = { context: outputContext, stream: null, analyser: null, connect: async () => {}, add16BitPCM: () => {} };
  const states: Event[] = [];
  const voice = new VoiceConnection({ state: (state: Event) => states.push(state), turn: () => {}, ended: () => {} }, {
    services: f.services, transport: f.native, createRecorder: (rate: number) => { inputRate = rate; return recorder; }, createPlayer: () => player,
  });
  t.after(() => voice.close()); await voice.connect(f.settings, f.session().id);
  assert.equal(inputRate, 24000); assert.equal(states.at(-1)!.microphone, 'listening');
  voice.sendText('触发当前模型错误的问题'); f.native.tool(await f.response(0), 'openai');
  (await until(() => f.native.httpCalls[0])).fail();
  await until(() => states.at(-1)!.connection === 'disconnected' && trackStops > 0 && !f.owners.size);
  assert.equal(states.at(-1)!.microphone, 'off'); assert.match(states.at(-1)!.error, /503/);
  assert.equal(inputContext.state, 'closed'); assert.equal(outputContext.state, 'closed'); assert.equal(playerCloses, 1);
  assert.equal(recorderQuits, 1); assert.equal(f.native.listeners.size, 0);
});

test('audio write and flush failures cannot poison confirmed text or trap the finish operation', async t => {
  const f = await fixture(t); f.services.appendAudio = async () => { throw new Error('injected audio storage failure'); };
  f.services.flushAudio = async () => { throw new Error('old failed audio task'); };
  f.interview.sendAudio('AQACAA==');
  f.native.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'confirmed-after-audio-error', transcript: '有没有药物过敏？' });
  await until(() => f.events.find(event => event.type === 'quality_warning'));
  await until(() => f.session().turns.find(turn => turn.text === '有没有药物过敏？' && turn.final));
  assert.equal(f.native.closed.length, 0, 'recording failure alone must not kill cloud transcription');
  const ended: Session = await f.interview.finish();
  assert.ok(ended.turns.some((turn: Turn) => turn.text === '有没有药物过敏？' && turn.final));
  assert.equal(ended.auditEvents?.filter(event => event.type === 'recording_incomplete').length, 1);
  assert.match(ended.auditEvents!.find(event => event.type === 'recording_incomplete')!.reason!, /learner/);
  assert.ok(!ended.recordings?.learner, 'a failed first audio write must not be advertised as an existing complete recording');
  assert.equal(ended.status, 'summary'); assert.equal(f.owners.size, 0);
});

test('closing after a recording failure still persists a visibly incomplete transcript and its audit', async t => {
  const f = await fixture(t); f.services.appendAudio = async () => { throw new Error('injected audio storage failure'); };
  f.interview.sendAudio('AQACAA==');
  f.native.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'partial-at-close', delta: '这句尚未确认' });
  await until(() => f.events.find(event => event.type === 'turn' && event.turn.text === '这句尚未确认'));
  await f.interview.close();
  const saved = f.session().turns.find(turn => turn.text === '这句尚未确认');
  assert.equal(saved?.final, false); assert.equal(f.session().status, 'interview');
  assert.ok(f.session().auditEvents?.some(event => event.type === 'recording_incomplete')); assert.equal(f.owners.size, 0);
});
