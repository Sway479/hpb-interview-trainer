import dotenv from 'dotenv';
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createApp } from '../server/app.ts';
dotenv.config({ quiet: true });

const { app } = await createApp({ dataDirectory: '.cache/live-verification-data', serveStatic: false,
  flash: { apiKey: process.env.DASHSCOPE_API_KEY!, url: process.env.QWEN_FLASH_URL!, model: process.env.QWEN_FLASH_MODEL! },
  qwen: { apiKey: process.env.DASHSCOPE_API_KEY!, url: process.env.QWEN_REALTIME_URL!, model: process.env.QWEN_REALTIME_MODEL!, voice: process.env.QWEN_VOICE! } });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const receipt: Record<string, unknown> = { at: new Date().toISOString(), input: 'locally_synthesised_chinese_question', model: process.env.QWEN_REALTIME_MODEL, checks: [] };
const check = (name: string) => (receipt.checks as string[]).push(name);
async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, value: await response.json() as any };
}
let ws: WebSocket | undefined;
try {
  const { value: previews } = await request('/cases');
  assert.equal(previews.length, 4); assert.ok(previews.every((item: any) => !item.facts && !item.rubric)); check('four_public_cases_without_hidden_facts');
  const { value: session } = await request('/sessions', { caseId: 'ruq-01' });
  const early = await request(`/sessions/${session.id}/summary`, { history: '未经问诊不能直接提交总结', reasoning: '测试', plan: '测试', uncertainty: '测试' });
  assert.equal(early.response.status, 409); check('summary_locked_during_interview');
  const events: any[] = [];
  ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/voice');
  ws.on('message', raw => { const event = JSON.parse(raw.toString()); events.push(event); });
  const wait = async (predicate: () => boolean, label: string, timeout = 45000) => {
    const started = Date.now();
    while (!predicate()) {
      const error = events.find(e => e.type === 'error');
      if (error) throw new Error(`${label}: ${error.message}`);
      if (Date.now() - started > timeout) throw new Error(`${label}: timeout`);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  };
  await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject); });
  ws.send(JSON.stringify({ type: 'connect', sessionId: session.id }));
  await wait(() => events.some(e => e.type === 'ready'), 'voice ready'); check('gateway_authenticated_exact_qwen_model');
  await wait(() => events.some(e => e.type === 'turn' && e.turn.role === 'patient' && e.turn.final) && events.some(e => e.type === 'audio'), 'Flash-backed patient opening');
  const patientIdsBefore = new Set(events.filter(e => e.type === 'turn' && e.turn.role === 'patient').map(e => e.turn.id));
  const pcm = await readFile('test/fixtures/interview-question-short.pcm');
  const withSilence = Buffer.concat([pcm, Buffer.alloc(16000 * 2)]);
  for (let i = 0; i < withSilence.length; i += 640) {
    ws.send(JSON.stringify({ type: 'audio', audio: withSilence.subarray(i, i + 640).toString('base64') }));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await wait(() => events.some(e => e.type === 'turn' && e.turn.role === 'patient' && e.turn.final && !patientIdsBefore.has(e.turn.id)), 'Flash-backed voice reply');
  assert.ok(events.some(e => e.type === 'speech_started')); check('server_vad_speech_detection');
  const asr = events.filter(e => e.type === 'turn' && e.turn.role === 'learner' && e.turn.final).at(-1)?.turn;
  assert.ok(asr?.text.includes('不舒服')); check('real_asr_transcription_received');
  const audioBytes = events.filter(e => e.type === 'audio').reduce((sum, e) => sum + Buffer.from(e.audio, 'base64').length, 0);
  assert.ok(audioBytes > 1000); check('real_patient_pcm24k_audio_received');
  receipt.asr = asr.text; receipt.audioBytes = audioBytes;
  ws.send(JSON.stringify({ type: 'finish' }));
  await wait(() => events.some(e => e.type === 'session_ended'), 'session end'); check('voice_end_releases_session');
  const { value: ended } = await request(`/sessions/${session.id}`);
  assert.ok(ended.modelCalls?.some((call: any) => call.kind === 'patient_reply' && call.model === process.env.QWEN_FLASH_MODEL));
  check('voice_function_call_executes_real_flash_case_engine'); receipt.modelCalls = ended.modelCalls;
  assert.equal(ended.status, 'summary'); assert.ok(ended.turns.some((turn: any) => turn.role === 'learner' && turn.final));
  const summary = { history: '患者女性48岁，自诉右上腹痛1天，问诊记录仅问及哪里不舒服及起病时间；其余病史未充分采集。',
    reasoning: '疼痛提示需进一步核实肝胆及其他上腹部来源，现有信息不足以确诊。',
    plan: '需补问疼痛特征、伴随症状、既往发作与用药过敏，随后结合生命体征及查体等进一步核实。',
    uncertainty: '症状细节、体温及检查均不明确，不能判断疾病类型或严重程度。' };
  const feedback = await request(`/sessions/${session.id}/summary`, summary);
  assert.equal(feedback.response.status, 200, JSON.stringify(feedback.value));
  assert.equal(feedback.value.status, 'feedback_ready'); assert.equal(feedback.value.feedback.model, process.env.QWEN_FLASH_MODEL);
  assert.equal(feedback.value.feedback.items.length, 12);
  assert.equal(feedback.value.feedback.assessment?.id, 'hpb-voice-formative-assessment');
  assert.equal(feedback.value.feedback.assessment?.version, '0.1');
  assert.ok(feedback.value.feedback.scoreSummary);
  check('independent_summary_then_real_flash_feedback_with_versioned_twelve_item_rubric');
  for (const item of feedback.value.feedback.items) for (const evidence of item.evidence) {
    assert.ok(feedback.value.turns.some((t: any) => t.id === evidence.turnId && t.final && t.text.includes(evidence.quote)));
  }
  check('all_displayed_evidence_quotes_match_final_transcript');
  assert.equal(feedback.value.feedback.reviewStatus, 'pending'); check('automatic_feedback_requires_teacher_review');
  const audio = await fetch(`${base}/api/sessions/${session.id}/audio?role=learner`);
  assert.equal(audio.headers.get('content-type'), 'audio/wav'); assert.equal(Buffer.from(await audio.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
  check('original_audio_available_for_transcription_review');
  const exported = await request(`/sessions/${session.id}/export`);
  const serialized = JSON.stringify(exported.value);
  assert.ok(!serialized.includes(process.env.DASHSCOPE_API_KEY!)); assert.ok(!serialized.includes('"facts"')); check('export_contains_no_key_or_hidden_case');
  receipt.events = events.reduce((count, event) => { count[event.type] = (count[event.type] ?? 0) + 1; return count; }, {} as Record<string, number>);
  receipt.sessionId = session.id; receipt.status = 'passed'; receipt.feedback = feedback.value.feedback;
} catch (error) {
  receipt.status = 'failed'; receipt.error = error instanceof Error ? error.message.replace(/sk-[^\s"']+/g, '[redacted]') : 'Unknown failure';
  process.exitCode = 1;
} finally {
  ws?.close(); await app.close(); await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/live-e2e.json', JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
