import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../server/app.ts';
import { listCases } from '../packages/core/src/cases.ts';

type Event = Record<string, any>;
interface FlashRequest { body: Event; reply: ServerResponse; complete: (answer: string) => void; fail: () => void }
interface VoiceResponse { id: string; item: Event }
interface VoiceConnection {
  socket: WebSocket; events: Event[]; responses: VoiceResponse[];
  send: (event: Event) => void; created: (response: VoiceResponse) => void;
  voice: (response: VoiceResponse, text: string) => void; done: (response: VoiceResponse, status?: string) => void;
}
async function until<T>(pick: () => T | undefined | false, message = 'Local dual-model protocol timed out'): Promise<T> {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    const value = pick(); if (value !== undefined && value !== false) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error(message);
}

async function fixture(t: TestContext, mode: 'normal' | 'no_tool' | 'defer_tool_voice' = 'normal') {
  const root = resolve('.cache', 'tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'dual-'));
  const flashRequests: FlashRequest[] = [];
  const http = createServer(async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const complete = (answer: string) => {
      if (reply.writableEnded) return;
      reply.setHeader('Content-Type', 'application/json');
      reply.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }], model: 'qwen3.8-flash' }));
    };
    const fail = () => {
      if (reply.writableEnded) return;
      reply.statusCode = 503; reply.setHeader('Content-Type', 'application/json');
      reply.end(JSON.stringify({ error: { code: 'local_failure', message: 'Local Flash fixture failed' } }));
    };
    flashRequests.push({ body, reply, complete, fail });
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const voiceServer = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(voiceServer, 'listening');
  const connections: VoiceConnection[] = [];
  voiceServer.on('connection', socket => {
    let lastItem: Event = {};
    const connection: VoiceConnection = {
      socket, events: [], responses: [],
      send: event => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); },
      created: response => connection.send({ type: 'response.created', response: { id: response.id } }),
      voice: (response, text) => {
        const common = { response_id: response.id, item_id: `patient_${response.id}` };
        connection.send({ type: 'response.audio_transcript.delta', delta: text, ...common });
        connection.send({ type: 'response.audio.delta', delta: Buffer.from([0, 1, 0, 2, 0, 3, 0, 4]).toString('base64'), ...common });
        connection.send({ type: 'response.audio_transcript.done', transcript: text, ...common });
        connection.send({ type: 'response.audio.done', ...common });
      },
      done: (response, status = 'completed') => connection.send({ type: 'response.done', response: { id: response.id, status } }),
    };
    connections.push(connection); socket.on('error', () => {});
    connection.send({ type: 'session.created', session: { model: 'qwen-audio-3.1-realtime-plus' } });
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString()); connection.events.push(event);
      if (event.type === 'session.update') connection.send({ type: 'session.updated', session: event.session });
      if (event.type === 'conversation.item.create') {
        lastItem = event.item; connection.send({ type: 'conversation.item.created', item: lastItem });
      }
      if (event.type === 'response.create') {
        const response = { id: `response_${connections.indexOf(connection)}_${connection.responses.length + 1}`, item: lastItem };
        connection.responses.push(response);
        if (lastItem.type === 'function_call_output') {
          if (mode === 'defer_tool_voice') return;
          connection.created(response); connection.voice(response, JSON.parse(lastItem.output).answer); connection.done(response);
        } else {
          connection.created(response);
          if (mode === 'no_tool') {
            connection.voice(response, '未经Flash返回的患者陈述。'); connection.done(response);
          } else {
            connection.send({ type: 'response.function_call_arguments.done', response_id: response.id,
              item_id: `tool_${response.id}`, call_id: `call_${response.id}`, name: 'lookup_patient_reply',
              arguments: JSON.stringify({ question: lastItem.content?.[0]?.text ?? '当前语音问题' }) });
            connection.done(response);
          }
        }
      }
      if (event.type === 'response.cancel') {
        const latest = connection.responses.at(-1); if (latest) connection.done(latest, 'cancelled');
      }
    });
  });
  const httpAddress = http.address(), voiceAddress = voiceServer.address();
  assert.ok(httpAddress && typeof httpAddress !== 'string'); assert.ok(voiceAddress && typeof voiceAddress !== 'string');
  const { app, store } = await createApp({ serveStatic: false, dataDirectory: directory,
    qwen: { apiKey: 'local-voice-placeholder', url: `ws://127.0.0.1:${voiceAddress.port}/realtime`, model: 'qwen-audio-3.1-realtime-plus', voice: 'longanqian_v3.1' },
    flash: { apiKey: 'local-flash-placeholder', url: `http://127.0.0.1:${httpAddress.port}/compatible-mode/v1`, model: 'qwen3.8-flash' } });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const request of flashRequests) request.fail();
    for (const connection of connections) connection.socket.terminate();
    await app.close();
    await new Promise<void>(resolveClose => voiceServer.close(() => resolveClose()));
    await new Promise<void>(resolveClose => { http.close(() => resolveClose()); http.closeAllConnections(); });
    assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true });
  });
  const session = store.create(listCases()[0].id);
  // A saved opening avoids using any fabricated local greeting as a model response.
  store.addTurn(session.id, { id: 'seed', role: 'learner', text: '先前已确认的问题。', at: new Date().toISOString(), source: 'typed', final: true });
  const connect = async () => {
    const socket = new WebSocket(url.replace(/^http/, 'ws') + '/api/voice'); clients.push(socket);
    const events: Event[] = []; let closeCode: number | undefined;
    const closed = new Promise<number>(resolveClose => socket.on('close', code => { closeCode = code; resolveClose(code); }));
    socket.on('error', () => {}); socket.on('message', raw => events.push(JSON.parse(raw.toString())));
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'connect', sessionId: session.id }));
    await until(() => events.find(event => event.type === 'ready'));
    return { socket, events, closed, get closeCode() { return closeCode; },
      send: (event: Event) => socket.send(JSON.stringify(event)),
      event: (type: string, offset = 0) => until(() => events.slice(offset).find(event => event.type === type)),
    };
  };
  return { app, store, session, connections, flashRequests, connect };
}

test('dual-model flow carries a documented tool call through Flash HTTP and back to voice audio', async t => {
  const { app, store, session, connections, flashRequests, connect } = await fixture(t);
  const client = await connect(); client.send({ type: 'text', text: '什么时候开始疼的？' });
  const request = await until(() => flashRequests[0]);
  assert.equal(request.body.model, 'qwen3.8-flash'); assert.equal(request.body.enable_thinking, false);
  assert.equal(request.body.messages.at(-1).content, '什么时候开始疼的？');
  request.complete('昨天晚上开始疼的。');
  await client.event('audio'); await client.event('reasoning_done', client.events.findIndex(event => event.type === 'reasoning_started'));
  const output = await until(() => connections[0].events.find(event => event.item?.type === 'function_call_output'));
  assert.equal(output.item.call_id, 'call_response_0_1');
  assert.deepEqual(JSON.parse(output.item.output), { answer: '昨天晚上开始疼的。', model: 'qwen3.8-flash' });
  assert.ok(store.get(session.id).turns.some(turn => turn.role === 'patient' && turn.text === '昨天晚上开始疼的。' && turn.final));
  assert.ok(store.get(session.id).modelCalls?.some(call => call.kind === 'patient_reply' && call.model === 'qwen3.8-flash'));
  const recording = await app.inject(`/api/sessions/${session.id}/audio?role=patient`);
  assert.equal(recording.statusCode, 200); assert.equal(recording.rawPayload.length, 52);
});

test('voice audio and transcript without a Flash tool call never reach the learner or saved record', async t => {
  const { store, session, flashRequests, connect } = await fixture(t, 'no_tool');
  const client = await connect(); client.send({ type: 'text', text: '本轮没有调用工具' });
  assert.equal(await client.closed, 1011);
  assert.equal(flashRequests.length, 0); assert.equal(client.events.filter(event => event.type === 'audio').length, 0);
  assert.ok(!store.get(session.id).turns.some(turn => turn.role === 'patient'));
  assert.equal(store.get(session.id).recordings?.patient, undefined);
});

test('a speech interruption revokes approval before a delayed old voice response is created', async t => {
  const { store, session, connections, flashRequests, connect } = await fixture(t, 'defer_tool_voice');
  const client = await connect(); client.send({ type: 'text', text: '旧问题' });
  const request = await until(() => flashRequests[0]); request.complete('旧问题的过期回答。');
  const connection = connections[0];
  const old = await until(() => connection.responses.find(response => response.item.type === 'function_call_output'));
  connection.send({ type: 'input_audio_buffer.speech_started', item_id: 'new-question', audio_start_ms: 0 });
  await client.event('speech_started');
  connection.created(old); connection.voice(old, '旧问题的过期回答。'); connection.done(old);
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(client.events.filter(event => event.type === 'audio').length, 0);
  assert.ok(!store.get(session.id).turns.some(turn => turn.text === '旧问题的过期回答。'));
  assert.equal(client.closeCode, undefined, 'a delayed interrupted response must not close the active interview');
  assert.ok(!client.events.some(event => event.type === 'error'));
  client.send({ type: 'text', text: '打断后继续的新问题' });
  const nextRequest = await until(() => flashRequests[1]); nextRequest.complete('新问题的回答。');
  const current = await until(() => connection.responses.find(response => response.item.type === 'function_call_output' && response.id !== old.id));
  connection.created(current); connection.voice(current, '新问题的回答。'); connection.done(current);
  await client.event('audio');
  assert.ok(store.get(session.id).turns.some(turn => turn.text === '新问题的回答。' && turn.final));
});

test('interrupting an in-flight Flash request admits the next typed question and discards its old answer', async t => {
  const { store, session, connections, flashRequests, connect } = await fixture(t);
  const client = await connect(); client.send({ type: 'text', text: '第一轮问题' });
  const old = await until(() => flashRequests[0]);
  client.send({ type: 'interrupt' }); await client.event('interrupted');
  const offset = client.events.length; client.send({ type: 'text', text: '打断后的新问题' });
  const acceptance = await until(() => client.events.slice(offset).find(event => event.type === 'error' || event.type === 'turn' && event.turn.text === '打断后的新问题'));
  assert.equal(acceptance.type, 'turn', 'an obsolete Flash request must not keep the current typed-input lock');
  const current = await until(() => flashRequests[1]);
  const currentOffset = client.events.length;
  // The current turn must finish its reasoning indicator while obsolete HTTP is still pending.
  current.complete('新问题的有效回答。');
  await client.event('audio');
  await client.event('reasoning_done', currentOffset);
  old.complete('第一轮的过期回答。');
  await until(() => (store.get(session.id).modelCalls?.filter(call => call.kind === 'patient_reply').length ?? 0) === 2);
  const outputs = connections[0].events.filter(event => event.item?.type === 'function_call_output');
  assert.equal(outputs.length, 1); assert.ok(outputs[0].item.output.includes('新问题的有效回答'));
  assert.ok(!store.get(session.id).turns.some(turn => turn.text === '第一轮的过期回答。'));
});

test('failure of an interrupted Flash request does not close the current voice connection', async t => {
  const { flashRequests, connect } = await fixture(t);
  const client = await connect(); client.send({ type: 'text', text: '将被打断的旧问题' });
  const old = await until(() => flashRequests[0]);
  client.send({ type: 'interrupt' }); await client.event('interrupted');
  old.fail(); await new Promise(resolveWait => setTimeout(resolveWait, 120));
  assert.equal(client.closeCode, undefined); assert.equal(client.socket.readyState, WebSocket.OPEN);
  assert.ok(!client.events.some(event => event.type === 'error'));
});

test('finish closes voice ownership and a late Flash result cannot reopen or append a patient turn', async t => {
  const { app, store, session, connections, flashRequests, connect } = await fixture(t);
  const client = await connect(); client.send({ type: 'text', text: '结束前的问题' });
  const old = await until(() => flashRequests[0]); client.send({ type: 'finish' });
  await client.event('session_ended'); assert.equal(await client.closed, 1000);
  await until(() => connections[0].socket.readyState === WebSocket.CLOSED);
  old.complete('结束之后不应出现的回答。'); await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(store.get(session.id).status, 'summary');
  assert.ok(!store.get(session.id).turns.some(turn => turn.text === '结束之后不应出现的回答。'));
  assert.equal(connections[0].events.filter(event => event.item?.type === 'function_call_output').length, 0);
  assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/end` })).statusCode, 200);
});

test('a current Flash error closes the client, preserves the interview, and allows reconnection', async t => {
  const { store, session, flashRequests, connect } = await fixture(t);
  const client = await connect(); client.send({ type: 'text', text: '当前Flash将失败' });
  const request = await until(() => flashRequests[0]); request.fail();
  assert.equal(await client.closed, 1011); assert.equal(store.get(session.id).status, 'interview');
  const next = await connect(); assert.equal(next.socket.readyState, WebSocket.OPEN);
});
