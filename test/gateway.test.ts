import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../server/app.ts';
import { listCases } from '../packages/core/src/cases.ts';
import type { Turn } from '../packages/core/src/types.ts';

const token = 'local-test-pairing';
const headers = { authorization: `Bearer ${token}` };
type Event = Record<string, any>;
interface UpstreamConnection {
  socket: WebSocket; events: Event[]; text: string; session: Event; responseId: string; responseCount: number;
  send: (event: Event) => void; start: () => void; complete: (text?: string) => void;
}
async function until<T>(pick: () => T | undefined | false, timeout = 3000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = pick(); if (value !== undefined && value !== false) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error('Local protocol test timed out');
}
async function fixture(t: TestContext, settings: {
  generate?: (connection: UpstreamConnection) => void; configError?: boolean;
  register?: (app: Awaited<ReturnType<typeof createApp>>['app']) => void;
} = {}) {
  const root = resolve('.cache', 'tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'gateway-'));
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  const connections: UpstreamConnection[] = [];
  upstream.on('connection', socket => {
    const connection: UpstreamConnection = {
      socket, events: [], text: '', session: {}, responseId: '', responseCount: 0,
      send: event => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); },
      start: () => {
        connection.responseId = `response_${connections.indexOf(connection)}_${++connection.responseCount}`;
        connection.send({ type: 'response.created', response: { id: connection.responseId } });
      },
      complete: (text = '这是本地模拟上游的回答。') => {
        const audio = connection.session.modalities?.includes('audio');
        const common = { response_id: connection.responseId, item_id: `item_${connection.responseId}` };
        connection.send({ type: audio ? 'response.audio_transcript.delta' : 'response.text.delta', delta: text, ...common });
        connection.send({ type: audio ? 'response.audio_transcript.done' : 'response.text.done', text, transcript: text, ...common });
        connection.send({ type: 'response.done', response: { id: connection.responseId, status: 'completed' } });
      },
    };
    connections.push(connection);
    socket.on('error', () => {});
    connection.send({ type: 'session.created', session: { model: 'qwen-audio-3.1-realtime-plus' } });
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString()); connection.events.push(event);
      if (event.type === 'session.update') {
        connection.session = event.session;
        connection.send(settings.configError ? { type: 'error', error: { message: 'Local configuration rejected' } }
          : { type: 'session.updated', session: event.session });
      }
      if (event.type === 'conversation.item.create') {
        connection.text = event.item.content?.[0]?.text ?? '';
        connection.send({ type: 'conversation.item.created', item: event.item });
      }
      if (event.type === 'response.create') {
        connection.start();
        if (settings.generate) settings.generate(connection); else connection.complete();
      }
      if (event.type === 'response.cancel') connection.send({ type: 'response.done', response: { id: connection.responseId, status: 'cancelled' } });
    });
  });
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const { app, store } = await createApp({ accessToken: token, dataDirectory: directory, serveStatic: false,
    qwen: { apiKey: 'local-placeholder', url: `ws://127.0.0.1:${address.port}/realtime`, model: 'qwen-audio-3.1-realtime-plus', voice: 'longanqian_v3.1' } });
  settings.register?.(app);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const clients = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of clients) socket.terminate();
    for (const connection of connections) connection.socket.terminate();
    await app.close();
    await new Promise<void>(resolveClose => upstream.close(() => resolveClose()));
    assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true });
  });
  const voice = async (sessionId: string) => {
    // Query parameters must not disable WebSocket's first-message authentication.
    const socket = new WebSocket(url.replace(/^http/, 'ws') + '/api/voice?transport=local-test');
    clients.add(socket); const events: Event[] = [];
    const closed = new Promise<number>(resolveClose => socket.on('close', code => resolveClose(code)));
    socket.on('error', () => {}); socket.on('message', raw => events.push(JSON.parse(raw.toString())));
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'connect', sessionId, token }));
    return { socket, events, closed,
      event: (type: string, start = 0) => until(() => events.slice(start).find(event => event.type === type)),
      send: (event: Event) => socket.send(JSON.stringify(event)),
    };
  };
  const create = () => store.create(listCases()[0].id);
  const seed = (id: string) => store.addTurn(id, { id: 'seed-question', role: 'learner', text: '您好，哪里不舒服？',
    at: new Date().toISOString(), source: 'typed', final: true } satisfies Turn);
  return { app, store, connections, voice, create, seed };
}

test('authentication exempts only the exact health route, and case previews hide feedback rubrics', async t => {
  const { app } = await fixture(t, { register: app => {
    app.get('/api/health-private', () => ({ secret: true }));
    app.get('/api/health/records', () => ({ secret: true }));
  } });
  assert.equal((await app.inject('/api/health?check=1')).statusCode, 200);
  for (const path of ['/api/cases', '/api/sessions', '/api/health-private', '/api/health/records'])
    assert.equal((await app.inject(path)).statusCode, 401, path);
  const cases = (await app.inject({ url: '/api/cases', headers })).json();
  assert.ok(cases.every((entry: Event) => !entry.rubric && !entry.facts));
});

test('busy voice input is not recorded; upstream errors close the client and release ownership', async t => {
  const { app, store, connections, voice, create } = await fixture(t, { generate: () => {} });
  const session = create(); const client = await voice(session.id);
  await client.event('ready'); await client.event('response_started');
  const first = await until(() => connections[0]);
  client.send({ type: 'text', text: '忙碌时未接纳的问题' });
  const error = await client.event('error'); assert.match(error.message, /already generating/);
  assert.ok(!store.get(session.id).turns.some(turn => turn.text === '忙碌时未接纳的问题'));
  first.complete(); await client.event('response_done');
  client.send({ type: 'text', text: '上游已接纳的问题' });
  await until(() => first.text === '上游已接纳的问题');
  first.send({ type: 'error', error: { message: 'Local upstream failure', code: 'fixture' } });
  assert.equal(await client.closed, 1011);
  assert.equal(store.get(session.id).status, 'interview');
  assert.ok(store.get(session.id).turns.some(turn => turn.text === '上游已接纳的问题'));
  const replacement = await voice(session.id); await replacement.event('ready');
  replacement.socket.close(); await replacement.closed;
  assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/end`, headers })).statusCode, 200);
});

test('an upstream transport close releases the controller so the learner can reconnect', async t => {
  const { store, connections, voice, create, seed } = await fixture(t);
  const session = create(); seed(session.id);
  const client = await voice(session.id); await client.event('ready');
  connections[0].socket.close(1011, 'fixture drop');
  assert.equal(await client.closed, 1011);
  const replacement = await voice(session.id); await replacement.event('ready');
  assert.equal(store.get(session.id).status, 'interview');
});

test('HTTP text holds exclusive ownership and cannot be ended before the response completes', async t => {
  const { app, store, connections, voice, create } = await fixture(t, { generate: () => {} });
  const session = create();
  const request = app.inject({ method: 'POST', url: `/api/sessions/${session.id}/text`, headers, payload: { text: 'HTTP问诊问题' } }).then(reply => reply);
  const upstream = await until(() => connections.find(connection => connection.text === 'HTTP问诊问题'));
  await until(() => store.get(session.id).turns.some(turn => turn.text === 'HTTP问诊问题'));
  assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/end`, headers })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/text`, headers, payload: { text: '重叠问题' } })).statusCode, 409);
  const other = await voice(session.id); assert.match((await other.event('error')).message, /活动连接/);
  other.socket.close(); await other.closed;
  upstream.complete('HTTP患者回答'); assert.equal((await request).statusCode, 200);
  assert.deepEqual(store.get(session.id).turns.map(turn => turn.text), ['HTTP问诊问题', 'HTTP患者回答']);
  assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/end`, headers })).statusCode, 200);
});

test('an HTTP setup failure records no unsent question and releases its text lock', async t => {
  const { app, store, create } = await fixture(t, { configError: true });
  const session = create();
  const response = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/text`, headers, payload: { text: '不应记录的问题' } });
  assert.equal(response.statusCode, 500); assert.deepEqual(store.get(session.id).turns, []);
  assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/end`, headers })).statusCode, 200);
});

test('concurrent finish requests share one final flush even if the downstream socket closes', async t => {
  const { app, store, connections, voice, create, seed } = await fixture(t);
  const session = create(); seed(session.id);
  const client = await voice(session.id); await client.event('ready'); const upstream = connections[0];
  upstream.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'last-asr', delta: '最后一个问题' });
  await client.event('turn');
  upstream.start();
  upstream.send({ type: 'response.audio_transcript.delta', item_id: 'interrupted-patient', response_id: upstream.responseId, delta: '尚未完整说完的回答' });
  await client.event('response_started');
  client.send({ type: 'finish' });
  await new Promise(resolveWait => setTimeout(resolveWait, 30));
  const first = app.inject({ method: 'POST', url: `/api/sessions/${session.id}/end`, headers }).then(reply => reply);
  const second = app.inject({ method: 'POST', url: `/api/sessions/${session.id}/end`, headers }).then(reply => reply);
  const other = await voice(session.id); assert.match((await other.event('error')).message, /活动连接/);
  other.socket.close(); await other.closed;
  client.socket.close(); await client.closed;
  assert.equal(upstream.socket.readyState, WebSocket.OPEN, 'finish must keep the upstream alive for final ASR');
  upstream.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'last-asr', transcript: '最后一个问题已经说完。' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200); assert.equal(a.json().endedAt, b.json().endedAt);
  const ended = store.get(session.id);
  assert.equal(ended.status, 'summary');
  assert.ok(ended.turns.some(turn => turn.text === '最后一个问题已经说完。' && turn.final));
  const partial = ended.turns.find(turn => turn.text === '尚未完整说完的回答');
  assert.equal(partial?.final, false); assert.equal(partial?.interrupted, true);
});

test('session routes cannot expose or generate feedback before summary submission', async t => {
  const { app, connections, create, seed } = await fixture(t);
  const session = create(); seed(session.id);
  assert.equal((await app.inject({ url: `/api/sessions/${session.id}`, headers })).json().feedback, undefined);
  const body = { history: '患者自述疼痛，需要继续核实完整病史。', reasoning: '目前依据不足。', plan: '继续核实。', uncertainty: '检查未知。' };
  assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/summary`, headers, payload: body })).statusCode, 409);
  const exported = (await app.inject({ url: `/api/sessions/${session.id}/export`, headers })).json();
  assert.equal(exported.feedback, undefined); assert.equal(connections.length, 0);
});

test('ending while the last utterance is active seals VAD and preserves a delayed final ASR', async t => {
  const { store, connections, voice, create, seed } = await fixture(t);
  const session = create(); seed(session.id);
  const client = await voice(session.id); await client.event('ready');
  const upstream = connections[0];
  upstream.send({ type: 'input_audio_buffer.speech_started', item_id: 'last-spoken-question' });
  upstream.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'last-spoken-question', delta: '还想问您' });
  await client.event('speech_started');
  client.send({ type: 'audio', audio: Buffer.from([1, 0, 2, 0]).toString('base64') });
  await until(() => upstream.events.some(event => event.type === 'input_audio_buffer.append'));
  let sealed = false;
  upstream.socket.on('message', raw => {
    const event = JSON.parse(raw.toString());
    if (event.type !== 'input_audio_buffer.append' || sealed) return;
    const bytes = Buffer.from(event.audio, 'base64');
    if (bytes.length < 16000 || bytes.some(byte => byte !== 0)) return;
    sealed = true;
    setTimeout(() => upstream.send({ type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'last-spoken-question', transcript: '还想问您有没有药物过敏。' }), 1100);
  });
  client.send({ type: 'finish' });
  await client.event('session_ended');
  assert.equal(sealed, true);
  assert.ok(!upstream.events.some(event => event.type === 'input_audio_buffer.commit'));
  assert.ok(store.get(session.id).turns.some(turn => turn.text === '还想问您有没有药物过敏。' && turn.final));
});
