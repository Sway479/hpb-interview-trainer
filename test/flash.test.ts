import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { completeFlash, FlashError, type FlashOptions } from '../server/flash.ts';

async function httpFixture(t: TestContext, handler: (request: IncomingMessage, reply: ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections(); }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { apiKey: 'local-flash-fixture', url: `http://127.0.0.1:${address.port}/compatible-mode/v1`, model: 'qwen3.8-flash' } satisfies FlashOptions;
}
const completion = (content: unknown, finish_reason = 'stop') => ({
  model: 'qwen3.8-flash', choices: [{ message: { role: 'assistant', content }, finish_reason, index: 0 }],
});

test('Flash sends an official nonthinking Chat Completions request and returns completed text', async t => {
  let recorded: { path: string; body: any; authorized: boolean } | undefined;
  const options = await httpFixture(t, async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    recorded = { path: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString()), authorized: request.headers.authorization === 'Bearer local-flash-fixture' };
    reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(completion(' 本地病例内核回复。 ')));
  });
  assert.equal(await completeFlash(options, '系统约束', '学员问题'), '本地病例内核回复。');
  assert.equal(recorded?.path, '/compatible-mode/v1/chat/completions'); assert.equal(recorded?.authorized, true);
  assert.equal(recorded?.body.model, 'qwen3.8-flash'); assert.equal(recorded?.body.enable_thinking, false);
  assert.equal(recorded?.body.enable_search, false); assert.equal(recorded?.body.stream, false);
  assert.equal(recorded?.body.extra_body, undefined);
  assert.deepEqual(recorded?.body.messages, [{ role: 'system', content: '系统约束' }, { role: 'user', content: '学员问题' }]);
});

test('Flash provider errors expose the HTTP status while redacting echoed credentials', async t => {
  const options = await httpFixture(t, (_request, reply) => {
    reply.statusCode = 401; reply.setHeader('Content-Type', 'application/json');
    reply.end(JSON.stringify({ error: { code: 'InvalidApiKey', message: 'Rejected Bearer local-flash-fixture and sk-ws-fixture-only' } }));
  });
  await assert.rejects(completeFlash(options, '约束', '问题'), error => {
    assert.ok(error instanceof FlashError); assert.equal(error.upstreamStatus, 401); assert.equal(error.statusCode, 502);
    assert.ok(!error.message.includes(options.apiKey)); assert.ok(!error.message.includes('sk-ws-fixture-only'));
    assert.match(error.message, /\[redacted\]/); return true;
  });
});

test('Flash rejects malformed, empty, truncated and tool-call responses', async t => {
  let payload: unknown = {};
  const options = await httpFixture(t, (_request, reply) => { reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(payload)); });
  for (const entry of [{}, completion(''), completion('partial', 'length'), completion('filtered', 'content_filter'),
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'tools', tool_calls: [{}] } }] }]) {
    payload = entry;
    await assert.rejects(completeFlash(options, '约束', '问题'), FlashError);
  }
});

test('Flash does not follow HTTP redirects with credentials', async t => {
  let destinationRequests = 0;
  const options = await httpFixture(t, (request, reply) => {
    if (request.url === '/destination') { destinationRequests++; reply.end(JSON.stringify(completion('不应收到请求'))); return; }
    reply.statusCode = 302; reply.setHeader('Location', '/destination'); reply.end();
  });
  await assert.rejects(completeFlash(options, '约束', '问题'), /网络请求未完成/);
  assert.equal(destinationRequests, 0);
});

test('Flash bounds response size before buffering a declared oversized body', async t => {
  const options = await httpFixture(t, (_request, reply) => {
    reply.setHeader('Content-Length', 3 * 1024 * 1024); reply.end('x');
  });
  await assert.rejects(completeFlash(options, '约束', '问题'), /大小上限/);
});

test('Flash times out and aborts its pending request without contacting an external API', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = init.signal ?? undefined;
    signal?.addEventListener('abort', () => reject(new Error('Aborted fixture request')), { once: true });
  }));
  const result = assert.rejects(completeFlash({ apiKey: 'local-placeholder', model: 'qwen3.8-flash',
    url: 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions' }, '约束', '问题'), /请求超时/);
  t.mock.timers.tick(30_000); await result;
  assert.equal(signal?.aborted, true);
});
