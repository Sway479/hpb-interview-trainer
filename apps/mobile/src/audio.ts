import { WavRecorder, WavStreamPlayer } from 'wavtools';
import type { ServerEvent, Session, Turn } from '../../../packages/core/src/types';
import type { ConnectionSettings } from './platform/contracts';
import { DirectInterview, type DirectInterviewOptions, type VoiceServices } from './platform/realtime';

export interface VoiceState {
  connection: 'idle' | 'connecting' | 'ready' | 'disconnected' | 'error';
  microphone: 'off' | 'starting' | 'listening' | 'muted' | 'error';
  speaking: boolean; responding: boolean; reasoning: boolean; qualityWarning: string;
  inputLevel: number; outputLevel: number; model: string; error: string;
}
export const initialVoiceState: VoiceState = { connection: 'idle', microphone: 'off', speaking: false, responding: false,
  reasoning: false, qualityWarning: '', inputLevel: 0, outputLevel: 0, model: '', error: '' };
interface Callbacks { state: (state: VoiceState) => void; turn: (turn: Turn) => void; ended: (session: Session) => void }
export interface VoiceConnectionDependencies extends DirectInterviewOptions {
  services?: VoiceServices;
  createRecorder?: (sampleRate: number) => WavRecorder;
  createPlayer?: (sampleRate: number) => WavStreamPlayer;
}
let defaultServices: VoiceServices | undefined;
export function configureVoiceServices(services: VoiceServices) { defaultServices = services; }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '语音操作未完成，请重试。';
const asPCM = (value: ArrayBuffer | Int16Array) => value instanceof Int16Array ? value : new Int16Array(value);
function encodePCM(value: ArrayBuffer | Int16Array) {
  const samples = asPCM(value), bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function decodePCM(base64: string) {
  const binary = atob(base64), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength % 2) throw new Error('收到的语音数据格式不完整。');
  return new Int16Array(bytes.buffer);
}
function rms(samples: Int16Array) {
  let sum = 0; for (let i = 0; i < samples.length; i++) sum += (samples[i] / 32768) ** 2;
  return Math.min(1, Math.sqrt(sum / Math.max(samples.length, 1)) * 4);
}

/** Device audio stays in the WebView; authenticated cloud networking is delegated to HpbNative. */
export class VoiceConnection {
  private state: VoiceState = { ...initialVoiceState };
  private interview: DirectInterview | null = null;
  private recorder: WavRecorder | null = null;
  private player: WavStreamPlayer | null = null;
  private generation = 0;
  private closed = false;
  private finishing = false;
  private blockedOutput = false;
  private meterFrame = 0;
  private microphoneBusy = false;
  private interruptSequence = 0;
  private finishPromise?: Promise<Session | null>;
  private closePromise?: Promise<void>;
  constructor(private callbacks: Callbacks, private readonly dependencies: VoiceConnectionDependencies = {}) {}
  private update(patch: Partial<VoiceState>) { this.state = { ...this.state, ...patch }; this.callbacks.state({ ...this.state }); }
  async prepare() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)
      throw new Error('当前环境无法使用麦克风。请使用 Android App 并授予录音权限。');
    if (this.player) return;
    const player = this.dependencies.createPlayer?.(24000) ?? new WavStreamPlayer({ sampleRate: 24000 });
    this.player = player;
    try { await player.connect(); if (this.closed) await this.stopMedia(); else this.startMeter(); }
    catch (error) { await this.stopMedia(); throw error; }
  }
  async connect(settings: ConnectionSettings, sessionId: string) {
    if (this.closed || this.interview) return;
    const generation = ++this.generation;
    this.update({ connection: 'connecting', error: '', microphone: 'off' });
    try {
      const services = this.dependencies.services ?? defaultServices;
      if (!services) throw new Error('本机问诊服务尚未初始化，请重新启动应用。');
      if (!this.player) await this.prepare();
      if (this.closed || generation !== this.generation) return;
      const interview = new DirectInterview(settings, sessionId, services, event => {
        if (this.closed || generation !== this.generation) return;
        void this.handle(event).catch(error => this.fail(error));
      }, this.dependencies);
      this.interview = interview;
      await interview.connect();
      if (this.closed || generation !== this.generation) { await interview.close(); return; }
      this.update({ connection: 'ready', model: interview.profile.realtimeModel, error: '' });
      await this.enableMicrophone();
    } catch (error) { await this.fail(error); }
  }
  private async handle(event: ServerEvent) {
    if (this.closed) return;
    switch (event.type) {
      case 'turn': this.callbacks.turn(event.turn); break;
      case 'audio':
        if (!this.finishing && !this.blockedOutput && this.player) this.player.add16BitPCM(decodePCM(event.audio), event.itemId);
        break;
      case 'speech_started':
        this.blockedOutput = true; this.update({ speaking: true, responding: false }); await this.clearPlayback(); break;
      case 'speech_stopped': this.update({ speaking: false }); break;
      case 'response_started': this.blockedOutput = false; this.update({ responding: true }); break;
      case 'response_done': this.update({ responding: false }); break;
      case 'reasoning_started': this.update({ reasoning: true }); break;
      case 'reasoning_done': this.update({ reasoning: false }); break;
      case 'quality_warning': this.update({ qualityWarning: event.message }); break;
      case 'interrupted': this.blockedOutput = true; this.update({ responding: false }); await this.clearPlayback(); break;
      case 'error': await this.fail(new Error(event.message)); break;
      case 'session_ended': this.finishing = true; this.callbacks.ended(event.session); await this.close(); break;
    }
  }
  private startMeter() {
    let last = 0;
    const tick = (now: number) => {
      if (this.closed) return;
      if (now - last > 90) {
        last = now; const analyser = this.player?.analyser; let level = 0;
        if (analyser && this.player?.context?.state === 'running') {
          const samples = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(samples);
          let sum = 0; for (let i = 0; i < samples.length; i++) sum += ((samples[i] - 128) / 128) ** 2;
          level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
        }
        this.update({ outputLevel: level });
      }
      this.meterFrame = requestAnimationFrame(tick);
    };
    this.meterFrame = requestAnimationFrame(tick);
  }
  async enableMicrophone() {
    if (this.closed || this.finishing || this.state.connection !== 'ready' || this.microphoneBusy) return;
    this.microphoneBusy = true; const generation = this.generation;
    this.update({ microphone: 'starting', error: '' });
    try {
      const rate = this.interview?.inputSampleRate ?? 16000;
      const recorder = this.recorder ?? this.dependencies.createRecorder?.(rate) ?? new WavRecorder({ sampleRate: rate });
      this.recorder = recorder;
      if (recorder.getStatus() === 'ended') await recorder.begin();
      if (this.closed || this.finishing || generation !== this.generation) { await this.disposeRecorder(recorder); return; }
      for (const track of recorder.stream?.getAudioTracks() ?? []) {
        try { await track.applyConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }); }
        catch { /* Device support varies; headphones remain useful. */ }
      }
      const context = recorder.source?.context as AudioContext | undefined;
      if (context?.state === 'suspended') await context.resume();
      if (context?.state !== 'running') throw new Error('音频尚未启用，请再次点击麦克风。');
      recorder.stream?.getAudioTracks().forEach(track => { track.enabled = true; });
      if (recorder.getStatus() !== 'recording') {
        await recorder.record(({ mono }) => {
          if (this.closed || this.finishing || this.state.microphone !== 'listening' || !this.interview?.isReady) return;
          try { this.interview.sendAudio(encodePCM(mono)); this.update({ inputLevel: rms(asPCM(mono)) }); }
          catch (error) { void this.fail(error); }
        }, Math.floor(rate * 0.04));
      }
      if (this.closed || this.finishing || generation !== this.generation) { await this.disposeRecorder(recorder); return; }
      this.update({ microphone: 'listening' });
    } catch (error) {
      if (!this.closed) this.update({ microphone: 'error', inputLevel: 0, error: `麦克风未启用，请检查权限后重试。${errorMessage(error)}` });
      if (this.recorder) await this.disposeRecorder(this.recorder); this.recorder = null;
    } finally { this.microphoneBusy = false; }
  }
  async mute() {
    this.recorder?.stream?.getAudioTracks().forEach(track => { track.enabled = false; });
    this.update({ microphone: 'muted', inputLevel: 0, speaking: false });
    if (this.microphoneBusy) return;
    this.microphoneBusy = true;
    try { if (this.recorder?.getStatus() === 'recording') await this.recorder.pause(); }
    catch (error) { this.update({ error: errorMessage(error) }); }
    finally { this.microphoneBusy = false; }
  }
  private async clearPlayback() {
    const player = this.player, node = player?.stream;
    if (!player || !node) return;
    const requestId = `interrupt-${Date.now().toString(36)}-${++this.interruptSequence}`;
    // Disconnect immediately; never use wavtools' unbounded polling interrupt().
    node.disconnect(); if (player.stream === node) player.stream = null;
    this.update({ outputLevel: 0 });
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { node.port.onmessage = null; resolve(); }, 200);
      node.port.onmessage = event => {
        if (event.data?.event !== 'offset' || event.data.requestId !== requestId) return;
        clearTimeout(timer); node.port.onmessage = null;
        if (event.data.trackId && Number.isFinite(event.data.offset)) this.interview?.interruptPlayback(event.data.trackId, event.data.offset / 24000 * 1000);
        resolve();
      };
      try { node.port.postMessage({ event: 'interrupt', requestId }); }
      catch { clearTimeout(timer); node.port.onmessage = null; resolve(); }
    });
  }
  async interrupt() {
    this.blockedOutput = true; this.update({ responding: false });
    this.interview?.interrupt(); await this.clearPlayback();
  }
  /** Returns after synchronous acceptance. Completion and later failures arrive through callbacks. */
  sendText(text: string) {
    if (this.state.connection !== 'ready' || !this.interview) throw new Error('语音尚未接通，请使用文字问诊。');
    this.interview.sendText(text);
  }
  finish(): Promise<Session | null> {
    if (this.finishPromise) return this.finishPromise;
    this.finishing = true; this.blockedOutput = true;
    this.finishPromise = (async () => {
      await this.mute(); await this.clearPlayback();
      if (!this.interview?.isReady && this.state.connection !== 'ready') { await this.close(); return null; }
      try { return await this.interview!.finish(); }
      finally { await this.close(); }
    })();
    return this.finishPromise;
  }
  private async disposeRecorder(recorder: WavRecorder) {
    const context = recorder.source?.context as AudioContext | undefined;
    recorder.stream?.getTracks().forEach(track => track.stop());
    try { await recorder.quit(); } catch { /* Tracks are already stopped. */ }
    if (context && context.state !== 'closed') { try { await context.close(); } catch { /* Already released. */ } }
  }
  private async stopMedia() {
    cancelAnimationFrame(this.meterFrame);
    const recorder = this.recorder, player = this.player; this.recorder = null; this.player = null;
    recorder?.stream?.getTracks().forEach(track => track.stop());
    if (player) {
      try { player.stream?.disconnect(); } catch { /* Already disconnected. */ }
      if (player.context?.state !== 'closed') { try { await player.context?.close(); } catch { /* Already closed. */ } }
    }
    if (recorder) await this.disposeRecorder(recorder);
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.generation++; cancelAnimationFrame(this.meterFrame);
    const interview = this.interview; this.interview = null;
    this.closePromise = (async () => {
      const results = await Promise.allSettled([this.stopMedia(), interview?.close()]);
      const failure = results.find(result => result.status === 'rejected');
      this.update({ connection: 'disconnected', microphone: 'off', speaking: false, responding: false, reasoning: false, inputLevel: 0, outputLevel: 0,
        ...(failure?.status === 'rejected' ? { error: errorMessage(failure.reason) } : {}) });
    })();
    return this.closePromise;
  }
  private async fail(error: unknown) { this.update({ connection: 'error', error: errorMessage(error) }); await this.close(); }
}
