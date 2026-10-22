import { z } from 'zod';

export interface FlashOptions {
  apiKey: string;
  /** Full chat/completions URL, or its OpenAI-compatible /v1 base URL. */
  url: string;
  model: string;
}

export class FlashError extends Error {
  readonly statusCode = 502;
  constructor(message: string, readonly upstreamStatus?: number) { super(message); this.name = 'FlashError'; }
}

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const completionSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({ role: z.literal('assistant'), content: z.string().nullable(),
      tool_calls: z.array(z.unknown()).optional(), refusal: z.string().nullable().optional() }),
  })).min(1),
});

function redact(message: string, apiKey: string): string {
  const redacted = apiKey ? message.split(apiKey).join('[redacted]') : message;
  return redacted.replace(/sk-[^\s"'<>]+/g, '[redacted]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]').slice(0, 1200);
}

function endpointUrl(url: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { throw new FlashError('Flash HTTP 服务地址无效。'); }
  const localTest = endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !localTest) || endpoint.username || endpoint.password || endpoint.hash)
    throw new FlashError('Flash 需要不含嵌入凭证的 HTTPS 服务地址。');
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
  if (/\/v1$/.test(endpoint.pathname)) endpoint.pathname += '/chat/completions';
  if (!endpoint.pathname.endsWith('/chat/completions')) throw new FlashError('Flash 地址须为 OpenAI 兼容的 /v1 或 /chat/completions 入口。');
  return endpoint;
}

async function readBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new FlashError('Flash 响应超过大小上限。');
  }
  if (!response.body) throw new FlashError('Flash 返回空响应。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new FlashError('Flash 响应超过大小上限。');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** One nonstreaming, nonthinking HTTP request. The caller supplies and loads credentials. */
export async function completeFlash(options: FlashOptions, instructions: string, userText: string): Promise<string> {
  if (!options.apiKey?.trim() || !options.model?.trim()) throw new FlashError('Flash API 配置不完整。');
  if (!instructions.trim() || !userText.trim()) throw new FlashError('Flash 系统指令与输入不能为空。');
  const endpoint = endpointUrl(options.url);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'system', content: instructions }, { role: 'user', content: userText }],
        stream: false,
        // Official OpenAI-compatible HTTP extension; this is top-level, not extra_body.
        enable_thinking: false,
        enable_search: false,
        max_completion_tokens: 4096,
      }),
    });
    const body = await readBody(response);
    let payload: unknown;
    try { payload = JSON.parse(body); } catch {
      throw new FlashError(`Flash 返回无效 JSON（HTTP ${response.status}）。`, response.status);
    }
    const apiError = z.object({ error: z.object({ code: z.union([z.string(), z.number()]).optional(), message: z.string().optional() }) }).safeParse(payload);
    if (!response.ok || apiError.success) {
      const detail = apiError.success ? [apiError.data.error.code, apiError.data.error.message].filter(value => value !== undefined).join('：') : '';
      throw new FlashError(`Flash 请求失败（HTTP ${response.status}）${detail ? `：${redact(detail, options.apiKey)}` : '。'}`, response.status);
    }
    const result = completionSchema.safeParse(payload);
    if (!result.success) throw new FlashError('Flash 响应结构不符合 Chat Completions 协议。', response.status);
    const choice = result.data.choices[0];
    if (choice.finish_reason !== 'stop') throw new FlashError(`Flash 未返回完整文本（${redact(choice.finish_reason, options.apiKey)}）。`, response.status);
    if (choice.message.tool_calls?.length || choice.message.refusal) throw new FlashError('Flash 未返回可用的普通文本回答。', response.status);
    const text = choice.message.content?.trim();
    if (!text) throw new FlashError('Flash 返回的文本为空。', response.status);
    return text;
  } catch (error) {
    if (timedOut) throw new FlashError('Flash 请求超时，请重试。');
    if (error instanceof FlashError) throw new FlashError(redact(error.message, options.apiKey), error.upstreamStatus);
    // Do not expose fetch's request options, headers, body or raw network exception.
    throw new FlashError('Flash 网络请求未完成，请核对服务地址与网络连接。');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
