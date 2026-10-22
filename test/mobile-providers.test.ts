import test from 'node:test';
import assert from 'node:assert/strict';

// The client is typechecked with its browser tsconfig; loading by URL keeps NodeNext from reinterpreting that project.
const providerModule = new URL('../apps/mobile/src/platform/providers.ts', import.meta.url).href;
const { completeChat, chatEndpoint, supportsRealtime } = await import(providerModule);
const profile = (company = 'qwen') => ({ id: `profile-${company}`, name: company, company,
  chatUrl: `https://${company}.example/v1`, chatModel: company === 'qwen' ? 'qwen3.8-flash' : 'configured-model',
  realtimeProtocol: company === 'qwen' ? 'qwen' : company === 'openai' ? 'openai' : 'none',
  realtimeUrl: 'wss://voice.example/realtime', realtimeModel: 'configured-realtime-model', voice: 'configured-voice' });
const success = { id: 'request-123', model: 'resolved-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '有效回答。' } }],
  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, unexpected: 'do not persist' } };

test('mobile chat chooses provider-specific fields and sends only a native credential reference', async () => {
  for (const company of ['qwen', 'openai', 'deepseek', 'custom']) {
    let request: any;
    const transport = { http: async (options: any) => { request = options; return { status: 200, body: JSON.stringify(success) }; } };
    const result = await completeChat(profile(company), '固定病例指令。', '医生的问题。', { purpose: 'assessment', transport });
    assert.equal(request.profileId, `profile-${company}`);
    assert.equal(request.url, `https://${company}.example/v1/chat/completions`);
    assert.equal(request.headers, undefined); assert.equal(request.apiKey, undefined);
    const body = JSON.parse(request.body);
    assert.equal(body.stream, false); assert.equal(body.model, profile(company).chatModel);
    assert.deepEqual(body.messages, [{ role: 'system', content: '固定病例指令。' }, { role: 'user', content: '医生的问题。' }]);
    if (company === 'qwen') { assert.equal(body.enable_thinking, false); assert.equal(body.enable_search, false); assert.equal(body.max_completion_tokens, 8192); }
    else { assert.equal(body.enable_thinking, undefined); assert.equal(body.enable_search, undefined); }
    if (company === 'deepseek') { assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.max_tokens, 8192); }
    else assert.equal(body.thinking, undefined);
    if (company === 'openai') { assert.equal(body.max_completion_tokens, 8192); assert.equal(body.max_tokens, undefined); }
    if (company === 'custom') { assert.equal(body.max_tokens, 8192); assert.equal(body.max_completion_tokens, undefined); }
    assert.equal(result.text, '有效回答。'); assert.equal(result.model, 'resolved-model'); assert.equal(result.requestId, 'request-123');
    assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }); assert.ok(result.elapsedMs >= 0);
  }
});

test('mobile chat refuses incomplete, tool-only and malformed responses instead of grading or speaking them', async () => {
  for (const payload of [
    { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"items":[' } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '文本', tool_calls: [{}] } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '文本', refusal: 'blocked' } }] },
    { choices: [] },
  ]) await assert.rejects(completeChat(profile(), '规则', '问题', { transport: { http: async () => ({ status: 200, body: JSON.stringify(payload) }) } }));
  await assert.rejects(completeChat(profile(), '规则', '问题', { transport: { http: async () => ({ status: 200, body: '<html>bad</html>' }) } }), /无效 JSON/);
});

test('mobile provider errors redact API echoes and never expose native request internals', async () => {
  await assert.rejects(completeChat(profile(), '规则', '问题', { transport: { http: async () => ({ status: 401,
    body: JSON.stringify({ error: { message: 'Rejected sk-ws-fixture-secret and Bearer opaque-token' } }) }) } }), (error: any) => {
    assert.ok(!error.message.includes('fixture-secret')); assert.ok(!error.message.includes('opaque-token')); assert.match(error.message, /401/); return true;
  });
  await assert.rejects(completeChat(profile(), '规则', '问题', { transport: { http: async () => { throw new Error('Authorization Bearer confidential-native-request'); } } }),
    (error: any) => !error.message.includes('confidential-native-request'));
});

test('mobile request timeout is bounded without a native promise settling', async () => {
  const started = Date.now();
  await assert.rejects(completeChat(profile(), '规则', '问题', { timeoutMs: 100, transport: { http: async () => await new Promise(() => {}) } }), /超时/);
  assert.ok(Date.now() - started < 1500);
});

test('cloud endpoints reject embedded credentials and unsupported voice capabilities stay unavailable', () => {
  assert.equal(chatEndpoint({ ...profile('deepseek'), chatUrl: 'https://api.deepseek.com/chat/completions/' }), 'https://api.deepseek.com/chat/completions');
  for (const chatUrl of ['http://cloud.example/v1', 'https://user:secret@cloud.example/v1', 'https://cloud.example/v1?key=secret', 'https://cloud.example/v1#fragment'])
    assert.throws(() => chatEndpoint({ ...profile(), chatUrl }));
  assert.equal(supportsRealtime(profile('deepseek')), false); assert.equal(supportsRealtime(profile('custom')), false);
  assert.equal(supportsRealtime(profile('qwen')), true); assert.equal(supportsRealtime(profile('openai')), true);
});
