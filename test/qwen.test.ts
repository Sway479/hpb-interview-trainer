import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { QwenRealtime, type QwenOptions, type QwenToolDefinition } from '../server/qwen.ts';
import type { Turn } from '../packages/core/src/types.ts';

type Event = Record<string, any>;
const tools: QwenToolDefinition[] = [{ type: 'function', function: {
  name: 'lookup_patient_reply', description: '读取固定病例内的患者回答。', parameters: {
    type: 'object', properties: { question: { type: 'string' } }, required: ['question'],
  },
} }];

async function until<T>(pick: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = pick(); if (result !== undefined && result !== false) return result;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error('Local Qwen protocol test timed out');
}

async function fixture(t: TestContext, toolDefinitions: QwenToolDefinition[] | undefined = tools, history: Turn[] = []) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const received: Event[] = [], forwarded: Event[] = [];
  let upstream: WebSocket | undefined, responseId = '', counter = 0;
  const send = (event: Event) => { if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event)); };
  server.on('connection', socket => {
    upstream = socket; socket.on('error', () => {});
    send({ type: 'session.created', session: { model: 'qwen-audio-3.1-realtime-plus' } });
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString()); received.push(event);
      if (event.type === 'session.update') send({ type: 'session.updated', session: event.session });
      if (event.type === 'conversation.item.create') send({ type: 'conversation.item.created', item: event.item });
      if (event.type === 'response.create') {
        responseId = `response_${++counter}`;
        send({ type: 'response.created', response: { id: responseId } });
      }
    });
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options: QwenOptions = { apiKey: 'local-qwen-fixture', url: `ws://127.0.0.1:${address.port}/realtime`,
    model: 'qwen-audio-3.1-realtime-plus', voice: 'longanqian_v3.1' };
  const client = new QwenRealtime(options, { instructions: '固定病例患者。', tools: toolDefinitions, history, onEvent: event => forwarded.push(event) });
  t.after(async () => {
    client.close(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  });
  const done = async (status = 'completed') => {
    const current = await until(() => received.filter(event => event.type === 'response.create').length === counter && counter > 0 && responseId);
    send({ type: 'response.done', response: { id: current, status } });
  };
  await client.connect();
  return { client, options, received, forwarded, send, done };
}

test('Qwen configures documented tools and passes tool arguments through without automatic execution', async t => {
  const { client, received, forwarded, send, done } = await fixture(t);
  const session = received.find(event => event.type === 'session.update')!.session;
  assert.deepEqual(session.tools, tools); assert.equal(session.enable_search, false);
  assert.equal(session.tool_choice, undefined);
  const first = client.queueText('疼痛是什么时候开始的？');
  await until(() => forwarded.find(event => event.type === 'response.created'));
  const args = { type: 'response.function_call_arguments.done', response_id: 'response_1', item_id: 'tool_item_1',
    call_id: 'call_001', name: 'lookup_patient_reply', arguments: '{"question":"疼痛是什么时候开始的？"}' };
  send(args);
  assert.deepEqual(await until(() => forwarded.find(event => event.type === args.type)), args);
  assert.equal(received.filter(event => event.type === 'response.create').length, 1, 'the adapter must not start an automatic tool response');
  assert.throws(() => client.queueToolResult('call_001', '{}'), /already generating/);
  await done(); await first; assert.equal(client.isBusy, false);

  const output = '{"reply":"昨天晚上开始疼的。","source":"fixed_case"}';
  const second = client.queueToolResult('call_001', output);
  assert.equal(client.isBusy, true);
  assert.throws(() => client.queueText('重叠文字'), /already generating/);
  assert.throws(() => client.queueToolResult('call_002', '{}'), /already generating/);
  const result = await until(() => received.find(event => event.type === 'conversation.item.create' && event.item.type === 'function_call_output'));
  assert.deepEqual(result.item, { type: 'function_call_output', call_id: 'call_001', output });
  assert.equal(received.filter(event => event.type === 'response.create').length, 2);
  let settled = false; void second.then(() => { settled = true; });
  await new Promise(resolveWait => setTimeout(resolveWait, 20)); assert.equal(settled, false);
  await done(); await second; assert.equal(client.isBusy, false);
  assert.throws(() => client.queueToolResult(' ', '{}'), /must not be empty/);
});

test('Qwen rejects pending tool output on an upstream error and strips credential or header echoes', async t => {
  const { client, options, forwarded, send } = await fixture(t);
  const result = client.queueToolResult('call_error', '{"reply":"本地测试"}');
  const rejection = assert.rejects(result, error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes(options.apiKey)); return true;
  });
  send({ type: 'error', error: { code: 'test_error', message: `Rejected ${options.apiKey}`, headers: { authorization: 'never-forward-this' } } });
  await rejection;
  const event = await until(() => forwarded.find(event => event.type === 'error'));
  assert.equal(event.error.headers, undefined); assert.ok(!JSON.stringify(event).includes(options.apiKey));
  assert.throws(() => client.queueToolResult('call_after_close', '{}'), /not ready/);
});

test('Qwen ordinary sessions omit tools and keep the original sendText Promise semantics', async t => {
  const { client, received, done } = await fixture(t, []);
  assert.equal(received.find(event => event.type === 'session.update')!.session.tools, undefined);
  const pending = client.sendText('普通问题');
  await assert.rejects(client.sendText('重叠问题'), /already generating/);
  await done(); await pending;
  client.close(); await assert.rejects(client.sendText('已关闭连接的问题'), /not ready/);
});

test('Qwen reconnect restores only reliable confirmed dialogue and never generates from history insertion', async t => {
  const turn = (id: string, extra: Partial<Turn> = {}): Turn => ({ id, role: 'patient', text: id,
    source: 'model', at: '2026-10-21T00:00:00.000Z', final: true, ...extra });
  const history = [turn('confirmed-question', { role: 'learner', source: 'asr' }), turn('legacy-confirmed-answer'),
    turn('flash-confirmed-answer', { verification: 'matches_flash' }), turn('partial-answer', { final: false }),
    turn('interrupted-answer', { interrupted: true }), turn('unverified-answer', { verification: 'paraphrase_unverified' }),
    turn('empty-answer', { text: '  ' })];
  const { client, received } = await fixture(t, [], history);
  const restored = received.filter(event => event.type === 'conversation.item.create').map(event => event.item);
  assert.deepEqual(restored.map(item => ({ role: item.role, content: item.content })), [
    { role: 'user', content: [{ type: 'input_text', text: 'confirmed-question' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'legacy-confirmed-answer' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'flash-confirmed-answer' }] },
  ]);
  assert.equal(client.isBusy, false);
  assert.equal(received.filter(event => event.type === 'response.create').length, 0);
});
