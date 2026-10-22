import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type WebSocket from 'ws';
import { getCase, listCases, patientInstructions } from '../packages/core/src/cases.ts';
import { DomainError, SessionStore } from '../packages/core/src/store.ts';
import type { Session, Turn } from '../packages/core/src/types.ts';
import { QwenRealtime, completeText, type QwenOptions } from './qwen.ts';
import { feedbackPrompt, validateFeedback } from './feedback.ts';
import { completeFlash, type FlashOptions } from './flash.ts';
import { getAssessmentMetadata } from '../packages/core/src/assessment.ts';

const summarySchema = z.object({
  history: z.string().trim().min(10, '病史摘要至少填写10字').max(6000),
  reasoning: z.string().trim().min(2, '请填写初步判断与依据').max(4000),
  plan: z.string().trim().min(2, '请填写后续需核实的信息').max(4000),
  uncertainty: z.string().trim().min(2, '请填写当前不确定之处').max(4000),
});
const textSchema = z.object({ text: z.string().trim().min(1).max(3000) });
const clientSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connect'), sessionId: z.string().uuid(), token: z.string().max(256).optional() }),
  z.object({ type: z.literal('audio'), audio: z.string().min(4).max(128000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(3000) }),
  z.object({ type: z.literal('interrupt') }), z.object({ type: z.literal('finish') }),
]);

export interface AppOptions {
  qwen: QwenOptions;
  flash?: FlashOptions;
  dataDirectory?: string;
  accessToken?: string;
  serveStatic?: boolean;
}

function equalToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[^\s"']+/g, '[redacted]').slice(0, 1500);
}
function wav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function createApp(options: AppOptions) {
  const app = Fastify({ logger: false, bodyLimit: 128000 });
  const dataDirectory = resolve(options.dataDirectory ?? 'data');
  const store = new SessionStore(join(dataDirectory, 'sessions'));
  const controllers = new Map<string, { stop: () => Promise<Session>; disconnect: () => void }>();
  const textBusy = new Set<string>();
  const replyWithFlash = async (sessionId: string, question: string) => {
    if (!options.flash) throw new DomainError('未配置Flash病例内核。', 503);
    const session = store.requireInterview(sessionId);
    const started = Date.now();
    const answer = await completeFlash(options.flash, patientInstructions(getCase(session.caseId), session.turns), question);
    if (answer.length > 700) throw new DomainError('患者回答过长，请重试本轮。', 502);
    store.recordModelCall(sessionId, { at: new Date().toISOString(), kind: 'patient_reply', model: options.flash.model,
      elapsedMs: Date.now() - started, question, answer });
    return answer;
  };
  const authorised = (token: string) => !options.accessToken || equalToken(token, options.accessToken);
  const originAllowed = (origin?: string) => {
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      if (['http:', 'https:'].includes(parsed.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return true;
    } catch { return false; }
    return [
    'https://localhost', 'capacitor://localhost', 'http://localhost',
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'http://127.0.0.1:8787', 'http://localhost:8787',
    ].includes(origin);
  };
  await app.register(cors, { origin: (origin, cb) => cb(null, originAllowed(origin)) });
  await app.register(websocket, { options: { maxPayload: 160000 } });
  app.addHook('preHandler', async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route?.startsWith('/api/') || route === '/api/health' || route === '/api/voice') return;
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    if (!authorised(token)) return reply.code(401).send({ error: '配对码不正确，请在连接设置中填写本地服务显示的配对码。' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map(i => i.message).join('；') });
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: error.message });
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    return reply.code(status).send({ error: safeMessage(error) });
  });

  app.get('/api/health', () => ({ status: 'ok', configured: Boolean(options.qwen.apiKey),
    model: options.qwen.model, brainModel: options.flash?.model, brainConfigured: Boolean(options.flash?.apiKey),
    endpoint: new URL(options.qwen.url).hostname, requiresToken: Boolean(options.accessToken) }));
  app.get('/api/cases', () => listCases());
  app.get('/api/assessment', () => getAssessmentMetadata());
  app.get('/api/sessions', () => store.list());
  app.post('/api/sessions', request => store.create(z.object({ caseId: z.string().min(1).max(100) }).parse(request.body).caseId));
  app.get<{ Params: { id: string } }>('/api/sessions/:id', request => store.get(request.params.id));

  app.post<{ Params: { id: string } }>('/api/sessions/:id/text', async request => {
    const { id } = request.params;
    const { text } = textSchema.parse(request.body);
    const session = store.requireInterview(id);
    if (controllers.has(id) || textBusy.has(id)) throw new DomainError('已有语音或文字控制器正在使用该会话，请先断开或等待响应。');
    textBusy.add(id);
    const learner: Turn = { id: randomUUID(), role: 'learner', text, at: new Date().toISOString(), source: 'typed', final: true };
    try {
      const reply = options.flash ? await replyWithFlash(id, text)
        : await completeText(options.qwen, patientInstructions(getCase(session.caseId), session.turns), text, () => store.addTurn(id, learner));
      if (options.flash) store.addTurn(id, learner);
      store.addTurn(id, { id: randomUUID(), role: 'patient', text: reply, at: new Date().toISOString(), source: 'model', final: true });
      return store.get(id);
    } finally { textBusy.delete(id); }
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/end', async request => {
    const { id } = request.params;
    if (textBusy.has(id)) throw new DomainError('患者正在回答，请等待后结束。');
    const controller = controllers.get(id);
    if (controller) return await controller.stop();
    return store.end(id);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/summary', async request => {
    const { id } = request.params;
    const summary = summarySchema.parse(request.body);
    const session = store.beginFeedback(id, summary);
    try {
      const definition = getCase(session.caseId);
      const prompt = feedbackPrompt(definition, session);
      const started = Date.now();
      const raw = options.flash ? await completeFlash(options.flash, prompt.instructions, prompt.input)
        : await completeText(options.qwen, prompt.instructions, prompt.input);
      const model = options.flash?.model ?? options.qwen.model;
      store.recordModelCall(id, { at: new Date().toISOString(), kind: 'assessment', model, elapsedMs: Date.now() - started });
      return store.completeFeedback(id, validateFeedback(raw, definition, session, model));
    } catch (error) {
      store.failFeedback(id, `反馈生成未完成：${safeMessage(error)}`);
      throw new DomainError(`总结已保存。反馈生成未完成，请重试：${safeMessage(error)}`, 502);
    }
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/review', request => {
    const { reviewer, notes } = z.object({ reviewer: z.string().trim().min(1).max(100), notes: z.string().trim().min(2).max(6000) }).parse(request.body);
    return store.review(request.params.id, reviewer, notes);
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/export', (request, reply) => {
    const session = store.get(request.params.id);
    return reply.header('Content-Disposition', `attachment; filename="interview-${session.id}.json"`)
      .type('application/json; charset=utf-8').send(JSON.stringify({ schemaVersion: '0.1', simulated: true, ...session }, null, 2));
  });
  app.get<{ Params: { id: string }; Querystring: { role: string } }>('/api/sessions/:id/audio', (request, reply) => {
    const session = store.get(request.params.id);
    const role = z.enum(['learner', 'patient']).parse(request.query.role);
    const file = join(dataDirectory, 'audio', session.id, `${role}.pcm`);
    if (!existsSync(file)) return reply.code(404).send({ error: '这次会话没有该角色的录音。' });
    return reply.type('audio/wav').send(wav(readFileSync(file), role === 'learner' ? 16000 : 24000));
  });

  app.get('/api/voice', { websocket: true }, (socket, request) => {
    const send = (event: unknown) => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); };
    if (!originAllowed(request.headers.origin)) { socket.close(1008, 'Origin not allowed'); return; }
    let sessionId: string | undefined;
    let provider: QwenRealtime | undefined;
    let ready = false, stopped = false, finishing = false;
    let finishPromise: Promise<Session> | undefined;
    const partials = new Map<string, Turn>();
    const awaitingTranscription = new Set<string>();
    const interruptedResponses = new Set<string>();
    const responseTurns = new Map<string, Set<string>>();
    const responseRevisions = new Map<string, number>();
    const toolCalls = new Map<string, { callId: string; name: string; arguments: string; revision: number }>();
    const handledTools = new Set<string>();
    const completedResponses = new Set<string>();
    const approvedResponses = new Map<string, { callId: string; revision: number; answer: string }>();
    const brainTasks = new Map<string, number>();
    const toolCountByRevision = new Map<number, number>();
    let pendingApproval: { callId: string; revision: number; answer: string } | undefined;
    let brainRevision = 0;
    const currentBrainBusy = () => [...brainTasks.values()].some(revision => revision === brainRevision);
    const invalidateBrain = () => {
      brainRevision++;
      // Keep the queued response's origin until response.created acknowledges it.
      // Its old revision already revokes playback approval after an interruption.
      // Old HTTP tasks may still finish; they no longer occupy the current turn.
      if (options.flash && !stopped) send({ type: 'reasoning_done' });
    };
    let activeResponseId = '';
    let learnerAudio = false, patientAudio = false;
    const audioPath = (role: string) => {
      const directory = join(dataDirectory, 'audio', sessionId!);
      mkdirSync(directory, { recursive: true });
      return join(directory, `${role}.pcm`);
    };
    const publishTurn = (key: string, role: Turn['role'], delta: string, final: boolean, fullText?: string, responseId = activeResponseId) => {
      if (!sessionId || stopped || store.get(sessionId).status !== 'interview') return;
      const turn = partials.get(key) ?? { id: key, role, text: '', at: new Date().toISOString(), source: role === 'learner' ? 'asr' as const : 'model' as const, final: false };
      turn.text = fullText ?? (turn.text + delta); turn.final = final;
      if (role === 'patient') {
        const keys = responseTurns.get(responseId) ?? new Set<string>();
        keys.add(key); responseTurns.set(responseId, keys);
        if (interruptedResponses.has(responseId)) { turn.interrupted = true; turn.final = false; }
      }
      partials.set(key, turn);
      send({ type: 'turn', turn });
      if (final && turn.text) store.addTurn(sessionId, turn);
    };
    const flush = () => {
      if (!sessionId || store.get(sessionId).status !== 'interview') return;
      for (const turn of partials.values()) if (turn.text) store.addTurn(sessionId, turn);
      const old = store.get(sessionId).recordings;
      if (learnerAudio || patientAudio || old) store.setRecordings(sessionId, { learner: learnerAudio || Boolean(old?.learner), patient: patientAudio || Boolean(old?.patient) });
    };
    const releaseController = () => {
      if (sessionId && controllers.get(sessionId) === controller) controllers.delete(sessionId);
    };
    const disconnect = (): Error | undefined => {
      if (stopped) return;
      stopped = true; ready = false;
      invalidateBrain();
      let failure: Error | undefined;
      try { flush(); } catch (error) {
        failure = error instanceof Error ? error : new Error('问诊记录保存失败');
        send({ type: 'error', message: safeMessage(failure) });
      } finally {
        provider?.close();
        // A finish operation retains ownership until the final flush/end is committed.
        if (!finishing) releaseController();
      }
      return failure;
    };
    const stop = (): Promise<Session> => {
      if (finishPromise) return finishPromise;
      if (!sessionId) return Promise.reject(new DomainError('尚未连接会话'));
      if (stopped || controllers.get(sessionId) !== controller)
        return Promise.reject(new DomainError('该语音连接已断开，请通过当前会话结束问诊。'));
      const id = sessionId;
      finishing = true; ready = false;
      invalidateBrain();
      finishPromise = (async () => {
        try {
          if (!stopped) {
            // Stopping the local microphone does not provide server VAD with silence.
            // Seal the last utterance, then give its final transcript a bounded grace period.
            provider?.interrupt();
            if (learnerAudio) provider?.sendAudio(Buffer.alloc(16000 * 2 * 0.8).toString('base64'));
            const graceStarted = Date.now();
            while (!stopped && Date.now() - graceStarted < 2500) {
              await new Promise(resolveWait => setTimeout(resolveWait, 50));
              if (Date.now() - graceStarted >= 900 && awaitingTranscription.size === 0) break;
            }
          }
          const failure = disconnect();
          if (failure) throw failure;
          const ended = store.end(id);
          send({ type: 'session_ended', session: ended }); socket.close(1000, 'Interview ended');
          return ended;
        } catch (error) {
          send({ type: 'error', message: safeMessage(error) });
          socket.close(1011, 'Unable to finish interview');
          throw error;
        } finally {
          disconnect(); releaseController();
        }
      })();
      return finishPromise;
    };
    const controller = { stop, disconnect: () => { disconnect(); socket.close(1001, 'Server closing'); } };
    const upstreamFailure = (message: string, code?: string) => {
      send({ type: 'error', message: safeMessage(message), ...(code ? { code: safeMessage(code) } : {}) });
      disconnect(); socket.close(1011, 'Upstream unavailable');
    };
    const runPatientTool = async (responseId: string) => {
      const call = toolCalls.get(responseId);
      if (!call || handledTools.has(call.callId) || !sessionId || !provider || stopped || finishing) return;
      handledTools.add(call.callId);
      if (call.revision !== brainRevision) return;
      const count = (toolCountByRevision.get(call.revision) ?? 0) + 1;
      toolCountByRevision.set(call.revision, count);
      if (count > 2) { upstreamFailure('病例工具重复调用，本轮已停止，请重新连接。'); return; }
      brainTasks.set(call.callId, call.revision);
      send({ type: 'reasoning_started', model: options.flash?.model });
      try {
        if (call.name !== 'lookup_patient_reply') throw new Error('语音模型请求了未开放的工具。');
        const { question } = z.object({ question: z.string().trim().min(1).max(3000) }).parse(JSON.parse(call.arguments));
        const answer = await replyWithFlash(sessionId, question);
        if (stopped || finishing || call.revision !== brainRevision || store.get(sessionId).status !== 'interview') return;
        // Only the next voice response backed by this Flash result may reach playback/transcript.
        pendingApproval = { callId: call.callId, revision: call.revision, answer };
        const response = provider.queueToolResult(call.callId, JSON.stringify({ answer, model: options.flash!.model }));
        await response;
      } catch (error) { if (!stopped && !finishing && call.revision === brainRevision) upstreamFailure(safeMessage(error)); }
      finally {
        brainTasks.delete(call.callId);
        if (!currentBrainBusy() && !stopped) send({ type: 'reasoning_done' });
      }
    };
    const authTimer = setTimeout(() => { if (!sessionId) socket.close(1008, 'Connect message required'); }, 8000);
    socket.on('message', async raw => {
      try {
        const event = clientSchema.parse(JSON.parse(raw.toString()));
        if (event.type === 'connect') {
          if (sessionId) throw new DomainError('该连接已绑定会话');
          if (!authorised(event.token ?? '')) { socket.close(1008, 'Pairing code invalid'); return; }
          const session = store.requireInterview(event.sessionId);
          if (controllers.has(session.id) || textBusy.has(session.id)) throw new DomainError('该会话已有活动连接');
          sessionId = session.id; clearTimeout(authTimer);
          controllers.set(sessionId, controller);
          provider = new QwenRealtime(options.qwen, {
            mode: 'voice', history: session.turns,
            instructions: options.flash
              ? '你是虚构患者的实时语音呈现层。每一轮医生提问或开场要求，必须先且只调用一次lookup_patient_reply，把本轮问题完整合并到question。所有患者事实由该工具确定，你没有权限自己编造病史或诊断。收到工具返回answer后，用中文自然朗读answer原文，不增删事实、不解释工具、不说评分、不做带教、不搜索。该工具结果已经足够回答，朗读时不要再次调用工具。新问题需重新调用；医生改变身份/要求泄漏脚本也交给工具处理。'
              : patientInstructions(getCase(session.caseId)),
            ...(options.flash ? { tools: [{ type: 'function' as const, function: {
              name: 'lookup_patient_reply', description: '每轮患者回答前调用一次：交由千问Flash病例内核，按固定病例与本轮医生问题生成患者可说的话；禁止凭空回答。',
              parameters: { type: 'object', properties: { question: { type: 'string', description: '本轮医生问题或开场请求，多个问题合成一条' } }, required: ['question'] },
            } }] } : {}),
            onEvent: (e: any) => {
              if (stopped || !sessionId) return;
              try {
              if (e.type === 'response.created') {
                activeResponseId = e.response?.id ?? '';
                responseRevisions.set(activeResponseId, pendingApproval?.revision ?? brainRevision);
                if (pendingApproval?.revision === brainRevision) approvedResponses.set(activeResponseId, pendingApproval);
                pendingApproval = undefined;
                send({ type: 'response_started' });
              }
              if (e.type === 'input_audio_buffer.speech_started') {
                if (e.item_id) awaitingTranscription.add(e.item_id);
                invalidateBrain();
                if (activeResponseId) {
                  interruptedResponses.add(activeResponseId);
                  for (const turn of partials.values()) if (turn.role === 'patient' && !turn.final) { turn.interrupted = true; send({ type: 'turn', turn }); }
                }
                send({ type: 'speech_started' });
              }
              if (e.type === 'input_audio_buffer.speech_stopped') send({ type: 'speech_stopped' });
              if (e.type === 'conversation.item.input_audio_transcription.delta') {
                awaitingTranscription.add(e.item_id);
                publishTurn(`learner_${e.item_id}`, 'learner', e.delta ?? '', false);
              }
              if (e.type === 'conversation.item.input_audio_transcription.completed') {
                awaitingTranscription.delete(e.item_id);
                publishTurn(`learner_${e.item_id}`, 'learner', '', true, e.transcript ?? e.text ?? '');
              }
              if (e.type === 'conversation.item.input_audio_transcription.failed') awaitingTranscription.delete(e.item_id);
              const approved = !options.flash || approvedResponses.get(e.response_id ?? activeResponseId)?.revision === brainRevision;
              if (e.type === 'response.audio_transcript.delta' && approved) publishTurn(`patient_${e.item_id}`, 'patient', e.delta ?? '', false, undefined, e.response_id ?? activeResponseId);
              if (e.type === 'response.audio_transcript.done' && approved) {
                const responseId = e.response_id ?? activeResponseId;
                const key = `patient_${e.item_id}`;
                const proof = approvedResponses.get(responseId);
                const normalize = (text: string) => text.replace(/[\p{P}\p{Z}\s]/gu, '').normalize('NFKC');
                const matches = !options.flash || (proof && normalize(e.transcript ?? '') === normalize(proof.answer));
                publishTurn(key, 'patient', '', Boolean(matches), e.transcript ?? '', responseId);
                const turn = partials.get(key);
                if (turn && options.flash) {
                  turn.verification = matches ? 'matches_flash' : 'paraphrase_unverified';
                  if (!matches) { turn.final = false; send({ type: 'quality_warning', message: '语音转述与病例内核文本有差异，请教师结合原文核对；该片段暂不作为确定的评分证据。' }); }
                  send({ type: 'turn', turn });
                  if (turn.text) store.addTurn(sessionId, turn);
                }
              }
              if (e.type === 'response.audio.delta' && approved && !interruptedResponses.has(e.response_id ?? activeResponseId)) {
                const bytes = Buffer.from(e.delta, 'base64'); appendFileSync(audioPath('patient'), bytes); patientAudio = true;
                send({ type: 'audio', audio: e.delta, itemId: e.item_id ?? e.response_id });
              }
              if (e.type === 'response.function_call_arguments.done' && options.flash) {
                const responseId = e.response_id ?? activeResponseId;
                const previous = toolCalls.get(responseId);
                if (previous && previous.callId !== e.call_id) throw new Error('本轮请求了多次病例工具，请将问题合并后重试。');
                toolCalls.set(responseId, { callId: e.call_id, name: e.name, arguments: e.arguments,
                  revision: responseRevisions.get(responseId) ?? brainRevision });
                if (completedResponses.has(responseId)) void runPatientTool(responseId);
              }
              if (e.type === 'response.done') {
                const responseId = e.response?.id ?? activeResponseId;
                if (e.response?.status === 'completed') completedResponses.add(responseId);
                if (e.response?.status === 'cancelled') {
                  interruptedResponses.add(responseId);
                  for (const key of responseTurns.get(responseId) ?? []) {
                    const turn = partials.get(key);
                    if (turn) { turn.interrupted = true; turn.final = false; send({ type: 'turn', turn }); }
                  }
                }
                flush();
                if (activeResponseId === responseId) activeResponseId = '';
                send({ type: 'response_done', status: e.response?.status ?? 'unknown' });
                const currentResponse = responseRevisions.get(responseId) === brainRevision;
                if (!finishing && currentResponse && ['failed', 'incomplete'].includes(e.response?.status)) upstreamFailure('患者响应未完成，请重新连接后继续。');
                if (!finishing && options.flash && currentResponse && e.response?.status === 'completed') {
                  if (toolCalls.has(responseId)) void runPatientTool(responseId);
                  else if (!approvedResponses.has(responseId)) upstreamFailure('语音响应未经过病例内核，本轮未播放。请重新连接后再试。');
                }
              }
              if (e.type === 'error') upstreamFailure(e.error?.message ?? '语音服务返回错误', e.error?.code);
              } catch (error) { upstreamFailure(safeMessage(error)); }
            },
          });
          try {
            await provider.connect();
            if (stopped) return;
            ready = true;
            send({ type: 'ready', model: options.qwen.model, sessionId, inputSampleRate: 16000, outputSampleRate: 24000 });
            // This is an actual model response, not a locally fabricated transcript bubble.
            if (session.turns.length === 0) void provider.queueText('请作为患者只说你的固定开场，随后等待医生提问。').catch(error => {
              if (!stopped) upstreamFailure(safeMessage(error));
            });
          } catch (error) { if (!stopped) upstreamFailure(safeMessage(error)); }
          return;
        }
        if (event.type === 'finish' && sessionId) { await stop(); return; }
        if (!sessionId || !provider || !ready || stopped || finishing) throw new DomainError('语音尚未就绪或问诊已结束。');
        if (event.type === 'audio') {
          const bytes = Buffer.from(event.audio, 'base64');
          if (!bytes.length || bytes.length % 2) throw new DomainError('音频须为16位单声道PCM。', 400);
          try { provider.sendAudio(event.audio); }
          catch (error) { upstreamFailure(safeMessage(error)); return; }
          appendFileSync(audioPath('learner'), bytes); learnerAudio = true;
        }
        if (event.type === 'text') {
          if (currentBrainBusy()) throw new DomainError('患者正在组织回答，请等待或点击打断后再提问。');
          const turn: Turn = { id: randomUUID(), role: 'learner', text: event.text, at: new Date().toISOString(), source: 'typed', final: true };
          // queueText synchronously rejects a busy/unready provider before recording input.
          const response = provider.queueText(event.text);
          invalidateBrain();
          // Consume a later rejection even if persistence itself throws.
          const guardedResponse = response.catch(error => { throw error; });
          try {
          store.addTurn(sessionId, turn); send({ type: 'turn', turn });
          } catch (error) {
            upstreamFailure(safeMessage(error));
            await guardedResponse.catch(() => undefined);
            return;
          }
          await guardedResponse;
        }
        if (event.type === 'interrupt') {
          invalidateBrain();
          if (activeResponseId) interruptedResponses.add(activeResponseId);
          provider.interrupt(); send({ type: 'interrupted' });
        }
      } catch (error) { send({ type: 'error', message: safeMessage(error) }); }
    });
    socket.on('close', () => { clearTimeout(authTimer); if (!finishing) disconnect(); });
    socket.on('error', () => { clearTimeout(authTimer); if (!finishing) disconnect(); });
  });

  app.addHook('onClose', async () => {
    for (const controller of controllers.values()) controller.disconnect();
  });

  if (options.serveStatic !== false && existsSync(resolve('apps/mobile/dist/index.html'))) {
    await app.register(staticFiles, { root: resolve('apps/mobile/dist'), prefix: '/' });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/')
      ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html'));
  }
  return { app, store };
}
