import { Capacitor } from '@capacitor/core';
import { HpbNative } from './native-bridge.js';
import { newId } from '../../../../packages/core/src/ids.js';

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const native = () => Capacitor.isNativePlatform();
let databasePromise: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('hpb-standalone-v2', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('documents');
      const audio = request.result.createObjectStore('audio', { keyPath: 'id' });
      audio.createIndex('stream', 'stream');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { databasePromise = undefined; reject(new Error('本机数据库无法打开，请检查设备存储空间。')); };
  });
  return databasePromise;
}
async function transaction<T>(name: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode); let result: T;
    const request = run(tx.objectStore(name));
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(new Error('本机数据保存未完成，请检查设备可用空间后重试。'));
  });
}
export interface DocumentStorage {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  list(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}
export const documents: DocumentStorage = {
  async read(path) {
    if (native()) { const result = await HpbNative.readData({ path }); return result.exists ? result.data : null; }
    return (await transaction<string | undefined>('documents', 'readonly', store => store.get(path))) ?? null;
  },
  async write(path, data) {
    if (native()) { await HpbNative.writeData({ path, data }); return; }
    await transaction('documents', 'readwrite', store => store.put(data, path));
  },
  async list(path) {
    if (native()) { const result = await HpbNative.listData({ path }); return result.paths.map(name => name.startsWith(path + '/') ? name : path + '/' + name); }
    const keys = await transaction<IDBValidKey[]>('documents', 'readonly', store => store.getAllKeys());
    return keys.map(String).filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/'));
  },
  async remove(path) {
    if (native()) { await HpbNative.deleteData({ path }); return; }
    await transaction('documents', 'readwrite', store => store.delete(path));
  },
};
function bytesFromBase64(audio: string): Uint8Array {
  const raw = atob(audio); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function wav(chunks: Uint8Array[], sampleRate: number): Blob {
  const length = chunks.reduce((sum, part) => sum + part.byteLength, 0);
  const header = new ArrayBuffer(44), view = new DataView(header);
  const word = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  word(0, 'RIFF'); view.setUint32(4, length + 36, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, length, true);
  return new Blob([header, ...chunks.map(chunk => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer)], { type: 'audio/wav' });
}
interface AudioChunk { id: string; stream: string; at: number; sequence: number; sampleRate: number; bytes: Uint8Array }
let sequence = 0;
export const audioStorage = {
  async append(sessionId: string, role: 'learner' | 'patient', audio: string, sampleRate: number) {
    if (native()) { await HpbNative.appendAudio({ sessionId, role, audio, sampleRate }); return; }
    const chunk: AudioChunk = { id: newId(), stream: `${sessionId}/${role}`, at: Date.now(), sequence: ++sequence, sampleRate, bytes: bytesFromBase64(audio) };
    await transaction('audio', 'readwrite', store => store.put(chunk));
  },
  async blob(sessionId: string, role: 'learner' | 'patient'): Promise<Blob> {
    if (native()) {
      const result = await HpbNative.readAudio({ sessionId, role });
      if (!result.exists || !result.audio) throw new Error('这次会话没有该角色的录音。');
      const data = bytesFromBase64(result.audio);
      // Native readAudio returns a complete RIFF/WAVE file, not headerless PCM.
      return new Blob([data.buffer as ArrayBuffer], { type: 'audio/wav' });
    }
    const db = await database();
    const chunks = await new Promise<AudioChunk[]>((resolve, reject) => {
      const request = db.transaction('audio').objectStore('audio').index('stream').getAll(`${sessionId}/${role}`);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('无法读取本机录音。'));
    });
    if (!chunks.length) throw new Error('这次会话没有该角色的录音。');
    chunks.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
    return wav(chunks.map(chunk => chunk.bytes), chunks[0].sampleRate);
  },
};
