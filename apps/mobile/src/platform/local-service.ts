import { getCase, listCases, patientInstructions } from '../../../../packages/core/src/cases';
import { getAssessmentMetadata } from '../../../../packages/core/src/assessment';
import { feedbackPrompt, validateFeedback } from '../../../../packages/core/src/feedback';
import { newId } from '../../../../packages/core/src/ids';
import type { Session, Turn, Study, Participant, LearnerSummary, ResearchSnapshot, TeacherCorrection } from '../../../../packages/core/src/types';
import { LocalRepository, LocalError, summarySchema } from './repository';
import { documents, audioStorage, clone, type DocumentStorage } from './storage';
import { credentialStatus } from './settings';
import { completeChat, safeProviderMessage, type ChatResult, type ChatOptions } from './providers';
import { APP_VERSION, ENGINE_VERSION, PATIENT_PROMPT_VERSION, FEEDBACK_PROMPT_VERSION, DEFAULT_RESEARCH_SELECTION,
  type ConnectionSettings, type ProviderProfile, type ResearchSelection } from './contracts';

interface Owner {stop():Promise<Session>;disconnect():Promise<void>}
interface Dependencies {repository?:LocalRepository;storage?:DocumentStorage;audio?:typeof audioStorage;
  credentials?:typeof credentialStatus;chat?:(profile:ProviderProfile,instructions:string,input:string,options?:ChatOptions)=>Promise<ChatResult>}
export class LocalService {
  readonly repository:LocalRepository;
  private storage:DocumentStorage;private audio:typeof audioStorage;private credentials:typeof credentialStatus;private chat:NonNullable<Dependencies['chat']>;
  private owners=new Map<string,Owner>();private textBusy=new Set<string>();private feedbackBusy=new Map<string,Promise<Session>>();
  private audioTasks=new Map<string,Promise<void>>();private createChain=Promise.resolve();
  private audioFailures=new Set<string>();
  constructor(options:Dependencies={}){this.storage=options.storage??documents;this.repository=options.repository??new LocalRepository(this.storage);this.audio=options.audio??audioStorage;
    this.credentials=options.credentials??credentialStatus;this.chat=options.chat??completeChat;}
  get=(id:string)=>this.repository.get(id);
  list=()=>this.repository.list();
  cases=async()=>listCases();
  async start(settings:ConnectionSettings,caseId:string,selection:ResearchSelection=DEFAULT_RESEARCH_SELECTION):Promise<Session>{
    const task=this.createChain.then(async()=>{
      const definition=getCase(caseId),text=settings.profiles.find(p=>p.id===settings.textProfileId),voice=settings.profiles.find(p=>p.id===settings.voiceProfileId);
      if(!text)throw new LocalError('请先选择文本模型配置。');
      const keys=await this.credentials([text.id]);if(!keys[text.id]?.hasKey)throw new LocalError('请先在API配置中保存文本模型的密钥。');
      const studies=await this.repository.listStudies(),participants=await this.repository.listParticipants();
      const study=studies.find(s=>s.id===selection.studyId),participant=participants.find(p=>p.id===selection.participantId);
      if(selection.mode==='research'&&(!study||!participant))throw new LocalError('科研模式请先选择已登记的项目与学员编号。');
      if(selection.studyId&&!study||selection.participantId&&!participant)throw new LocalError('所选科研登记不存在，请重新选择。');
      if(participant&&participant.studyId!==study?.id)throw new LocalError('学员编号与当前项目不匹配。');
      if(!['practice','research'].includes(selection.mode)||!['baseline','training','post','retention'].includes(selection.phase))throw new LocalError('训练用途或时间点无效。');
      const existing=await this.repository.list(),now=new Date().toISOString(),id=newId();
      const research:ResearchSnapshot={mode:selection.mode,phase:selection.phase,...(study?{studyId:study.id,studyCode:study.code,studyTitle:study.title}:{}),
        ...(participant?{participantId:participant.id,participantCode:participant.code,trainingYear:participant.trainingYear,rotationMonths:participant.rotationMonths,group:participant.group,consent:participant.consent}:{}),
        attemptIndex:existing.filter(s=>s.research?.participantId===participant?.id&&s.caseId===caseId&&s.research?.mode===selection.mode).length+1,capturedAt:now};
      const assessment=getAssessmentMetadata();const frozen:ConnectionSettings={...clone(settings),profiles:settings.profiles.filter(p=>p.id===text.id||p.id===voice?.id).map(p=>{const {hasKey,...publicProfile}=p;return clone(publicProfile);})};
      await this.storage.write(`execution/${id}.json`,JSON.stringify(frozen));
      return this.repository.create({id,caseId,caseVersion:definition.version,caseTitle:definition.title,createdAt:now,status:'interview',turns:[],research,
        runtime:{appVersion:APP_VERSION,engineVersion:ENGINE_VERSION,patientPromptVersion:PATIENT_PROMPT_VERSION,feedbackPromptVersion:FEEDBACK_PROMPT_VERSION,assessmentId:assessment.id,assessmentVersion:assessment.version,
          text:{profileId:text.id,company:text.company,endpoint:text.chatUrl,model:text.chatModel},
          ...(voice?{voice:{profileId:voice.id,company:voice.company,protocol:voice.realtimeProtocol,endpoint:voice.realtimeUrl,model:voice.realtimeModel,voice:voice.voice}}:{})},
        auditEvents:[{id:newId(),at:now,type:'session_created'}]});
    });this.createChain=task.then(()=>undefined,()=>undefined);return task;
  }
  async sessionSettings(settings:ConnectionSettings,id:string):Promise<ConnectionSettings>{const session=await this.get(id);const raw=await this.storage.read(`execution/${id}.json`);
    if(raw)return JSON.parse(raw) as ConnectionSettings;
    if(!session.runtime)throw new LocalError('历史备份缺少执行配置，只能回看或结束；请新建训练以继续使用模型。');
    const t=session.runtime.text,v=session.runtime.voice;const profiles:ProviderProfile[]=[{id:t.profileId,name:t.company,company:t.company,chatUrl:t.endpoint,chatModel:t.model,
      realtimeProtocol:v&&v.profileId===t.profileId?v.protocol as 'qwen'|'openai':'none',realtimeUrl:v?.profileId===t.profileId?v.endpoint:'',realtimeModel:v?.profileId===t.profileId?v.model:'',voice:v?.profileId===t.profileId?v.voice:''}];
    if(v&&v.profileId!==t.profileId)profiles.push({id:v.profileId,name:v.company,company:v.company,chatUrl:t.endpoint,chatModel:t.model,realtimeProtocol:v.protocol as 'qwen'|'openai',realtimeUrl:v.endpoint,realtimeModel:v.model,voice:v.voice});
    return {mode:'standalone',profiles,textProfileId:t.profileId,voiceProfileId:v?.profileId??''};}
  async claimVoice(id:string,owner:Owner){const session=await this.get(id);if(session.status!=='interview')throw new LocalError('问诊已结束。');
    if(this.owners.has(id)||this.textBusy.has(id))throw new LocalError('该会话已有活动连接。');this.owners.set(id,owner);}
  async releaseVoice(id:string,owner:Owner){if(this.owners.get(id)===owner)this.owners.delete(id);}
  addTurn=(id:string,turn:Turn)=>this.repository.mutate(id,s=>{if(s.status!=='interview')throw new LocalError('问诊已结束，不能增加发言。');
    const existing=s.turns.findIndex(t=>t.id===turn.id);if(existing<0)s.turns.push(clone(turn));else s.turns[existing]=clone(turn);});
  recordModelCall=(id:string,event:NonNullable<Session['modelCalls']>[number])=>this.repository.mutate(id,s=>{s.modelCalls=[...(s.modelCalls??[]),clone(event)];});
  async patientReply(settings:ConnectionSettings,id:string,question:string):Promise<ChatResult>{
    const session=await this.get(id);if(session.status!=='interview')throw new LocalError('问诊已结束。');const definition=getCase(session.caseId);
    if(definition.version!==session.caseVersion)throw new LocalError('此历史病例版本已改变，请新建训练；原记录保留。');
    const frozen=await this.sessionSettings(settings,id),profile=frozen.profiles.find(p=>p.id===frozen.textProfileId);if(!profile)throw new LocalError('本次会话缺少文本模型配置。');
    const reply=await this.chat(profile,patientInstructions(definition,session.turns),question,{purpose:'patient'});
    if(reply.text.length>700)throw new LocalError('患者回答过长，请重试该轮。');
    await this.recordModelCall(id,{at:new Date().toISOString(),kind:'patient_reply',model:reply.model,elapsedMs:reply.elapsedMs,question,answer:reply.text,
      profileId:profile.id,company:profile.company,endpoint:profile.chatUrl,requestId:reply.requestId,usage:reply.usage});return reply;
  }
  async text(settings:ConnectionSettings,id:string,text:string):Promise<Session>{
    if(!text.trim()||text.length>3000)throw new LocalError('文字问题需为1–3000字。',400);
    if(this.owners.has(id)||this.textBusy.has(id))throw new LocalError('患者正在回答或语音连接仍在使用该会话。');this.textBusy.add(id);
    try{const reply=await this.patientReply(settings,id,text.trim());await this.addTurn(id,{id:newId(),role:'learner',text:text.trim(),at:new Date().toISOString(),source:'typed',final:true});
      return await this.addTurn(id,{id:newId(),role:'patient',text:reply.text,at:new Date().toISOString(),source:'model',final:true});}finally{this.textBusy.delete(id);}
  }
  appendAudio(id:string,role:'learner'|'patient',audio:string,sampleRate:number):Promise<void>{
    const key=id+'/'+role;const task=(this.audioTasks.get(key)??Promise.resolve()).catch(()=>undefined).then(async()=>{
      await this.audio.append(id,role,audio,sampleRate);const session=await this.get(id);
      if(!session.recordings?.[role])await this.repository.mutate(id,s=>{s.recordings={learner:false,patient:false,...s.recordings,[role]:true,[role==='learner'?'learnerRate':'patientRate']:sampleRate};});
    });this.audioTasks.set(key,task);return task;
  }
  async flushAudio(id:string){await Promise.all([...this.audioTasks].filter(([key])=>key.startsWith(id+'/')).map(([,task])=>task));}
  async recordAudioFailure(id:string,role:'learner'|'patient',message:string):Promise<void>{
    const key=id+'/'+role;this.audioTasks.delete(key);
    if(this.audioFailures.has(key))return;
    await this.repository.mutate(id,s=>{const reason=role+': '+safeProviderMessage(new Error(message)).slice(0,2000);
      if(!s.auditEvents?.some(event=>event.type==='recording_incomplete'&&event.reason?.startsWith(role+': ')))s.auditEvents=[...(s.auditEvents??[]),{id:newId(),at:new Date().toISOString(),type:'recording_incomplete',reason}];});
    this.audioFailures.add(key);
  }
  setRecordings=(id:string,recordings:NonNullable<Session['recordings']>)=>this.repository.mutate(id,s=>{s.recordings={...s.recordings,...recordings};});
  recordingBlob=(id:string,role:'learner'|'patient')=>this.audio.blob(id,role);
  async end(id:string):Promise<Session>{if(this.textBusy.has(id))throw new LocalError('患者正在回答，请等待后结束。');const owner=this.owners.get(id);if(owner)return owner.stop();return this.commitEnd(id);}
  async commitEnd(id:string):Promise<Session>{return this.repository.mutate(id,s=>{if(s.status!=='interview')return;s.status='summary';s.endedAt=new Date().toISOString();s.auditEvents=[...(s.auditEvents??[]),{id:newId(),at:s.endedAt,type:'interview_ended'}];});}
  async summary(settings:ConnectionSettings,id:string,value:LearnerSummary):Promise<Session>{
    if(this.feedbackBusy.has(id))return this.feedbackBusy.get(id)!;
    const summary=summarySchema.parse(value);
    const task=(async()=>{const session=await this.repository.mutate(id,s=>{if(s.status!=='summary')throw new LocalError('请先结束问诊；已生成的反馈不能重复提交。');
        if(!s.turns.some(t=>t.role==='learner'&&t.final&&!t.interrupted&&t.text.trim()))throw new LocalError('没有已确认的学员问诊记录，暂不能评分。');
        s.summary=clone(summary);s.status='feedback_pending';delete s.feedbackError;});
      const definition=getCase(session.caseId);let raw='',model='';
      try{
        if(definition.version!==session.caseVersion)throw new LocalError('历史病例版本已改变，原记录可回看，本版不重新生成评分。');
        const frozen=await this.sessionSettings(settings,id),profile=frozen.profiles.find(p=>p.id===frozen.textProfileId);if(!profile)throw new LocalError('缺少本次训练的模型配置。');
        model=profile.chatModel;const prompt=feedbackPrompt(definition,session),result=await this.chat(profile,prompt.instructions,prompt.input,{purpose:'assessment'});raw=result.text;model=result.model;
        await this.recordModelCall(id,{at:new Date().toISOString(),kind:'assessment',model,elapsedMs:result.elapsedMs,profileId:profile.id,company:profile.company,endpoint:profile.chatUrl,requestId:result.requestId,usage:result.usage});
        const feedback=validateFeedback(raw,definition,session,model);
        return this.repository.mutate(id,s=>{if(s.status!=='feedback_pending')throw new LocalError('反馈状态已改变。');s.feedback=feedback;s.status='feedback_ready';s.feedbackAttempts=[...(s.feedbackAttempts??[]),{id:newId(),at:new Date().toISOString(),model,raw,accepted:true}];});
      }catch(error){const message=safeProviderMessage(error);await this.repository.mutate(id,s=>{if(s.status==='feedback_pending'){s.status='summary';s.feedbackError='总结已保存，反馈尚未完成：'+message;if(raw)s.feedbackAttempts=[...(s.feedbackAttempts??[]),{id:newId(),at:new Date().toISOString(),model,raw,accepted:false,error:message}];}});throw new LocalError('总结已保存，可以重试反馈：'+message,502);}
    })();this.feedbackBusy.set(id,task);try{return await task;}finally{this.feedbackBusy.delete(id);}
  }
  review=(id:string,reviewer:string,notes:string,corrections?:TeacherCorrection[])=>this.repository.mutate(id,s=>{
    if(!s.feedback||!['feedback_ready','reviewed'].includes(s.status))throw new LocalError('反馈尚未生成。');if(!reviewer.trim()||reviewer.length>100||notes.trim().length<2||notes.length>6000)throw new LocalError('请填写复核者编号及备注。');
    if(corrections){const ids=new Set<string>();for(const item of corrections){if(ids.has(item.criterionId)||!s.feedback.items.some(c=>c.criterionId===item.criterionId)||![0,1,2,null].includes(item.score)||!item.reason.trim())throw new LocalError('教师修正项目或理由无效。');ids.add(item.criterionId);}}
    if(s.review)s.reviewHistory=[...(s.reviewHistory??[]),clone(s.review)];s.review={reviewer:reviewer.trim(),notes:notes.trim(),at:new Date().toISOString(),...(corrections?{corrections:clone(corrections)}:{})};s.status='reviewed';});
  studies=()=>this.repository.listStudies();
  participants=(studyId?:string)=>this.repository.listParticipants(studyId);
  async saveStudy(input:Omit<Study,'id'|'createdAt'|'updatedAt'>&Partial<Pick<Study,'id'|'createdAt'|'updatedAt'>>){const old=input.id?(await this.studies()).find(s=>s.id===input.id):undefined;const now=new Date().toISOString();return this.repository.saveStudy({...input,id:input.id??newId(),createdAt:old?.createdAt??now,updatedAt:now});}
  async saveParticipant(input:Omit<Participant,'id'|'createdAt'|'updatedAt'>&Partial<Pick<Participant,'id'|'createdAt'|'updatedAt'>>){const old=input.id?(await this.participants()).find(p=>p.id===input.id):undefined;const now=new Date().toISOString();return this.repository.saveParticipant({...input,id:input.id??newId(),createdAt:old?.createdAt??now,updatedAt:now});}
  deleteParticipant=(id:string)=>this.repository.deleteParticipant(id);
  getDraft=(id:string)=>this.repository.getDraft(id);
  saveDraft=(id:string,value:LearnerSummary|null)=>this.repository.saveDraft(id,value);
  async importBackup(text:string){if(this.owners.size||this.textBusy.size||this.feedbackBusy.size)throw new LocalError('请先结束或断开当前训练，再导入备份。');return this.repository.importBackup(text);}
}
export const localService=new LocalService();
