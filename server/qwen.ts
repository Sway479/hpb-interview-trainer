import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import type { Turn } from '../packages/core/src/types.ts';

/** The caller loads environment variables. Never send these options to a client. */
export interface QwenOptions {
  apiKey: string;
  url: string;
  model: string;
  voice: string;
}
export type QwenConfig = QwenOptions;

export interface QwenToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface QwenSessionOptions {
  instructions: string;
  history?: Turn[];
  mode?: 'voice' | 'text';
  tools?: QwenToolDefinition[];
  onEvent: (event: any) => void;
}

interface PendingResponse {
  resolve: () => void;
  reject: (error: Error) => void;
  responseId?: string;
  timer: ReturnType<typeof setTimeout>;
}

const READY_TIMEOUT_MS = 25_000;
const RESPONSE_TIMEOUT_MS = 60_000;

/** Qwen-Audio-Realtime's flat session schema, not the Qwen-Omni schema. */
export class QwenRealtime {
  private ws?: WebSocket;
  private connectPromise?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private ready = false;
  private closed = false;
  private configured = false;
  private historyStarted = false;
  private historyPending = new Set<string>();
  private responsePending?: PendingResponse;
  private responseId?: string;
  private busy = false;
  private cancelRequested = false;
  private cancelSent = false;

  constructor(private readonly options: QwenOptions, private readonly session: QwenSessionOptions) {}

  get isBusy(): boolean { return this.busy; }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Qwen connection is closed; create a new connection'));
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      try {
        if (!this.options.apiKey || !this.options.model) throw new Error('Qwen API configuration is incomplete');
        const endpoint = new URL(this.options.url);
        const localTestSocket = endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
        if ((endpoint.protocol !== 'wss:' && !localTestSocket) || endpoint.username || endpoint.password)
          throw new Error('Qwen endpoint must be a WebSocket URL without embedded credentials');
        endpoint.searchParams.set('model', this.options.model);
        this.ws = new WebSocket(endpoint, {
          headers: { Authorization: `Bearer ${this.options.apiKey}` },
          handshakeTimeout: 20_000,
          maxPayload: 16 * 1024 * 1024,
        });
        this.readyTimer = setTimeout(() => this.fail(new Error('Qwen session configuration timed out')), READY_TIMEOUT_MS);
        this.ws.on('message', (data: RawData) => this.receive(data));
        this.ws.on('unexpected-response', (_request, response) => {
          response.resume();
          this.fail(new Error(`Qwen WebSocket handshake failed (HTTP ${response.statusCode ?? 'unknown'})`));
        });
        this.ws.on('error', () => this.fail(new Error('Qwen WebSocket transport error')));
        this.ws.on('close', (code) => {
          if (!this.closed) this.fail(new Error(`Qwen WebSocket closed (${code})`));
        });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Qwen connection failed'));
      }
    });
    return this.connectPromise;
  }

  /** Base64 of raw little-endian PCM16, 16 kHz, mono; no WAV header. */
  sendAudio(base64: string): void {
    this.assertReady();
    if ((this.session.mode ?? 'voice') !== 'voice') throw new Error('Audio input requires a voice session');
    if (!base64) return;
    // The browser uses 20-40 ms frames. Bound individual frames and backpressure.
    if (base64.length > 512 * 1024) throw new Error('Qwen audio frame is too large');
    if ((this.ws?.bufferedAmount ?? 0) > 2 * 1024 * 1024) throw new Error('Qwen audio connection is congested');
    this.send({ type: 'input_audio_buffer.append', audio: base64 });
  }

  /** Resolves at response.done. An intentional cancellation is a normal completion. */
  sendText(text: string): Promise<void> {
    try {
      return this.queueText(text);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Synchronously reserves inference or throws; callers may persist only accepted input. */
  queueText(text: string): Promise<void> {
    this.assertReady();
    if (!text.trim()) throw new Error('Text must not be empty');
    return this.queueItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  }

  /** Call only after the tool-call response.done; this adapter does not execute tools. */
  queueToolResult(callId: string, output: string): Promise<void> {
    this.assertReady();
    if (!callId.trim()) throw new Error('Tool call ID must not be empty');
    return this.queueItem({ type: 'function_call_output', call_id: callId, output });
  }

  private queueItem(item: Record<string, unknown>): Promise<void> {
    this.assertReady();
    if (this.busy) throw new Error('Qwen is already generating a response');
    this.busy = true; // Reserve before the asynchronous response.created acknowledgment.
    this.cancelRequested = false;
    this.cancelSent = false;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Qwen response timed out')), RESPONSE_TIMEOUT_MS);
      this.responsePending = { resolve, reject, timer };
      try {
        this.send({
          type: 'conversation.item.create',
          item,
        });
        this.send({ type: 'response.create' });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Qwen request failed'));
      }
    });
  }

  /** The caller also stops/clears local playback immediately. */
  interrupt(): void {
    if (this.closed || !this.ready || !this.busy || this.cancelRequested) return;
    this.cancelRequested = true;
    // Cancel only an acknowledged inference; otherwise defer until response.created.
    // Keep busy until response.done confirms cancellation.
    this.sendCancellation();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.busy = false;
    this.clearReadyTimer();
    this.rejectReady?.(new Error('Qwen connection closed before ready'));
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    this.finishPending(new Error('Qwen connection closed'));
    this.historyPending.clear();
    const socket = this.ws;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    // terminate avoids an unbounded closing handshake, including while CONNECTING.
    socket.terminate();
  }

  private receive(data: RawData): void {
    if (this.closed) return;
    let event: any;
    try {
      event = JSON.parse(data.toString());
      if (!event || typeof event !== 'object' || typeof event.type !== 'string')
        throw new Error('Invalid event');
    } catch {
      this.fail(new Error('Qwen returned an invalid event'));
      return;
    }

    if (event.type === 'error') {
      const message = this.redact(typeof event.error?.message === 'string' ? event.error.message : 'Qwen API error');
      // Do not forward request/headers if a provider unexpectedly attaches them.
      const safeError: Record<string, unknown> = { message };
      for (const field of ['type', 'code', 'param', 'event_id']) {
        if (typeof event.error?.[field] === 'string') safeError[field] = this.redact(event.error[field]);
      }
      this.emit({ type: 'error', event_id: event.event_id, error: safeError });
      this.fail(new Error(message), false);
      return;
    }

    try {
      if (event.type === 'session.created' && !this.configured) {
        this.configured = true;
        this.send({ type: 'session.update', session: {
          modalities: this.session.mode === 'text' ? ['text'] : ['text', 'audio'],
          voice: this.options.voice,
          instructions: this.session.instructions,
          input_audio_format: 'pcm',
          output_audio_format: 'pcm',
          input_audio_transcription: { language: 'zh' },
          output_audio: { language: 'zh' },
          max_history_turns: 50,
          enable_search: false,
          ...(this.session.tools?.length ? { tools: this.session.tools } : {}),
          turn_detection: this.session.mode === 'text' ? null : {
            type: 'server_vad', threshold: 0.5, silence_duration_ms: 700,
          },
        } });
      } else if (event.type === 'session.updated' && this.configured && !this.historyStarted) {
        this.historyStarted = true;
        this.restoreHistory();
      } else if (event.type === 'conversation.item.created' && this.historyStarted && !this.ready) {
        this.historyPending.delete(event.item?.id);
        if (this.historyPending.size === 0) this.markReady();
      } else if (event.type === 'response.created') {
        this.busy = true;
        this.responseId = event.response?.id;
        if (this.responsePending && !this.responsePending.responseId)
          this.responsePending.responseId = this.responseId;
        this.sendCancellation();
      } else if (event.type === 'response.done') {
        const doneId = event.response?.id;
        if (!this.responseId || !doneId || this.responseId === doneId) {
          this.busy = false;
          this.responseId = undefined;
          this.cancelRequested = false;
          this.cancelSent = false;
        }
        if (this.responsePending && (!this.responsePending.responseId || !doneId || this.responsePending.responseId === doneId)) {
          const status = event.response?.status;
          this.finishPending(status === 'failed' || status === 'incomplete'
            ? new Error(`Qwen response ${status}`) : undefined);
        }
      }
      this.emit(event);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Qwen event processing failed'));
    }
  }

  private restoreHistory(): void {
    // 50 QA turns = at most 100 message items. Partial turns are not treated as final.
    const history = (this.session.history ?? []).filter(turn => turn.final && !turn.interrupted
      && turn.verification !== 'paraphrase_unverified' && turn.text.trim()).slice(-100);
    const items = history.map(turn => ({
      id: `history_${randomUUID().replaceAll('-', '')}`,
      type: 'message',
      role: turn.role === 'learner' ? 'user' : 'assistant',
      content: [{ type: turn.role === 'learner' ? 'input_text' : 'output_text', text: turn.text }],
    }));
    this.historyPending = new Set(items.map(item => item.id));
    for (const item of items) this.send({ type: 'conversation.item.create', item });
    // Inserting history must never trigger an unsolicited patient opening.
    if (items.length === 0) this.markReady();
  }

  private markReady(): void {
    this.ready = true;
    this.clearReadyTimer();
    this.resolveReady?.();
    this.resolveReady = undefined;
    this.rejectReady = undefined;
  }

  private sendCancellation(): void {
    if (this.cancelRequested && !this.cancelSent && this.responseId) {
      this.cancelSent = true;
      this.send({ type: 'response.cancel' });
    }
  }

  private assertReady(): void {
    if (!this.ready || this.closed || this.ws?.readyState !== WebSocket.OPEN)
      throw new Error('Qwen session is not ready');
  }

  private send(event: Record<string, unknown>): void {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) throw new Error('Qwen WebSocket is not open');
    this.ws.send(JSON.stringify({ event_id: `event_${randomUUID()}`, ...event }), error => {
      if (error && !this.closed) this.fail(new Error('Qwen WebSocket send failed'));
    });
  }

  private finishPending(error?: Error): void {
    const pending = this.responsePending;
    if (!pending) return;
    this.responsePending = undefined;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private fail(error: Error, notify = true): void {
    if (this.closed) return;
    const safeError = new Error(this.redact(error.message));
    if (notify) this.emit({ type: 'error', error: { type: 'connection_error', message: safeError.message } });
    this.rejectReady?.(safeError);
    this.rejectReady = undefined;
    this.finishPending(safeError);
    this.close();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }

  private redact(message: string): string {
    let safe = message;
    if (this.options.apiKey) safe = safe.split(this.options.apiKey).join('[redacted]');
    return safe.replace(/sk-[^\s"'<>]+/g, '[redacted]');
  }

  private emit(event: any): void {
    // Application callbacks own their errors; never log options, headers or event bodies.
    try { this.session.onEvent(event); } catch { /* Keep transport cleanup deterministic. */ }
  }
}

/** One fresh text-only session using the same configured realtime model. */
export async function completeText(options: QwenOptions, instructions: string, userText: string, onQueued?: () => void): Promise<string> {
  let output = '';
  let finalOutput = '';
  let status: string | undefined;
  const client = new QwenRealtime(options, {
    instructions, mode: 'text',
    onEvent: event => {
      if (event.type === 'response.text.delta') output += event.delta ?? '';
      if (event.type === 'response.text.done') finalOutput = event.text ?? '';
      if (event.type === 'response.done') {
        status = event.response?.status;
        if (!finalOutput) finalOutput = (event.response?.output ?? [])
          .flatMap((item: any) => item.content ?? [])
          .filter((content: any) => ['text', 'output_text'].includes(content.type))
          .map((content: any) => content.text ?? '').join('');
      }
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('Qwen text completion timed out')); client.close(); }, 60_000);
    });
    const request = async () => {
      await client.connect();
      const response = client.queueText(userText);
      // Attach immediately, including when persistence in onQueued throws.
      const guardedResponse = response.catch(error => { throw error; });
      try { onQueued?.(); } catch (error) {
        // Closing rejects the outstanding response; consume it before rethrowing.
        client.close();
        await guardedResponse.catch(() => undefined);
        throw error;
      }
      await guardedResponse;
      if (status && status !== 'completed') throw new Error(`Qwen text completion ${status}`);
      const text = (finalOutput || output).trim();
      if (!text) throw new Error('Qwen text completion returned no text');
      return text;
    };
    return await Promise.race([request(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    client.close();
  }
}
