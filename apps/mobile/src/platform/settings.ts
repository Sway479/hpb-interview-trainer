import { Capacitor } from '@capacitor/core';
import { HpbNative } from './native-bridge';
import { documents, clone } from './storage';
import { chatEndpoint } from './providers';
import type { ConnectionSettings, ProviderProfile, CredentialStatuses } from './contracts';

const cacheKey = 'hpb.standalone.settings.v2';
export function defaultSettings(): ConnectionSettings {
  return { mode:'standalone', textProfileId:'qwen-default', voiceProfileId:'qwen-default', profiles:[
    {id:'qwen-default',name:'千问',company:'qwen',chatUrl:'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions',chatModel:'qwen3.8-flash',
      realtimeProtocol:'qwen',realtimeUrl:'wss://maas.qianwenaiapi.com/api-ws/v1/realtime',realtimeModel:'qwen-audio-3.1-realtime-plus',voice:'longanqian_v3.1'},
    {id:'openai-default',name:'OpenAI',company:'openai',chatUrl:'https://api.openai.com/v1/chat/completions',chatModel:'gpt-4.1-mini',
      realtimeProtocol:'openai',realtimeUrl:'wss://api.openai.com/v1/realtime',realtimeModel:'gpt-realtime',voice:'marin'},
    {id:'deepseek-default',name:'DeepSeek',company:'deepseek',chatUrl:'https://api.deepseek.com/chat/completions',chatModel:'deepseek-flash',
      realtimeProtocol:'none',realtimeUrl:'',realtimeModel:'',voice:''},
  ] };
}
export function normalizeProfile(value: ProviderProfile): ProviderProfile {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value.id)) throw new Error('API配置编号无效。');
  if (!['qwen','openai','deepseek','custom'].includes(value.company)) throw new Error('请选择支持的API公司或兼容接口。');
  if (!value.name.trim() || value.name.length>100 || !value.chatModel.trim() || value.chatModel.length>200) throw new Error('请填写配置名称和文本模型名。');
  const next:ProviderProfile={id:value.id,name:value.name.trim(),company:value.company,chatUrl:chatEndpoint(value),chatModel:value.chatModel.trim(),
    realtimeProtocol:value.realtimeProtocol,realtimeUrl:value.realtimeUrl.trim(),realtimeModel:value.realtimeModel.trim(),voice:value.voice.trim()};
  if (!['qwen','openai','none'].includes(next.realtimeProtocol))throw new Error('请选择已适配的实时语音协议。');
  if(next.company==='deepseek'&&next.realtimeProtocol!=='none')throw new Error('当前DeepSeek配置仅支持文本模型。');
  if(next.realtimeProtocol==='none'){next.realtimeUrl='';next.realtimeModel='';next.voice='';}
  else{
    const url=new URL(next.realtimeUrl);
    if(url.protocol!=='wss:'||url.username||url.password||url.hash||[...url.searchParams.keys()].some(k=>k!=='model'))throw new Error('实时语音须使用不含密钥的WSS地址。');
    url.searchParams.delete('model');next.realtimeUrl=url.toString();
    if(!next.realtimeModel||!next.voice||next.realtimeModel.length>200||next.voice.length>100)throw new Error('请填写实时模型和音色。');
  }
  return next;
}
export function validateSettings(value: ConnectionSettings): ConnectionSettings {
  if(!value||!Array.isArray(value.profiles)||value.profiles.length<1||value.profiles.length>30)throw new Error('请保存至少一个API配置，最多30个。');
  const profiles=value.profiles.map(normalizeProfile);
  if(new Set(profiles.map(p=>p.id)).size!==profiles.length)throw new Error('API配置编号重复。');
  if(!profiles.some(p=>p.id===value.textProfileId))throw new Error('请选择文本模型配置。');
  if(value.voiceProfileId&&!profiles.some(p=>p.id===value.voiceProfileId&&p.realtimeProtocol!=='none'))throw new Error('所选语音配置不支持实时语音。');
  return {mode:'standalone',profiles,textProfileId:value.textProfileId,voiceProfileId:value.voiceProfileId||''};
}
export function readSettings():ConnectionSettings{try{if(typeof localStorage!=='undefined'){const raw=localStorage.getItem(cacheKey);if(raw)return validateSettings(JSON.parse(raw));}}catch{/* Nonsecret cache can be restored from native data. */}return defaultSettings();}
export async function loadSettings():Promise<ConnectionSettings>{const raw=await documents.read('config/settings.json');if(!raw)return readSettings();try{return validateSettings(JSON.parse(raw));}catch{throw new Error('本机API配置文件无法读取，原配置保留。请检查备份或重新保存配置。');}}
export async function saveSettings(value:ConnectionSettings):Promise<ConnectionSettings>{const next=validateSettings(value);await documents.write('config/settings.json',JSON.stringify(next));try{localStorage.setItem(cacheKey,JSON.stringify(next));}catch{/* Native persisted copy is authoritative. */}return clone(next);}
export async function credentialStatus(ids:string[]):Promise<CredentialStatuses>{if(!Capacitor.isNativePlatform())return Object.fromEntries(ids.map(id=>[id,{hasKey:false}]));const result=await HpbNative.credentialStatus({ids});return Object.fromEntries(result.entries.map(entry=>[entry.id,{hasKey:entry.hasKey}]));}
export function profileOrigins(value:ProviderProfile):string[]{const origins=[new URL(value.chatUrl).origin];if(value.realtimeProtocol!=='none'){const url=new URL(value.realtimeUrl);url.protocol='https:';origins.push(url.origin);}return [...new Set(origins)].sort();}
export async function saveProfile(value:ProviderProfile,key?:string):Promise<ConnectionSettings>{
  const profile=normalizeProfile(value),settings=await loadSettings();const previous=settings.profiles.find(p=>p.id===profile.id);
  const status=await credentialStatus([profile.id]);
  if(key?.trim()){
    if(!Capacitor.isNativePlatform())throw new Error('请在安卓App中保存API密钥；浏览器预览不持久化密钥。');
    if(key.trim().length<8||key.trim().length>8192)throw new Error('API密钥长度不正确。');
    await HpbNative.saveCredential({id:profile.id,key:key.trim(),origins:profileOrigins(profile)});
  }else if(previous&&status[profile.id]?.hasKey&&JSON.stringify(profileOrigins(previous))!==JSON.stringify(profileOrigins(profile)))throw new Error('接口域名已改变，请重新填写该公司的API密钥。');
  const profiles=settings.profiles.filter(p=>p.id!==profile.id);profiles.push(profile);
  return saveSettings({...settings,profiles});
}
