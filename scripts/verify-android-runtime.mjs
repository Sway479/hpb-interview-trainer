// Dedicated development emulator only. This probes WebView APIs; it is not a physical-device audio quality test.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import platformTools from './platform-tools.cjs';

const adbPath = platformTools.adbPath();
const serial = process.env.HPB_ANDROID_SERIAL || 'emulator-5554';
const apk = resolve(process.argv[2] || 'artifacts/android/hpb-voice-prototype-debug.apk');
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }).trim();
const receipt = { at: new Date().toISOString(), scope: 'dedicated_android_emulator_webview_api_probe', serial,
  apk: { path: apk, sha256: createHash('sha256').update(readFileSync(apk)).digest('hex') }, checks: [], limitations: [
    'Emulator uses no-audio mode. Captured frames do not prove a real microphone, audible playback, speaker echo control or Bluetooth routing.',
    'The API probe is separate from the paid browser end-to-end Qwen/Flash test. It does not call a model or create a training session.'
  ] };
let socket;
try {
  receipt.packageVersion = adb('shell', 'dumpsys', 'package', 'edu.hpb.interview').split('\n').find(line => line.includes('versionName='))?.trim();
  receipt.webview = adb('shell', 'dumpsys', 'webviewupdate').split('\n').find(line => line.includes('Current WebView package'))?.trim();
  const entry = adb('shell', 'cat', '/proc/net/unix').split('\n').find(line => /@webview_devtools_remote_\d+/.test(line));
  if (!entry) throw new Error('The prototype WebView debugger is not running. Launch its installed development APK first.');
  const abstract = entry.match(/@(webview_devtools_remote_\d+)/)[1];
  adb('forward', 'tcp:19222', 'localabstract:' + abstract);
  const pages = await (await fetch('http://127.0.0.1:19222/json')).json();
  const page = pages.find(page => page.type === 'page' && page.url.startsWith('https://localhost/'));
  if (!page) throw new Error('Prototype WebView page was not found.');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject); });
  let nextId = 0;
  const pending = new Map();
  socket.on('message', raw => { const event = JSON.parse(raw.toString()); const request = pending.get(event.id);
    if (request) { pending.delete(event.id); clearTimeout(request.timer); event.error ? request.reject(new Error(event.error.message)) : request.resolve(event.result); } });
  const command = (method, params = {}) => new Promise((resolveCommand, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 15000);
    pending.set(id, { resolve: resolveCommand, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  receipt.capabilities = await evaluate(`({ secure:window.isSecureContext, getUserMedia:typeof navigator.mediaDevices?.getUserMedia==='function',
    audioWorklet:typeof AudioWorkletNode==='function', userAgent:navigator.userAgent,
    cases:['右上腹痛','发热伴黄疸','上腹痛','无痛性黄疸'].filter(t=>document.body.innerText.includes(t)).length,
    flexGapFallback:document.documentElement.classList.contains('no-flex-gap'),
    safeAreaInsets:{top:getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-top'),bottom:getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-bottom')},
    caseCardGap:(()=>{const c=document.querySelectorAll('.case-card');return c.length>1?c[1].getBoundingClientRect().top-c[0].getBoundingClientRect().bottom:0;})(),
    caseIconGap:(()=>{const i=document.querySelector('.case-icon'),t=document.querySelector('.case-info');return i&&t?t.getBoundingClientRect().left-i.getBoundingClientRect().right:0;})() })`);
  if (!receipt.capabilities.secure || !receipt.capabilities.getUserMedia || !receipt.capabilities.audioWorklet || receipt.capabilities.cases !== 4)
    throw new Error('Required native WebView UI/audio capabilities were not present.');
  receipt.checks.push('installed_apk_renders_four_cases_and_has_secure_media_apis');
  if (receipt.capabilities.caseCardGap < 9 || receipt.capabilities.caseIconGap < 14)
    throw new Error('Case cards or icons lost their layout spacing in the native WebView.');
  receipt.checks.push('native_case_card_and_icon_spacing_preserved_with_legacy_flex_gap_fallback');
  const consoleLog = adb('logcat', '-d', '-v', 'brief', '-s', 'Capacitor/Console', 'chromium', 'AndroidRuntime');
  receipt.console = { uncaughtOrFatal: consoleLog.split('\n').filter(line => /Uncaught|FATAL EXCEPTION/.test(line)),
    caughtEarlySafeAreaWarnings: consoleLog.split('\n').filter(line => line.includes('Error injecting safe area CSS')).length,
    note: 'Capacitor SystemBars catches pre-DOM inset injection errors and requests insets again onPageCommitVisible; final CSS variables and screenshot are recorded separately.' };
  if (receipt.console.uncaughtOrFatal.length) throw new Error('An uncaught app or activity failure was logged.');
  writeFileSync('artifacts/android/runtime-console.txt', consoleLog);
  adb('shell', 'pm', 'grant', 'edu.hpb.interview', 'android.permission.RECORD_AUDIO');
  receipt.mediaProbe = await evaluate(`(async()=>{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const context=new AudioContext({sampleRate:16000});
    const output=new AudioContext({sampleRate:24000});
    let source,node,frames=0;
    try {
      await context.resume(); await output.resume();
      const url=URL.createObjectURL(new Blob(['class Probe extends AudioWorkletProcessor { process(i){if(i[0]&&i[0][0])this.port.postMessage(i[0][0].length);return true;} } registerProcessor("hpb-acceptance-probe",Probe);'],{type:'text/javascript'}));
      try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      source=context.createMediaStreamSource(stream); node=new AudioWorkletNode(context,'hpb-acceptance-probe');
      node.port.onmessage=e=>{frames+=e.data;}; source.connect(node); node.connect(context.destination);
      await new Promise(r=>setTimeout(r,700));
      return {inputRate:context.sampleRate,outputRate:output.sampleRate,contextState:context.state,frames,tracks:stream.getAudioTracks().map(t=>({kind:t.kind,readyState:t.readyState}))};
    } finally { node?.disconnect();source?.disconnect();stream.getTracks().forEach(t=>t.stop());await context.close();await output.close(); }
  })()`);
  if (receipt.mediaProbe.inputRate !== 16000 || receipt.mediaProbe.outputRate !== 24000 || receipt.mediaProbe.frames < 128)
    throw new Error('WebView media graph did not produce the required PCM sampling frames.');
  receipt.checks.push('android_permission_granted_media_capture_and_audioworklet_frames_at_required_rates');
  adb('shell', 'screencap', '-p', '/sdcard/hpb-prototype-runtime.png');
  adb('pull', '/sdcard/hpb-prototype-runtime.png', 'artifacts/android/emulator-cases-final.png');
  receipt.status = 'passed';
} catch (error) { receipt.status = 'failed'; receipt.error = error.message; process.exitCode = 1; }
finally {
  socket?.terminate();
  try { adb('forward', '--remove', 'tcp:19222'); } catch { /* No active forwarding remained. */ }
  mkdirSync('artifacts/android', { recursive: true });
  writeFileSync('artifacts/android/runtime-verification.json', JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
