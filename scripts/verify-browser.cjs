// Local media acceptance check. Uses an isolated Edge profile and synthetic speech.
const platformTools = require('./platform-tools.cjs');
const { chromium } = platformTools.playwright();
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const out = resolve('artifacts/ui'); mkdirSync(out, { recursive: true });
  const browserPath = platformTools.browserExecutable();
  const receipt = { at: new Date().toISOString(), kind: 'synthetic_browser_audio_acceptance', browser: browserPath || 'Playwright managed Chromium', viewport: '390x844', checks: [], errors: [] };
  const browser = await chromium.launch({
    executablePath: browserPath, headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--use-file-for-fake-audio-capture=' + resolve('.cache/browser-fake-mic.wav'), '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true, locale: 'zh-CN', permissions: ['microphone'] });
  const page = await context.newPage();
  const frames = [];
  const check = text => { receipt.checks.push(text); console.log('PASS ' + text); };
  page.on('pageerror', e => receipt.errors.push(e.message));
  page.on('websocket', socket => socket.on('framereceived', event => {
    try { frames.push(JSON.parse(String(event.payload))); } catch { /* Non-application payload. */ }
  }));
  async function wait(predicate, label, timeout = 60000) {
    const started = Date.now();
    while (!predicate()) {
      const error = frames.find(frame => frame.type === 'error');
      if (error) throw new Error(label + ': ' + error.message);
      if (Date.now() - started > timeout) throw new Error(label + ': timeout');
      await page.waitForTimeout(100);
    }
  }
  const patientIds = () => new Set(frames.filter(e => e.type === 'turn' && e.turn.role === 'patient' && e.turn.final).map(e => e.turn.id));
  try {
    await page.goto(process.env.HPB_BROWSER_URL || 'http://127.0.0.1:8788');
    await page.getByRole('button', { name: /右上腹痛/ }).click();
    await page.getByRole('button', { name: '开始语音问诊', exact: true }).click();
    await page.getByRole('button', { name: '静音麦克风', exact: true }).waitFor({ timeout: 60000 });
    check('real_frontend_microphone_permission_and_wavtools_capture_ready');
    await wait(() => frames.some(e => e.type === 'turn' && e.turn.role === 'learner' && e.turn.final && e.turn.text.includes('不舒服')), 'browser microphone ASR');
    check('synthetic_audio_travels_browser_worklet_gateway_qwen_asr');
    await page.getByRole('button', { name: '静音麦克风', exact: true }).click();
    await wait(() => patientIds().size >= 2 && frames.filter(e => e.type === 'reasoning_done').length >= 2, 'patient voice after question');
    assert.ok(frames.some(e => e.type === 'audio' && e.audio));
    check('qwen_audio_calls_flash_and_returns_patient_audio_in_ui');
    await page.screenshot({ path: resolve(out, 'mobile-live-interview-390.png'), fullPage: true });
    const questions = [
      '疼痛从什么时候开始，是一直痛还是一阵阵痛，有什么诱因？',
      '有没有发热、寒战、眼睛黄、小便颜色改变或者恶心呕吐？',
      '以前有类似发作或胆结石吗，目前用什么药，有药物过敏吗？',
      '您最担心什么？我想先把症状问清楚，再核实生命体征并请带教老师评估，您还有需要补充的吗？',
    ];
    for (const question of questions) {
      const before = patientIds(); const doneBefore = frames.filter(e => e.type === 'reasoning_done').length;
      await page.locator('#typed-message').fill(question);
      await page.getByRole('button', { name: '发送文字', exact: true }).click();
      await wait(() => [...patientIds()].some(id => !before.has(id)) && frames.filter(e => e.type === 'reasoning_done').length > doneBefore, 'typed question and patient voice');
    }
    check('four_case_specific_questions_flow_through_dual_model_ui');
    await page.getByRole('button', { name: '结束问诊，撰写总结', exact: true }).click();
    await page.getByRole('button', { name: '结束并写总结', exact: true }).click();
    await page.locator('#summary-history').waitFor();
    check('end_interview_opens_independent_summary_before_feedback');
    const summary = {
      history: '虚构患者陈女士，48岁，主诉右上腹痛1天。病史信息以本次问诊原文为准，包括疼痛的起病、诱因和伴随症状，既往胆石症及用药过敏情况仍需核对。',
      reasoning: '目前为右上腹痛情境，需要结合胆道病史与其他上腹部来源进一步鉴别。不能只凭症状确认诊断或严重程度。',
      plan: '补齐病史缺口，核实生命体征、体格检查和必要检查资料，请带教医师评估，并回应患者对检查和手术的担忧。',
      uncertainty: '本次尚无实际查体、化验和影像资料，部分语音转述也需结合录音核对，不能确认诊断。',
    };
    for (const [field, value] of Object.entries(summary)) await page.locator('#summary-' + field).fill(value);
    const feedbackRequest = page.waitForResponse(r => r.request().method() === 'POST' && /\/summary$/.test(new URL(r.url()).pathname), { timeout: 90000 });
    await page.getByRole('button', { name: '提交总结，查看复盘', exact: true }).click();
    const response = await feedbackRequest; const result = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(result));
    assert.equal(result.status, 'feedback_ready'); assert.equal(result.feedback.model, 'qwen3.8-flash');
    await page.getByRole('heading', { name: '本次问诊回顾', exact: true }).waitFor();
    assert.ok(result.modelCalls.some(call => call.kind === 'patient_reply' && call.model === 'qwen3.8-flash'));
    check('independent_summary_submits_then_real_flash_feedback_renders');
    assert.equal(result.feedback.assessment?.id, 'hpb-voice-formative-assessment');
    assert.equal(result.feedback.assessment?.version, '0.1');
    assert.equal(result.feedback.assessment.adapted, true);
    assert.equal(result.feedback.items.length, 12);
    assert.ok(result.feedback.scoreSummary);
    check('source_version_and_twelve_criterion_reference_scores_present');
    for (const item of result.feedback.items) for (const e of item.evidence) assert.ok(result.turns.some(t => t.id === e.turnId && t.final && t.text.includes(e.quote)));
    check('feedback_quotes_match_confirmed_learner_records');
    await page.screenshot({ path: resolve(out, 'mobile-feedback-390.png'), fullPage: true });
    receipt.sessionId = result.id;
    receipt.feedbackModel = result.feedback.model;
    receipt.assessment = result.feedback.assessment;
    receipt.scoreSummary = result.feedback.scoreSummary;
    receipt.modelCalls = result.modelCalls.map(({ at, kind, model, elapsedMs }) => ({ at, kind, model, elapsedMs }));
    receipt.asr = result.turns.filter(t => t.source === 'asr').map(t => t.text);
    receipt.events = frames.reduce((counts, e) => { counts[e.type] = (counts[e.type] || 0) + 1; return counts; }, {});
    assert.equal(receipt.errors.length, 0, receipt.errors.join('\n'));
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = 'failed'; receipt.error = error.message; process.exitCode = 1;
    await page.screenshot({ path: resolve(out, 'browser-audio-failure.png'), fullPage: true }).catch(() => {});
  } finally {
    await context.close(); await browser.close();
    writeFileSync(resolve(out, 'browser-audio-e2e.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt, null, 2));
  }
})();
