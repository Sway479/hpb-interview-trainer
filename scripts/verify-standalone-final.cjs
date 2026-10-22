// Targeted final-APK check after the navigation-scroll repair.
// Reuses the genuinely persisted synthetic Qwen session; does not regenerate its scores.
const platformTools = require('./platform-tools.cjs');
const { chromium } = platformTools.playwright();
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { parse } = require('dotenv');
const apk=resolve(process.argv[2]||'artifacts/android/hpb-voice-standalone-debug.apk');
const out=resolve('artifacts/standalone/final');mkdirSync(out,{recursive:true});
const core=JSON.parse(readFileSync('artifacts/standalone/android/standalone-android-verification.json','utf8'));
const sourceSession=JSON.parse(readFileSync('artifacts/standalone/android/synthetic-session.json','utf8'));
const adbPath=platformTools.adbPath(),serial=process.env.HPB_ANDROID_SERIAL||'emulator-5554';
const adb=(...args)=>execFileSync(adbPath,['-s',serial,...args],{encoding:'utf8'}).trim();
const receipt={at:new Date().toISOString(),scope:'final_apk_scroll_evidence_jump_native_restore_privacy_and_qwen_probe',
  apk:{path:apk,sha256:createHash('sha256').update(readFileSync(apk)).digest('hex')},coreFlowApkSha256:core.apk.sha256,sessionId:sourceSession.id,checks:[],pageErrors:[]};
let browser,page;
const check=name=>{receipt.checks.push(name);console.log('PASS '+name);};
const native=(method,options)=>page.evaluate(({method,options})=>window.Capacitor.nativePromise('HpbNative',method,options),{method,options});
const scrollTop=()=>page.evaluate(async()=>(await document.querySelector('ion-content').getScrollElement()).scrollTop);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(pick,label){const end=Date.now()+10000;while(Date.now()<end){if(await pick())return;await sleep(100);}throw new Error(label+' timed out');}
(async()=>{try{
  assert.equal(core.status,'passed');
  adb('install','-r',apk);adb('shell','am','force-stop','edu.hpb.interview');adb('shell','am','start','-n','edu.hpb.interview/.MainActivity');await sleep(1000);
  const line=adb('shell','cat','/proc/net/unix').split('\n').find(x=>/@webview_devtools_remote_\d+/.test(x));
  adb('forward','tcp:19222','localabstract:'+line.match(/@(webview_devtools_remote_\d+)/)[1]);
  browser=await chromium.connectOverCDP('http://127.0.0.1:19222',{noDefaults:true});page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(15000);
  page.on('pageerror',error=>receipt.pageErrors.push(error.message));
  await page.locator('.case-card').first().waitFor();
  const stored=JSON.parse((await native('readData',{path:'sessions/'+sourceSession.id+'.json'})).data);
  assert.deepEqual(stored,sourceSession);
  assert.equal((await native('credentialStatus',{ids:['qwen-default']})).entries[0].hasKey,true);
  check('final_apk_update_keeps_exact_accepted_session_original_scores_teacher_note_and_vault_key');
  await page.getByRole('button',{name:'科研',exact:true}).click();await page.locator('#export-study').scrollIntoViewIfNeeded();
  assert.ok(await scrollTop()>100);
  await page.getByRole('button',{name:'记录',exact:true}).click();await until(async()=>await scrollTop()<2,'history scroll reset');
  await page.locator('.history-card').first().click();await page.getByRole('heading',{name:'本次问诊回顾',exact:true}).waitFor();
  await until(async()=>await scrollTop()<2,'feedback scroll reset');
  const heading=await page.getByRole('heading',{name:'本次问诊回顾',exact:true}).boundingBox();assert.ok(heading&&heading.y<250);
  await page.screenshot({path:resolve(out,'final-feedback-top.png')});
  check('new_screen_starts_at_top_and_feedback_overview_is_visible');
  await page.getByRole('button',{name:/查看对应原文/}).first().click();
  await page.locator('.turn.highlighted').waitFor();
  await until(()=>page.locator('.turn.highlighted').evaluate(element=>{const r=element.getBoundingClientRect();return r.top>=60&&r.top<innerHeight-r.height/2;}),'evidence scroll remains visible');
  assert.ok(await scrollTop()>0);await page.screenshot({path:resolve(out,'final-evidence-jump.png')});
  check('evidence_jump_runs_after_screen_reset_and_highlights_actual_turn');
  const recordingRows=page.locator('.recording-row');
  for(let index=0;index<2;index++){
    await recordingRows.nth(index).getByRole('button',{name:'读取录音',exact:true}).click();
    await until(()=>recordingRows.nth(index).locator('audio').evaluate(audio=>Number.isFinite(audio.duration)&&audio.duration>0),'native WAV metadata');
  }
  receipt.audio=await page.locator('audio').evaluateAll(elements=>elements.map(a=>({duration:a.duration,readyState:a.readyState,srcKind:a.src.startsWith('blob:')?'blob':'other'})));
  check('both_role_native_recordings_open_as_real_audio_blobs_in_final_apk');
  await page.getByRole('button',{name:'返回',exact:true}).click();
  await page.getByRole('button',{name:'再练一个病例',exact:true}).click();
  await page.getByRole('button',{name:'科研',exact:true}).click();
  const json=execFileSync(platformTools.pythonCommand(),[
    '-c','import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read("backup.json"))','artifacts/standalone/android/native-research-export.zip']);
  await page.locator('input[type=file]').setInputFiles({name:'SIMULATED_ONLY-backup.json',mimeType:'application/json',buffer:json});
  await page.getByRole('button',{name:'校验并恢复 JSON 备份',exact:true}).click();
  await page.getByText(/恢复完成：项目 0，学员 0，会话 0，草稿 0；跳过一致记录 3/).waitFor();
  assert.deepEqual(JSON.parse((await native('readData',{path:'sessions/'+sourceSession.id+'.json'})).data),sourceSession);
  check('native_json_file_payload_import_skips_identical_records_and_preserves_original_data');
  await page.getByRole('button',{name:'API',exact:true}).click();
  await page.getByRole('button',{name:'检测文本',exact:true}).click();
  await page.getByText('文本：检测通过',{exact:true}).waitFor({timeout:45000});
  check('final_installed_apk_still_authenticates_direct_qwen_text_request');
  const key=parse(readFileSync('.env')).DASHSCOPE_API_KEY;
  assert.ok(key&&key.length>12);
  const preferences=execFileSync(adbPath,['-s',serial,'exec-out','run-as','edu.hpb.interview','cat','shared_prefs/hpb.credentials.v1.xml']);
  assert.ok(preferences.includes(Buffer.from('ciphertext'))&&!preferences.includes(Buffer.from(key)));
  const metadata=await native('readData',{path:'config/settings.json'});assert.ok(!metadata.data.includes(key));
  assert.equal(await page.evaluate(k=>JSON.stringify(localStorage).includes(k),key),false);
  const logs=execFileSync(adbPath,['-s',serial,'logcat','-d','-v','brief'],{maxBuffer:32*1024*1024});assert.ok(!logs.includes(Buffer.from(key)));
  check('exact_configured_key_absent_from_private_public_metadata_web_storage_and_android_logs');
  assert.equal(receipt.pageErrors.length,0);receipt.status='passed';
}catch(error){receipt.status='failed';receipt.error=String(error.message).replace(/sk-[\w-]+/g,'[REDACTED]');process.exitCode=1;
  if(page)await page.screenshot({path:resolve(out,'failure.png')}).catch(()=>{});
}finally{await browser?.close().catch(()=>{});try{adb('forward','--remove','tcp:19222');}catch{}
  writeFileSync(resolve(out,'final-apk-verification.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({status:receipt.status,checks:receipt.checks.length,error:receipt.error},null,2));}
})();
