import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativeSocketEvent {
  id: string;
  type: 'open' | 'message' | 'error' | 'close';
  data?: string;
  message?: string;
  code?: number;
  failureKind?: 'timeout' | 'authentication' | 'tls' | 'network' | 'handshake';
  stage?: 'handshake' | 'connected';
  errorType?: string;
  httpStatus?: number;
  timeoutKind?: 'pong' | 'io';
  elapsedMs?: number;
  pingIntervalMs?: number;
}

/** Native credential values are write only. All API authorization stays in Android. */
export interface HpbNativePlugin {
  saveCredential(options: { id: string; key: string; origins: string[] }): Promise<void>;
  credentialStatus(options: { ids: string[] }): Promise<{ entries: { id: string; hasKey: boolean }[] }>;
  deleteCredential(options: { id: string }): Promise<void>;
  http(options: { profileId: string; url: string; body: string; timeoutMs?: number }): Promise<{ status: number; body: string }>;
  openSocket(options: { id: string; profileId: string; url: string }): Promise<void>;
  sendSocket(options: { id: string; data: string }): Promise<void>;
  closeSocket(options: { id: string }): Promise<void>;
  addListener(eventName: 'socketEvent', listener: (event: NativeSocketEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'backButton', listener: () => void): Promise<PluginListenerHandle>;
  minimizeApp(): Promise<void>;
  readData(options: { path: string }): Promise<{ exists: boolean; data: string }>;
  writeData(options: { path: string; data: string }): Promise<void>;
  listData(options: { path: string }): Promise<{ paths: string[] }>;
  deleteData(options: { path: string }): Promise<void>;
  appendAudio(options: { sessionId: string; role: 'learner' | 'patient'; audio: string; sampleRate?: number }): Promise<void>;
  /** A complete mono PCM16 RIFF/WAVE file, encoded as base64. Export streams large recordings directly. */
  readAudio(options: { sessionId: string; role: 'learner' | 'patient' }): Promise<{ exists: boolean; audio: string; sampleRate?: number }>;
  deleteAudio(options: { sessionId: string }): Promise<void>;
  exportPackage(options: {
    fileName: string;
    textFiles: { path: string; content: string }[];
    recordingSessionIds: string[];
    includeAudio: boolean;
  }): Promise<{ uri: string; fileName: string; bytes: number; recordingFiles?: number; missingAudio?: number }>;
  sharePackage(options: { uri: string; fileName: string; mimeType?: string }): Promise<void>;
}

export const HpbNative = registerPlugin<HpbNativePlugin>('HpbNative');
