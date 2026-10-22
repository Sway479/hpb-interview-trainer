// Realtime protocol follows Qwen's official WebSocket/client-event guide.
// This script prints only a redacted receipt, never headers or credentials.
import 'dotenv/config';
import WebSocket from 'ws';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const model = process.env.QWEN_REALTIME_MODEL;
const endpoint = new URL(process.env.QWEN_REALTIME_URL);
endpoint.searchParams.set('model', model);
if (!process.env.DASHSCOPE_API_KEY) throw new Error('Missing local API key');
const audioFile = process.argv.find(x => x.startsWith('--pcm='))?.slice(6);
const receipt = { at: new Date().toISOString(), model, endpoint: endpoint.hostname,
  input: audioFile ? 'synthetic_chinese_speech_pcm16k' : 'text', events: {}, audioBytes: 0,
  text: '', transcription: '', status: 'connecting' };
const chunks = [];
const ws = new WebSocket(endpoint, {
  headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` },
  handshakeTimeout: 20000,
});
const send = event => ws.send(JSON.stringify(event));
let ended = false;
const finish = async (status, detail) => {
  if (ended) return;
  ended = true;
  clearTimeout(timeout);
  receipt.status = status;
  if (detail) receipt.detail = String(detail).replace(/sk-[^\s"']+/g, '[redacted]');
  ws.close();
  await mkdir('artifacts', { recursive: true });
  const name = audioFile ? 'qwen-audio-probe' : 'qwen-text-audio-probe';
  await writeFile(`artifacts/${name}.json`, JSON.stringify(receipt, null, 2));
  if (chunks.length) await writeFile(`artifacts/${name}.pcm`, Buffer.concat(chunks));
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = status === 'passed' ? 0 : 1;
};
const timeout = setTimeout(() => finish('failed', 'No complete response within 45 seconds'), 45000);
ws.on('unexpected-response', (_request, response) => {
  response.resume();
  finish('failed', `WebSocket handshake HTTP ${response.statusCode}`);
});
ws.on('error', error => finish('failed', error.message));
ws.on('close', code => { if (!ended) finish('failed', `Connection closed before completion (${code})`); });
ws.on('message', async data => {
  const e = JSON.parse(data.toString());
  receipt.events[e.type] = (receipt.events[e.type] ?? 0) + 1;
  if (e.type === 'session.created') {
    receipt.serverModel = e.session?.model;
    send({ type: 'session.update', session: {
      modalities: ['text', 'audio'], voice: process.env.QWEN_VOICE,
      input_audio_format: 'pcm', output_audio_format: 'pcm',
      input_audio_transcription: { language: 'zh' }, output_audio: { language: 'zh' },
      turn_detection: null, enable_search: false,
      instructions: '你扮演一位虚构的教学模拟患者。右上腹痛一天。只用中文回答一句，不诊断、不教学生。'
    }});
  }
  if (e.type === 'session.updated') {
    if (audioFile) {
      const pcm = await readFile(audioFile);
      for (let i = 0; i < pcm.length; i += 3200) {
        send({ type: 'input_audio_buffer.append', audio: pcm.subarray(i, i + 3200).toString('base64') });
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      send({ type: 'input_audio_buffer.commit' });
    } else {
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '你好，请问你哪里不舒服？' }] }});
    }
    send({ type: 'response.create' });
  }
  if (e.type === 'response.audio.delta') {
    const bytes = Buffer.from(e.delta, 'base64');
    receipt.audioBytes += bytes.length;
    chunks.push(bytes);
  }
  if (e.type === 'response.audio_transcript.delta' || e.type === 'response.text.delta') receipt.text += e.delta ?? '';
  if (e.type.startsWith('conversation.item.input_audio_transcription')) {
    receipt.transcription = e.transcript ?? e.text ?? (receipt.transcription + (e.delta ?? ''));
  }
  if (e.type === 'error') finish('failed', JSON.stringify(e.error));
  if (e.type === 'response.done') {
    receipt.responseStatus = e.response?.status;
    finish(receipt.audioBytes > 0 && receipt.text.length > 0 && e.response?.status !== 'failed' ? 'passed' : 'failed');
  }
});
