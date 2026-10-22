import type { ProviderProfile } from './contracts';

export interface NativeHttp {
  http(options: { profileId: string; url: string; body: string; timeoutMs: number }): Promise<{ status: number; body: string }>;
}
export interface ChatResult {
  text: string; model: string; elapsedMs: number; requestId?: string; usage?: Record<string, number>;
}
export interface ChatOptions { purpose?: string; transport?: NativeHttp; timeoutMs?: number }

export function safeProviderMessage(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/sk-[^\s"'<>]+/gi, '[redacted]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]').slice(0, 1000);
}

export function chatEndpoint(profile: ProviderProfile): string {
  let url: URL;
  try { url = new URL(profile.chatUrl); } catch { throw new Error('文本 API 地址格式不正确。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new Error('文本 API 需要不含凭证或查询参数的 HTTPS 地址。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1/chat/completions';
  else if (/\/v1$/.test(url.pathname)) url.pathname += '/chat/completions';
  if (!url.pathname.endsWith('/chat/completions')) throw new Error('请填写 Chat Completions 完整入口或 /v1 基地址。');
  return url.toString();
}

/** Authentication is injected by Android; this module never accepts or reads an API key. */
export async function completeChat(profile: ProviderProfile, instructions: string, input: string, options: ChatOptions = {}): Promise<ChatResult> {
  if (!profile.id || !profile.chatModel.trim()) throw new Error('请选择已配置的文本模型。');
  if (!instructions.trim() || !input.trim()) throw new Error('模型指令与输入不能为空。');
  const url = chatEndpoint(profile);
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? (options.purpose === 'assessment' ? 90_000 : 30_000), 120_000));
  const maxTokens = options.purpose === 'assessment' ? 8192 : 1024;
  const body: Record<string, unknown> = {
    model: profile.chatModel, messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }], stream: false,
  };
  if (profile.company === 'qwen') Object.assign(body, { enable_thinking: false, enable_search: false, max_completion_tokens: maxTokens });
  else if (profile.company === 'deepseek') Object.assign(body, { thinking: { type: 'disabled' }, max_tokens: maxTokens });
  else if (profile.company === 'openai') body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  const transport = options.transport ?? (await import('./native-bridge')).HpbNative;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      transport.http({ profileId: profile.id, url, body: JSON.stringify(body), timeoutMs }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('模型请求超时，请重试。')), timeoutMs + 250); }),
    ]);
    if (typeof response.body !== 'string' || response.body.length > 2 * 1024 * 1024) throw new Error('模型响应为空或超过大小上限。');
    let data: any;
    try { data = JSON.parse(response.body); } catch { throw new Error(`模型返回无效 JSON（HTTP ${response.status}）。`); }
    if (response.status < 200 || response.status >= 300 || data?.error) {
      const detail = typeof data?.error?.message === 'string' ? `：${safeProviderMessage(data.error.message)}` : '';
      throw new Error(`模型请求失败（HTTP ${response.status}）${detail}`);
    }
    const choice = data?.choices?.[0];
    if (choice?.finish_reason !== 'stop') throw new Error('模型回答未完整生成，请重试。');
    const message = choice.message;
    if (message?.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim()
      || message.tool_calls?.length || message.refusal) throw new Error('模型未返回可用的普通文本回答。');
    const usage: Record<string, number> = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'])
      if (typeof data.usage?.[key] === 'number' && Number.isFinite(data.usage[key]) && data.usage[key] >= 0) usage[key] = data.usage[key];
    return { text: message.content.trim(), model: typeof data.model === 'string' && data.model ? data.model : profile.chatModel,
      elapsedMs: Date.now() - started, ...(typeof data.id === 'string' ? { requestId: data.id.slice(0, 200) } : {}),
      ...(Object.keys(usage).length ? { usage } : {}) };
  } catch (error) {
    // Native transport messages are deliberately not exposed: they may contain request internals.
    if (error instanceof Error && /^(?:模型|请选择|请填写|文本 API)/.test(error.message)) throw new Error(safeProviderMessage(error));
    throw new Error('模型网络请求未完成，请核对所选公司的密钥、API地址与网络。');
  } finally { if (timer) clearTimeout(timer); }
}

export function supportsRealtime(profile?: ProviderProfile): boolean {
  return Boolean(profile && profile.realtimeProtocol !== 'none' && profile.realtimeUrl && profile.realtimeModel);
}
