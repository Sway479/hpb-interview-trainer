// Uses a previously stored credential reference. No key is read, and no inference is requested.
const platformTools = require('./platform-tools.cjs');
const { chromium } = platformTools.playwright();
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { createHash } = require('node:crypto');
const adbPath=platformTools.adbPath(),serial=process.env.HPB_ANDROID_SERIAL||'emulator-5554';
const adb=(...args)=>execFileSync(adbPath,['-s',serial,...args],{encoding:'utf8'}).trim();
const output=process.argv[2]||'artifacts/standalone/native-heartbeat-probe.json';
const apk=process.argv[3]||'artifacts/android/hpb-voice-standalone-debug.apk';
const duration=Number(process.env.HPB_HEARTBEAT_PROBE_MS||80000);
const receipt={at:new Date().toISOString(),scope:'native_stored_profile_websocket_idle_probe_without_inference',durationMs:duration,apkSha256:createHash('sha256').update(readFileSync(apk)).digest('hex')};
let browser,page;
(async()=>{try{
  const line=adb('shell','cat','/proc/net/unix').split('\n').find(x=>/@webview_devtools_remote_\d+/.test(x));
  adb('forward','tcp:19222','localabstract:'+line.match(/@(webview_devtools_remote_\d+)/)[1]);
  browser=await chromium.connectOverCDP('http://127.0.0.1:19222',{noDefaults:true});page=browser.contexts()[0].pages()[0];
  await page.evaluate(async()=>{
    const plugin=window.Capacitor.Plugins.HpbNative;
    const data=await plugin.readData({path:'config/settings.json'}),settings=JSON.parse(data.data),profile=settings.profiles.find(p=>p.id==='qwen-default');
    const url=new URL(profile.realtimeUrl);url.searchParams.set('model',profile.realtimeModel);
    const id='qa-heartbeat-'+Date.now();window.__hpbHeartbeat={id,events:[],counts:{},started:Date.now()};
    window.__hpbHeartbeat.handle=await plugin.addListener('socketEvent',event=>{
      if(event.id!==id)return;
      const probe=window.__hpbHeartbeat;
      if(event.type==='message'){
        const data=JSON.parse(event.data);probe.counts[data.type]=(probe.counts[data.type]||0)+1;
        if(data.type==='session.created')void plugin.sendSocket({id,data:JSON.stringify({type:'session.update',session:{modalities:['text'],voice:profile.voice,instructions:'连接稳定性检测。等待，不主动生成任何回答。',turn_detection:{type:'server_vad'}}})});
      }else{const{data,...safe}=event;probe.events.push({...safe,observedElapsedMs:Date.now()-probe.started});}
    });
    await plugin.openSocket({id,profileId:profile.id,url:url.toString()});
  });
  const started=Date.now();
  while(Date.now()-started<duration){const state=await page.evaluate(()=>({events:window.__hpbHeartbeat.events,counts:window.__hpbHeartbeat.counts}));
    if(state.events.some(e=>e.type==='error'||e.type==='close'))break;
    await new Promise(r=>setTimeout(r,500));}
  Object.assign(receipt,await page.evaluate(()=>({events:window.__hpbHeartbeat.events,counts:window.__hpbHeartbeat.counts})));
  receipt.outcome=receipt.events.some(e=>e.type==='error'||e.type==='close')?'closed_during_observation':'stayed_open';
  receipt.status=receipt.events.some(e=>e.type==='open')&&receipt.counts['session.updated']?'observed':'failed';
}catch(error){receipt.status='failed';receipt.error=error.message;process.exitCode=1;}finally{
  if(page)await page.evaluate(async()=>{const p=window.__hpbHeartbeat;if(p){await window.Capacitor.Plugins.HpbNative.closeSocket({id:p.id});await p.handle?.remove();}}).catch(()=>{});
  await browser?.close().catch(()=>{});try{adb('forward','--remove','tcp:19222');}catch{}
  mkdirSync(require('node:path').dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
}})();
