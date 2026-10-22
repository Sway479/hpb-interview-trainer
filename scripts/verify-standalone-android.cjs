// Paid Qwen acceptance on this project's dedicated Android emulator.
// No teaching gateway is started. CDP controls the installed application only.
// All registration and speech are explicitly synthetic QA data.
const platformTools = require('./platform-tools.cjs');
const { chromium } = platformTools.playwright();
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { createConnection } = require('node:net');
const assert = require('node:assert/strict');
const dotenv = require('dotenv');
const adbPath = platformTools.adbPath();
const serial = process.env.HPB_ANDROID_SERIAL || 'emulator-5554';
const apk = resolve(process.argv[2] || 'artifacts/android/hpb-voice-standalone-debug.apk');
const out = resolve('artifacts/standalone/android'); mkdirSync(out, { recursive: true });
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const receipt = { at: new Date().toISOString(), scope: 'installed_standalone_android_synthetic_qwen_acceptance', serial,
  apk: { path: apk, sha256: createHash('sha256').update(readFileSync(apk)).digest('hex') }, checks: [], errors: [], limitations: [
    'Synthetic audio injected at getUserMedia exercises the WebView worklet and native cloud path; no physical microphone, speaker echo or Bluetooth test.',
    'Only Qwen uses a real credential. OpenAI, DeepSeek and custom adapters have local protocol tests only.',
    'QA study, participant, utterances and summaries are SIMULATED_ONLY; this is software acceptance, not educational effectiveness or psychometric validation.',
  ] };
let browser, page, sessionId;
const check = name => { receipt.checks.push(name); console.log('PASS ' + name); };
const native = (method, options) => page.evaluate(({ method, options }) => window.Capacitor.nativePromise('HpbNative', method, options), { method, options });
async function connect() {
  const line = adb('shell', 'cat', '/proc/net/unix').split('\n').find(x => /@webview_devtools_remote_\d+/.test(x));
  assert.ok(line, 'installed app must have its WebView running');
  adb('forward', 'tcp:19222', 'localabstract:' + line.match(/@(webview_devtools_remote_\d+)/)[1]);
  browser = await chromium.connectOverCDP('http://127.0.0.1:19222', { noDefaults: true });
  page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://localhost/'));
  assert.ok(page); page.on('pageerror', e => receipt.errors.push(e.message));
  page.setDefaultTimeout(15000);
  await page.evaluate(async()=>{
    window.__hpbSafeSocketEvents=[];window.__hpbSocketMessageCounts={};
    window.__hpbQaListener=await window.Capacitor.Plugins.HpbNative.addListener('socketEvent',event=>{
      if(event.type==='message'){try{const type=JSON.parse(event.data).type;window.__hpbSocketMessageCounts[type]=(window.__hpbSocketMessageCounts[type]||0)+1;}catch{}return;}
      const{id,type,code,failureKind,stage,errorType,httpStatus,timeoutKind,elapsedMs,pingIntervalMs}=event;
      window.__hpbSafeSocketEvents.push({id,type,code,failureKind,stage,errorType,httpStatus,timeoutKind,elapsedMs,pingIntervalMs,observedAt:new Date().toISOString()});
    });
  });
}
async function records(folder) {
  const { paths } = await native('listData', { path: folder });
  const values = [];
  for (const path of paths) { const value = await native('readData', { path }); if (value.exists) values.push(JSON.parse(value.data)); }
  return values;
}
async function session() { const result = await native('readData', { path: 'sessions/' + sessionId + '.json' }); return result.exists ? JSON.parse(result.data) : null; }
async function until(pick, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await pick(); if (value) return value;
    const errors=await page.locator('[role="alert"]').allTextContents();if(errors.length)throw new Error(label+': '+errors.join('; '));
    await sleep(300); }
  throw new Error(label + ' timed out');
}
const listeningPort = port => new Promise(resolvePort => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(500); socket.on('connect', () => { socket.destroy(); resolvePort(true); });
  socket.on('error', () => resolvePort(false)); socket.on('timeout', () => { socket.destroy(); resolvePort(false); });
});

(async () => {
  try {
    const config = dotenv.parse(readFileSync('.env')), key = config.DASHSCOPE_API_KEY || config.QIANWEN_API_KEY;
    assert.ok(key && key.length > 12, 'local authorized Qwen credential is required');
    assert.equal(await listeningPort(8787), false); assert.equal(await listeningPort(8788), false);
    check('computer_teaching_gateway_ports_8787_and_8788_are_not_running');
    adb('install', '-r', apk); adb('shell', 'pm', 'grant', 'edu.hpb.interview', 'android.permission.RECORD_AUDIO');
    adb('shell', 'am', 'force-stop', 'edu.hpb.interview'); adb('shell', 'am', 'start', '-n', 'edu.hpb.interview/.MainActivity');
    await sleep(1200); await connect();
    await page.locator('.case-card').filter({hasText:'右上腹痛'}).waitFor();
    receipt.packageVersion = adb('shell', 'dumpsys', 'package', 'edu.hpb.interview').split('\n').find(x => x.includes('versionName='))?.trim();
    receipt.webview = adb('shell', 'dumpsys', 'webviewupdate').split('\n').find(x => x.includes('Current WebView package'))?.trim();
    receipt.capabilities = await page.evaluate(() => ({ native: window.Capacitor.isNativePlatform(), secure: window.isSecureContext,
      audioWorklet: typeof AudioWorkletNode === 'function', flexGapFallback: document.documentElement.classList.contains('no-flex-gap'),
      caseCards: document.querySelectorAll('.case-card').length,
      cardGap: (() => { const c = document.querySelectorAll('.case-card'); return c[1].getBoundingClientRect().top - c[0].getBoundingClientRect().bottom; })() }));
    assert.equal(receipt.capabilities.caseCards, 4); assert.ok(receipt.capabilities.cardGap >= 9);
    check('installed_webview83_renders_four_cases_and_legacy_spacing');

    await page.getByRole('button', { name: 'API', exact: true }).click();
    await page.getByRole('button', { name: '编辑 千问', exact: true }).click();
    await page.locator('#provider-key').fill(key);
    await page.getByRole('button', { name: '保存 API 配置', exact: true }).click();
    await page.locator('#provider-key').waitFor({ state: 'detached' });
    const status = await native('credentialStatus', { ids: ['qwen-default'] });
    assert.equal(status.entries[0].hasKey, true);
    const publicSettings = await native('readData', { path: 'config/settings.json' });
    assert.ok(!publicSettings.data.includes(key));
    assert.equal(await page.evaluate(k => JSON.stringify(localStorage).includes(k), key), false);
    check('phone_settings_save_qwen_key_in_native_vault_without_plaintext_metadata');
    await page.getByRole('button', { name: '检测文本', exact: true }).click();
    await page.getByText('文本：检测通过', { exact: true }).waitFor({ timeout: 45000 });
    await page.getByRole('button', { name: '检测语音', exact: true }).click();
    await page.getByText('语音：检测通过', { exact: true }).waitFor({ timeout: 30000 });
    check('native_https_text_and_authenticated_wss_qwen_probe_succeed');
    await page.screenshot({ path: resolve(out, 'api-native-connected.png') });

    const qaCode = 'SIMULATED_ONLY-' + Date.now().toString(36).toUpperCase();
    await page.getByRole('button', { name: '科研', exact: true }).click();
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.locator('#study-code').fill(qaCode);
    await page.locator('#study-title').fill('SIMULATED_ONLY 手机独立运行软件验收');
    await page.getByRole('button', { name: '保存项目登记', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(qaCode) }).click();
    await page.getByRole('button', { name: '登记学员', exact: true }).click();
    await page.locator('#participant-code').fill('SIMULATED_ONLY-P001');
    await page.locator('#participant-year').fill('软件验收虚构年级');
    await page.locator('#participant-months').fill('3');
    await page.locator('#participant-group').fill('SIMULATED_ONLY-A');
    await page.locator('#participant-consent').selectOption('not_applicable');
    await page.getByRole('button', { name: '保存学员登记', exact: true }).click();
    const study = (await records('studies')).find(x => x.code === qaCode);
    const participant = (await records('participants')).find(x => x.studyId === study.id);
    await page.getByRole('button', { name: '科研模式', exact: true }).click();
    await page.locator('#binding-study').selectOption(study.id);
    await page.locator('#binding-participant').selectOption(participant.id);
    await page.locator('#binding-phase').selectOption('baseline');
    await page.getByRole('button', { name: '设置下次训练', exact: true }).click();
    check('project_participant_group_and_baseline_are_registered_and_bound_in_phone_ui');
    receipt.studyId = study.id; receipt.participantId = participant.id;
    await page.screenshot({ path: resolve(out, 'research-registration.png') });

    const fixture = readFileSync('.cache/browser-fake-mic.wav').toString('base64');
    await page.evaluate(audio => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__hpbSynthetic = { streams: [], contexts: [] };
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (!constraints.audio) return original(constraints);
        const bytes = Uint8Array.from(atob(audio), char => char.charCodeAt(0));
        const context = new AudioContext({ sampleRate: 16000 }); await context.resume();
        const decoded = await context.decodeAudioData(bytes.buffer), destination = context.createMediaStreamDestination();
        const source = context.createBufferSource(); source.buffer = decoded; source.connect(destination); source.start();
        window.__hpbSynthetic.streams.push(destination.stream); window.__hpbSynthetic.contexts.push(context);
        destination.stream.getTracks().forEach(track => track.addEventListener('ended', () => { source.disconnect(); void context.close(); }, { once: true }));
        return destination.stream;
      };
    }, fixture);
    await page.getByRole('button', { name: '训练', exact: true }).click();
    await page.locator('.case-card').filter({hasText:'右上腹痛'}).click();
    await page.getByRole('button', { name: '开始语音问诊', exact: true }).click();
    await until(async () => { const list = await records('sessions'); const match = list.find(x => x.research?.studyId === study.id); if (match) { sessionId = match.id; return match; } }, 'native session created');
    await page.getByRole('button', { name: '静音麦克风', exact: true }).waitFor({ timeout: 45000 });
    await until(async () => (await session()).turns.some(t => t.role === 'learner' && t.source === 'asr' && t.final && t.text.includes('不舒服')), 'synthetic microphone native Qwen ASR');
    await page.getByRole('button', { name: '静音麦克风', exact: true }).click();
    await until(async () => { const s = await session(); const learnerAt=s.turns.find(t=>t.role==='learner'&&t.final)?.at;
      return learnerAt&&s.turns.some(t=>t.role==='patient'&&t.final&&t.at>=learnerAt)&&s.modelCalls?.filter(c=>c.kind==='patient_reply').length>=2; }, 'Flash grounded spoken patient response');
    check('synthetic_speech_crosses_webview_worklet_native_wss_qwen_asr_and_flash_https');
    const questions = ['疼痛从什么时候开始，是一直痛还是一阵阵痛，有什么诱因？',
      '有没有发热、寒战、眼睛黄、小便颜色改变或者恶心呕吐？',
      '以前有类似发作或胆结石吗，目前用什么药，有药物过敏吗？',
      '您最担心什么？我想先把症状问清楚，再核实生命体征并请带教老师评估，您还有需要补充的吗？'];
    for (const question of questions) {
      const before = new Set((await session()).turns.filter(t => t.role === 'patient').map(t=>t.id));
      await page.locator('#typed-message').fill(question); await page.getByRole('button', { name: '发送文字', exact: true }).click();
      await until(async () => (await session()).turns.some(t=>t.role==='patient'&&!before.has(t.id)&&t.verification), 'native dual-model typed turn');
      await sleep(350); // Final transcript precedes response.done by a small event interval.
    }
    await page.screenshot({ path: resolve(out, 'native-live-interview.png') });
    check('four_case_specific_questions_use_native_dual_model_path');
    await page.getByRole('button', { name: '结束问诊，撰写总结', exact: true }).click();
    await page.getByRole('button', { name: '结束并写总结', exact: true }).click();
    await page.locator('#summary-history').waitFor();
    const independent = { history: 'SIMULATED_ONLY：虚构陈女士主诉右上腹痛一天。问诊已核实疼痛起病、伴随症状和既往病史，具体信息以保存的转录为准。',
      reasoning: '右上腹痛病因需要进一步鉴别，不能仅凭此对话确认诊断或严重程度。',
      plan: '继续补全病史，核实体征和相关检查，请带教老师评估，并回应患者担忧。',
      uncertainty: '软件验收使用虚构语音与病例，无实际查体、化验及影像资料；语音识别应结合录音核对。' };
    for (const [field, value] of Object.entries(independent)) await page.locator('#summary-' + field).fill(value);
    await page.getByRole('button', { name: '提交总结，查看复盘', exact: true }).click();
    await until(async () => { const s = await session(); if (s.feedbackError) throw new Error(s.feedbackError); return s.status === 'feedback_ready' && s; }, 'real native Flash feedback', 120000);
    const generated = await session(); assert.equal(generated.feedback.items.length, 12); assert.equal(generated.feedback.model, 'qwen3.8-flash');
    for (const item of generated.feedback.items) for (const evidence of item.evidence) assert.ok(generated.turns.some(t => t.id === evidence.turnId && t.role === 'learner' && t.final && !t.interrupted && t.text.includes(evidence.quote)));
    assert.equal(generated.research.group, 'SIMULATED_ONLY-A'); assert.equal(generated.research.phase, 'baseline');
    assert.equal(generated.runtime.engineVersion, 'standalone-0.2.0'); assert.ok(generated.recordings.learner && generated.recordings.patient);
    check('independent_summary_precedes_twelve_evidence_linked_flash_reference_scores');
    await page.getByRole('heading', { name: '本次问诊回顾', exact: true }).waitFor();
    await page.screenshot({ path: resolve(out, 'native-feedback.png') });
    await page.getByRole('button', { name: /填写复核备注/ }).click();
    await page.locator('#reviewer').fill('SIMULATED_ONLY-T01');
    await page.locator('#review-notes').fill('SIMULATED_ONLY 软件验收备注；本次不构成教学效果或评分效度的验证。');
    await page.getByRole('button', { name: '保存复核记录', exact: true }).click();
    await until(async () => (await session()).status === 'reviewed', 'teacher note saved');
    check('teacher_note_persists_without_replacing_original_model_feedback');
    receipt.sessionId = sessionId; receipt.modelCalls = generated.modelCalls.map(({ kind, model, elapsedMs, requestId }) => ({ kind, model, elapsedMs, requestId }));
    receipt.asr = generated.turns.filter(t => t.source === 'asr').map(t => t.text); receipt.scoreSummary = generated.feedback.scoreSummary;
    receipt.patientTranscriptQuality={confirmed:generated.turns.filter(t=>t.role==='patient'&&t.final&&!t.interrupted).length,
      unverifiedParaphrases:generated.turns.filter(t=>t.verification==='paraphrase_unverified').length,interrupted:generated.turns.filter(t=>t.role==='patient'&&t.interrupted).length};
    receipt.nativeSocketEvents=await page.evaluate(()=>window.__hpbSafeSocketEvents);receipt.socketMessageCounts=await page.evaluate(()=>window.__hpbSocketMessageCounts);
    writeFileSync(resolve(out, 'synthetic-session.json'), JSON.stringify(await session(), null, 2));

    await browser.close(); browser = null;
    adb('shell', 'am', 'force-stop', 'edu.hpb.interview'); adb('shell', 'am', 'start', '-n', 'edu.hpb.interview/.MainActivity');
    await sleep(1200); await connect(); await page.getByRole('button', { name: '科研', exact: true }).click();
    await page.getByText(qaCode, { exact: true }).waitFor(); assert.equal((await native('credentialStatus', { ids: ['qwen-default'] })).entries[0].hasKey, true);
    assert.equal((await session()).review.reviewer, 'SIMULATED_ONLY-T01');
    const audio = await native('readAudio', { sessionId, role: 'learner' }); assert.ok(audio.exists); assert.equal(audio.sampleRate, 16000);
    const wav = Buffer.from(audio.audio, 'base64'); assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16000);
    check('force_stop_restart_keeps_native_key_registration_session_teacher_note_and_wav');
    await page.locator('#export-study').selectOption(study.id);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '导出科研 ZIP 并分享', exact: true }).click();
    await until(async () => /ResolverActivity|ChooserActivity/.test(adb('shell', 'dumpsys', 'activity', 'activities')), 'Android ZIP chooser');
    const cacheFiles = adb('shell', 'run-as', 'edu.hpb.interview', 'find', 'cache', '-type', 'f').split('\n').filter(x => x.endsWith('.zip'));
    const latest = cacheFiles.sort().at(-1); assert.ok(latest);
    const zip = execFileSync(adbPath, ['-s', serial, 'exec-out', 'run-as', 'edu.hpb.interview', 'cat', latest], { maxBuffer: 100 * 1024 * 1024 });
    assert.ok(!zip.includes(Buffer.from(key))); writeFileSync(resolve(out, 'native-research-export.zip'), zip);
    receipt.export = { path: resolve(out, 'native-research-export.zip'), bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex') };
    check('native_streaming_zip_is_created_and_android_share_chooser_opens');
    adb('shell', 'input', 'keyevent', '4');
    assert.equal(await listeningPort(8787), false); assert.equal(await listeningPort(8788), false);
    assert.equal(receipt.errors.length, 0, receipt.errors.join('; '));
    receipt.status = 'passed';
  } catch (error) { receipt.status = 'failed'; receipt.error = String(error.message).replace(/sk-[\w-]+/g, '[REDACTED]'); process.exitCode = 1;
    if(page){receipt.nativeSocketEvents=await page.evaluate(()=>window.__hpbSafeSocketEvents).catch(()=>[]);receipt.socketMessageCounts=await page.evaluate(()=>window.__hpbSocketMessageCounts).catch(()=>({}));}
    // Never capture a visible key entry field, even on a failed configuration step.
    if (page && !await page.locator('#provider-key').count().catch(() => 1)) await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
  } finally {
    await browser?.close().catch(() => {});
    try { adb('forward', '--remove', 'tcp:19222'); } catch { /* Already disconnected. */ }
    writeFileSync(resolve(out, 'standalone-android-verification.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ status: receipt.status, checks: receipt.checks.length, sessionId: receipt.sessionId, error: receipt.error }, null, 2));
  }
})();
