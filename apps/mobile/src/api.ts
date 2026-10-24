import { Capacitor } from '@capacitor/core';
import { ZodError } from 'zod';
import { HpbNative } from './platform/native-bridge';
import { localService } from './platform/local-service';
import { credentialStatus,loadSettings,saveSettings,readSettings,validateSettings,saveProfile } from './platform/settings';
import { completeChat,safeProviderMessage } from './platform/providers';
import { probeRealtime } from './platform/realtime';
import { researchFiles,recoveryNotice,type ResearchExportScope } from './platform/export-data';
import { loadFeedbackPreferences,saveFeedbackPreferences } from './platform/feedback-preferences';
import type { SummaryOptions } from './platform/local-service';
import type { ConnectionSettings,ExportResult,ResearchExportOptions,ProbeResult } from './platform/contracts';
import type { LearnerSummary,ResearchSelection,Session,TeacherCorrection } from '../../../packages/core/src/types';
export type {CasePreview,LearnerSummary,Session,Turn,FeedbackItem,TeacherCorrection,ServerEvent,ClientEvent} from '../../../packages/core/src/types';
export type {ConnectionSettings,ProviderProfile,Study,Participant,ResearchSelection,ExportResult} from './platform/contracts';
export type { FeedbackGeneration,FeedbackPreferences,FeedbackPreferencesResult } from './platform/feedback-preferences';
export type { SummaryOptions } from './platform/local-service';
export {readSettings,validateSettings,saveSettings};
export interface Health {status:string;configured:boolean;model:string;brainModel?:string;brainConfigured?:boolean;endpoint?:string;requiresToken:false;warnings?:string[]}
export interface DataWarningMetadata {path:string;message:string;hasRecoveryText:boolean}
export function errorMessage(error:unknown){if(error instanceof ZodError){const issue=error.issues[0];return '填写的数据格式或长度无效'+(issue?.path.length?'（'+issue.path.join('.')+'）':'')+'，请核对后重试。';}return error instanceof Error?safeProviderMessage(error):'操作未完成，请重试。';}
async function exportData(options:ResearchExportOptions,sessionId?:string):Promise<ExportResult>{
  const scope:ResearchExportScope=sessionId?'session':options.studyId?'study':'all';
  const backup=await localService.repository.backup(options.studyId,sessionId),warnings=localService.repository.warnings;
  const files=researchFiles(backup,options.includeAudio,warnings,scope);
  const dataWarningCount=warnings.length,notice=recoveryNotice(dataWarningCount,scope);
  const warningResult={dataWarningCount,...(notice?{recoveryNotice:notice}:{})};
  const fileName=`hpb-research-${new Date().toISOString().replace(/[:.]/g,'-')}.zip`;
  if(!Capacitor.isNativePlatform()){
    const content=JSON.stringify(backup,null,2);
    return {fileName:fileName.replace(/\.zip$/,'.json'),bytes:new Blob([content]).size,content,shared:false,
      ...warningResult,...(notice?{recoveryNotice:`本机有${dataWarningCount}条异常资料。浏览器JSON只含可读取记录，不含异常原文，不能作为完整备份；请在安卓App中选择“本机全部资料”生成ZIP并核对恢复资料。`}:{})};
  }
  const result=await HpbNative.exportPackage({fileName,textFiles:files,recordingSessionIds:backup.sessions.filter(s=>s.recordings?.learner||s.recordings?.patient).map(s=>s.id),includeAudio:options.includeAudio});
  try{await HpbNative.sharePackage({uri:result.uri,fileName:result.fileName,mimeType:'application/zip'});return {...result,shared:true,...warningResult};}
  catch{throw new Error('导出包已在App私有缓存生成，但系统分享面板未能打开。请检查可接收ZIP的应用后重新导出。');}
}
export const api={
  settings:loadSettings,
  feedbackPreferences:loadFeedbackPreferences,
  saveFeedbackPreferences,
  credentialStatus,saveProfile,
  async deleteProfile(id:string):Promise<ConnectionSettings>{const settings=await loadSettings();if(settings.profiles.length===1)throw new Error('请至少保留一个API配置。');
    const active=(await localService.list()).some(s=>(s.status==='interview'||s.status==='feedback_pending'||s.status==='summary'&&s.turns.some(t=>t.role==='learner'&&t.final&&!t.interrupted&&t.text.trim()))&&(s.runtime?.text.profileId===id||s.status==='interview'&&s.runtime?.voice?.profileId===id));if(active)throw new Error('该配置仍关联未结束问诊或待生成反馈，请先完成对应会话。');
    const profiles=settings.profiles.filter(p=>p.id!==id);if(profiles.length===settings.profiles.length)return settings;
    const next=await saveSettings({...settings,profiles,textProfileId:settings.textProfileId===id?profiles[0].id:settings.textProfileId,voiceProfileId:settings.voiceProfileId===id?'':settings.voiceProfileId});
    if(Capacitor.isNativePlatform())await HpbNative.deleteCredential({id});return next;},
  async health(settings:ConnectionSettings):Promise<Health>{await localService.repository.initialize();const keys=await credentialStatus(settings.profiles.map(p=>p.id)),voice=settings.profiles.find(p=>p.id===settings.voiceProfileId),text=settings.profiles.find(p=>p.id===settings.textProfileId);
    return {status:'ok',configured:Boolean(voice&&keys[voice.id]?.hasKey),model:voice?.realtimeModel??'文字模式',brainModel:text?.chatModel,brainConfigured:Boolean(text&&keys[text.id]?.hasKey),endpoint:voice?.realtimeUrl,requiresToken:false,warnings:localService.repository.warnings.map(x=>x.message)};},
  async probe(settings:ConnectionSettings,capability:'text'|'voice'):Promise<ProbeResult>{
    if(!Capacitor.isNativePlatform())return {ok:false,capability,message:'请在安卓App中检测直连接口；浏览器仅用于界面与本机登记预览。'};
    const profile=settings.profiles.find(p=>p.id===(capability==='text'?settings.textProfileId:settings.voiceProfileId));if(!profile)return {ok:false,capability,message:'请先选择对应的API配置。'};
    const keys=await credentialStatus([profile.id]);if(!keys[profile.id]?.hasKey)return {ok:false,capability,message:'该配置尚未保存API密钥。'};
    if(capability==='voice')return {...await probeRealtime(profile),capability};
    try{const result=await completeChat(profile,'这是一项接口连通检测，只回复OK。','请回复OK。',{purpose:'probe',timeoutMs:30_000});return {ok:true,capability,message:'文本API鉴权与返回内容成功。',model:result.model};}
    catch(error){return {ok:false,capability,message:errorMessage(error),model:profile.chatModel};}
  },
  cases:(_settings?:ConnectionSettings)=>localService.cases(),
  async dataWarnings():Promise<DataWarningMetadata[]>{await localService.repository.initialize();return localService.repository.warnings.map(({path,message,raw})=>({path,message,hasRecoveryText:raw!==undefined}));},
  sessions:(_settings?:ConnectionSettings)=>localService.list(),
  session:(_settings:ConnectionSettings,id:string)=>localService.get(id),
  async start(settings:ConnectionSettings,caseId:string,selection?:ResearchSelection){
    const {preferences}=await loadFeedbackPreferences();
    return localService.start(settings,caseId,selection,preferences[selection?.mode??'practice']);
  },
  text:(settings:ConnectionSettings,id:string,text:string)=>localService.text(settings,id,text),
  end:(_settings:ConnectionSettings,id:string)=>localService.end(id),
  summary:(settings:ConnectionSettings,id:string,value:LearnerSummary,options?:SummaryOptions)=>localService.summary(settings,id,value,options),
  review:(_settings:ConnectionSettings,id:string,reviewer:string,notes:string,corrections?:TeacherCorrection[])=>localService.review(id,reviewer,notes,corrections),
  export:(_settings:ConnectionSettings,id:string)=>localService.repository.backup(undefined,id),
  recordingBlob:(id:string,role:'learner'|'patient')=>localService.recordingBlob(id,role),
  getDraft:(id:string)=>localService.getDraft(id),saveDraft:(id:string,value:LearnerSummary|null)=>localService.saveDraft(id,value),
  studies:()=>localService.studies(),participants:(studyId?:string)=>localService.participants(studyId),
  saveStudy:(value:Parameters<typeof localService.saveStudy>[0])=>localService.saveStudy(value),
  saveParticipant:(value:Parameters<typeof localService.saveParticipant>[0])=>localService.saveParticipant(value),
  deleteParticipant:(id:string)=>localService.deleteParticipant(id),
  researchExport:(options:ResearchExportOptions)=>exportData(options),
  shareSession:(id:string,options:{includeAudio:boolean})=>exportData(options,id),
  importBackup:(text:string)=>localService.importBackup(text),
};
