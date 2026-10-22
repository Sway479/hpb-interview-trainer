// Offline UI regression. Use only a dedicated emulator with fictional QA data.
// No .env/credential reads, provider probes, or model requests are performed.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { playwright, adbPath } = require('./platform-tools.cjs');

const serial = process.env.HPB_ANDROID_SERIAL;
const output = process.env.HPB_UI_QA_DIR;
assert.match(serial || '', /^emulator-\d+$/, 'Set HPB_ANDROID_SERIAL to a dedicated emulator');
assert.ok(output, 'Set HPB_UI_QA_DIR to a new output directory');
fs.mkdirSync(output, { recursive: false });
const adb = (...args) => execFileSync(adbPath(), ['-s', serial, ...args], { timeout: 20000 }).toString().trim();
const pkg = 'edu.hpb.interview';
const port = Number(process.env.HPB_UI_CDP_PORT || 19224);
const stamp = process.env.HPB_UI_QA_CODE || String(Date.now());
const code = ('SIMULATED_ONLY-UIFIX-' + stamp + '-').padEnd(64, 'X');
const participantCode = 'SIMULATED_ONLY-FIX-P-' + stamp;
const report = { simulatedOnly: true, serial, checks: [], screenshots: [], modelCallsAttempted: [], externalWebRequests: [], pageErrors: [] };
let browser, page;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = async (name, run) => { await run(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); };
const screenshot = name => { const file = path.join(output, name + '.png'); fs.writeFileSync(file, execFileSync(adbPath(), ['-s', serial, 'exec-out', 'screencap', '-p'])); report.screenshots.push({ file: name + '.png', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }); };
const foreground = () => adb('shell', 'dumpsys', 'activity', 'activities').includes('topResumedActivity=ActivityRecord') && /topResumedActivity=.*edu\.hpb\.interview/.test(adb('shell', 'dumpsys', 'activity', 'activities'));
const native = (method, options) => page.evaluate(({ method, options }) => window.Capacitor.Plugins.HpbNative[method](options), { method, options });
const back = async () => { adb('shell', 'input', 'keyevent', '4'); await sleep(450); };
const tab = async name => { await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click(); };

function guardTransport() {
  const cap = window.Capacitor;
  if (!cap || cap.__uiFixGuard) return;
  cap.__uiFixGuard = true;
  window.__uiFixModelCalls = [];
  const original = cap.nativePromise;
  cap.nativePromise = function(plugin, method, options) {
    if (plugin === 'HpbNative' && ['http', 'openSocket', 'sendSocket'].includes(method)) {
      window.__uiFixModelCalls.push(method);
      return Promise.reject(new Error('OFFLINE_UI_QA_BLOCKED_PROVIDER_CALL'));
    }
    return original.apply(this, arguments);
  };
}

async function connect() {
  const pid = adb('shell', 'pidof', pkg).split(/\s+/)[0];
  adb('forward', 'tcp:' + port, 'localabstract:webview_devtools_remote_' + pid);
  let last;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { browser = await playwright().chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 2000, noDefaults: true }); break; }
    catch (error) { last = error; await sleep(300); }
  }
  if (!browser?.isConnected()) throw last;
  const context = browser.contexts()[0];
  page = context.pages()[0];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await context.route('**/*', route => {
    if (route.request().url().startsWith('https://localhost/')) return route.continue();
    report.externalWebRequests.push(route.request().url().split('?')[0]);
    return route.abort();
  });
  await page.addInitScript(guardTransport);
  await page.waitForSelector('.case-card');
  await page.evaluate(guardTransport);
}

async function restart() {
  report.modelCallsAttempted.push(...await page.evaluate(() => window.__uiFixModelCalls || []));
  adb('shell', 'am', 'force-stop', pkg);
  adb('shell', 'am', 'start', '-W', '-n', pkg + '/.MainActivity');
  await connect();
}

async function jsonFolder(folder) {
  const { paths } = await native('listData', { path: folder });
  const result = {};
  for (const item of paths) {
    const name = item.startsWith(folder + '/') ? item : folder + '/' + item;
    const data = await native('readData', { path: name });
    if (data.exists) result[name] = crypto.createHash('sha256').update(data.data).digest('hex');
  }
  return result;
}

(async () => {
  adb('shell', 'svc', 'wifi', 'disable'); adb('shell', 'svc', 'data', 'disable');
  assert.equal(adb('shell', 'settings', 'get', 'global', 'wifi_on'), '0');
  await connect();
  const originalSessions = await jsonFolder('sessions');
  const originalStudies = await jsonFolder('studies');
  const originalParticipants = await jsonFolder('participants');
  await check('64-character research-code input boundary and Chinese fallback validation', async () => {
    await tab('科研');
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    assert.equal(await page.locator('#study-code').getAttribute('maxlength'), '64');
    await page.locator('#study-title').fill('SIMULATED_ONLY 界面修复离线验证');
    await page.locator('#study-code').pressSequentially(code + 'Y');
    assert.equal((await page.locator('#study-code').inputValue()).length, 64);
    // Deliberately bypass the DOM limit to exercise the application-level validator.
    await page.locator('#study-code').evaluate((input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, code + 'Y');
    await page.getByRole('button', { name: '保存项目登记', exact: true }).click();
    await page.getByText('项目编号最多 64 个字符，请缩短后保存。', { exact: true }).waitFor();
    assert.ok(!(await page.locator('dialog').innerText()).includes('too_big'));
    screenshot('01-chinese-code-validation');
    await page.locator('#study-code').fill(code);
    await page.getByRole('button', { name: '保存项目登记', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    await page.locator('.study-card').filter({ hasText: code }).click();
  });
  await check('64-character code saves unchanged and participant field limits match', async () => {
    await page.getByRole('button', { name: '登记学员', exact: true }).click();
    for (const [id, limit] of [['participant-code', '64'], ['participant-year', '50'], ['participant-group', '100'], ['participant-note', '2000']])
      assert.equal(await page.locator('#' + id).getAttribute('maxlength'), limit);
    await page.locator('#participant-code').fill(participantCode);
    await page.locator('#participant-consent').selectOption('not_applicable');
    await page.getByRole('button', { name: '保存学员登记', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'detached' });
  });
  await check('research project, learner and baseline are saved before success', async () => {
    await page.getByRole('button', { name: '科研模式', exact: true }).click();
    const studyId = await page.locator('#binding-study option').filter({ hasText: code }).getAttribute('value');
    await page.locator('#binding-study').selectOption(studyId);
    const participantId = await page.locator('#binding-participant option').filter({ hasText: participantCode }).getAttribute('value');
    await page.locator('#binding-participant').selectOption(participantId);
    await page.locator('#binding-phase').selectOption('baseline');
    await page.getByRole('button', { name: '设置下次训练', exact: true }).click();
    await page.getByText('已设置下次训练绑定；新训练开始时固定快照。', { exact: true }).waitFor();
    const saved = JSON.parse((await native('readData', { path: 'preferences/research-selection.json' })).data);
    assert.deepEqual(saved.selection, { mode: 'research', phase: 'baseline', studyId, participantId });
    report.savedSelection = saved;
  });
  await check('force-stop restart restores exact research UUIDs and baseline', async () => {
    await restart();
    await page.locator('.case-card').first().click();
    await page.locator('.research-context-card').filter({ hasText: participantCode }).waitFor();
    assert.match(await page.locator('.research-context-card').innerText(), /基线/);
    screenshot('02-research-binding-after-process-restart');
  });
  await check('Android system Back from case detail returns to cases without exiting', async () => {
    await back();
    await page.locator('.case-list').waitFor();
    assert.ok(foreground());
    screenshot('03-system-back-case-list');
  });
  await check('Android system Back closes an editor before navigating', async () => {
    await tab('科研');
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await back();
    await page.locator('dialog').waitFor({ state: 'detached' });
    await page.locator('.research-page').waitFor();
    assert.ok(foreground());
  });
  await check('root Back backgrounds safely and reopening retains the binding', async () => {
    await tab('训练'); await back(); assert.equal(foreground(), false);
    adb('shell', 'am', 'start', '-W', '-n', pkg + '/.MainActivity');
    await page.locator('.case-card').first().click();
    await page.locator('.research-context-card').filter({ hasText: participantCode }).waitFor();
    await back();
  });
  await check('invalid persisted binding blocks starting until explicitly reset', async () => {
    await native('writeData', { path: 'preferences/research-selection.json', data: '{invalid-ui-qa' });
    await restart();
    await page.getByText(/已保存的下次训练绑定不是有效配置/).waitFor();
    const close = page.getByRole('button', { name: '收起登记提示', exact: true });
    if (await close.count()) await close.click();
    await page.locator('.case-card').first().click();
    await page.locator('.case-start-footer button').click();
    await page.locator('.research-page').waitFor();
    await page.getByText(/上次训练绑定未能恢复，请重新设置训练用途/).waitFor();
    screenshot('04-invalid-binding-requires-confirmation');
    // Restore the known fictional selection through the UI, never change a session snapshot.
    await page.getByRole('button', { name: '科研模式', exact: true }).click();
    await page.locator('#binding-study').selectOption(report.savedSelection.selection.studyId);
    await page.locator('#binding-participant').selectOption(report.savedSelection.selection.participantId);
    await page.locator('#binding-phase').selectOption('baseline');
    await page.getByRole('button', { name: '设置下次训练', exact: true }).click();
    await page.getByText('已设置下次训练绑定；新训练开始时固定快照。', { exact: true }).waitFor();
  });
  await check('old registrations, session content and frozen snapshots are unchanged', async () => {
    assert.deepEqual(await jsonFolder('sessions'), originalSessions);
    for (const [folder, originals] of [['studies', originalStudies], ['participants', originalParticipants]]) {
      const current = await jsonFolder(folder);
      for (const name of Object.keys(originals)) assert.equal(current[name], originals[name]);
    }
    report.originalSessionsUnchanged = Object.keys(originalSessions).length;
  });
  report.modelCallsAttempted.push(...await page.evaluate(() => window.__uiFixModelCalls || []));
  assert.deepEqual(report.modelCallsAttempted, []);
  assert.deepEqual(report.externalWebRequests, []);
  assert.deepEqual(report.pageErrors, []);
  await tab('训练');
  report.status = 'passed';
})().catch(error => { report.status = 'failed'; report.error = String(error.stack || error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'ui-fixes-result.json'), JSON.stringify(report, null, 2));
  try { await browser?.close(); } catch {}
  try { adb('forward', '--remove', 'tcp:' + port); } catch {}
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, result: path.join(output, 'ui-fixes-result.json') }));
});
