import { z } from 'zod';
import { documents, clone, type DocumentStorage } from './storage';
import type { BackupData } from './contracts';
import type { Session, Study, Participant, LearnerSummary } from '../../../../packages/core/src/types';

export class LocalError extends Error { constructor(message: string, readonly status = 409) { super(message); } }
const id = z.string().uuid();
export const studySchema = z.object({ id, code: z.string().trim().min(1).max(64), title: z.string().trim().min(1).max(200),
  ethicsId: z.string().trim().max(120).optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export const participantSchema = z.object({ id, studyId: id, code: z.string().trim().min(1).max(64),
  trainingYear: z.string().trim().max(50).optional(), rotationMonths: z.number().min(0).max(600).optional(),
  group: z.string().trim().max(100).optional(), consent: z.enum(['not_recorded', 'recorded', 'not_applicable']),
  note: z.string().max(2000).optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export const summarySchema = z.object({ history: z.string().trim().min(10).max(6000), reasoning: z.string().trim().min(2).max(4000),
  plan: z.string().trim().min(2).max(4000), uncertainty: z.string().trim().min(2).max(4000) }).strict();
const draftSchema=z.object({history:z.string().max(10000),reasoning:z.string().max(10000),plan:z.string().max(10000),uncertainty:z.string().max(10000)}).strict();
const turnSchema = z.object({ id: z.string().min(1).max(200), role: z.enum(['learner', 'patient']), text: z.string().max(20000),
  at: z.string().datetime(), source: z.enum(['typed', 'asr', 'model']), final: z.boolean(), interrupted: z.boolean().optional(),
  verification: z.enum(['matches_flash', 'paraphrase_unverified']).optional() }).strict();
const scoreSchema = z.union([z.literal(0),z.literal(1),z.literal(2),z.null()]);
const evidenceSchema = z.object({turnId:z.string().min(1).max(200),quote:z.string().max(20000)}).strict();
const groupSchema = z.enum(['case_history','communication_process']);
const scoreSummarySchema = z.object({group:groupSchema,label:z.string().max(500),score:z.number().min(0),maxScore:z.number().min(0),
  scoredItems:z.number().int().min(0),totalItems:z.number().int().min(0),coverage:z.number().min(0).max(1)}).strict();
const feedbackSchema = z.object({overview:z.string().max(20000),items:z.array(z.object({
  criterionId:z.string().min(1).max(200),label:z.string().max(500),status:z.enum(['observed','to_improve','insufficient_evidence']),
  comment:z.string().max(20000),evidence:z.array(evidenceSchema).max(500),score:scoreSchema.optional(),maxScore:z.literal(2).optional(),
  group:groupSchema.optional(),sourceIds:z.array(z.string().max(200)).max(100).optional(),notScoredReason:z.enum(['insufficient_evidence','not_applicable','unobservable']).optional(),
  zeroEvidence:evidenceSchema.extend({problem:z.string().max(20000)}).optional(),
}).strict()).max(500),nextPractice:z.array(z.string().max(20000)).max(100),model:z.string().max(300),createdAt:z.string().datetime(),reviewStatus:z.literal('pending'),
  assessment:z.object({id:z.string().max(200),version:z.string().max(100),name:z.string().max(500),adapted:z.literal(true),
    sources:z.array(z.object({id:z.string().max(200),title:z.string().max(1000),url:z.string().max(4096).nullable(),kind:z.enum(['guidance','primary_research','local_adaptation']),note:z.string().max(20000)}).strict()).max(100),
    limitations:z.array(z.string().max(20000)).max(100)}).strict().optional(),
  scoreSummary:z.object({case_history:scoreSummarySchema,communication_process:scoreSummarySchema}).strict().optional(),
}).strict();
const reviewSchema=z.object({reviewer:z.string().max(100),notes:z.string().max(6000),at:z.string().datetime(),
  corrections:z.array(z.object({criterionId:z.string().max(200),score:scoreSchema,reason:z.string().max(6000)}).strict()).max(500).optional()}).strict();
const researchSchema=z.object({mode:z.enum(['practice','research']),phase:z.enum(['baseline','training','post','retention']),
  studyId:id.optional(),participantId:id.optional(),studyCode:z.string().max(64).optional(),studyTitle:z.string().max(200).optional(),
  participantCode:z.string().max(64).optional(),trainingYear:z.string().max(50).optional(),rotationMonths:z.number().min(0).max(600).optional(),
  group:z.string().max(100).optional(),consent:z.enum(['not_recorded','recorded','not_applicable']).optional(),attemptIndex:z.number().int().min(1),capturedAt:z.string().datetime()}).strict();
const companySchema=z.enum(['qwen','openai','deepseek','custom']);
const runtimeTextSchema=z.object({profileId:z.string().min(1).max(100),company:companySchema,endpoint:z.string().max(4096),model:z.string().min(1).max(300)}).strict();
const runtimeSchema=z.object({appVersion:z.string().max(100),engineVersion:z.string().max(100),patientPromptVersion:z.string().max(100),feedbackPromptVersion:z.string().max(100),
  assessmentId:z.string().max(200),assessmentVersion:z.string().max(100),text:runtimeTextSchema,
  voice:runtimeTextSchema.extend({protocol:z.enum(['qwen','openai','none']),voice:z.string().max(200)}).optional()}).strict();
const sessionSchema = z.object({ id, caseId: z.string().min(1).max(100), caseVersion: z.string().min(1).max(60), caseTitle: z.string().max(200),
  createdAt: z.string().datetime(), endedAt: z.string().datetime().optional(),
  status: z.enum(['interview', 'summary', 'feedback_pending', 'feedback_ready', 'reviewed']), turns: z.array(turnSchema).max(20000),
  summary:summarySchema.optional(),feedback:feedbackSchema.optional(),feedbackError:z.string().max(20000).optional(),
  recordings:z.object({learner:z.boolean(),patient:z.boolean(),learnerRate:z.number().int().positive().max(192000).optional(),patientRate:z.number().int().positive().max(192000).optional()}).strict().optional(),
  modelCalls:z.array(z.object({at:z.string().datetime(),kind:z.enum(['patient_reply','assessment']),model:z.string().max(300),elapsedMs:z.number().min(0),
    question:z.string().max(20000).optional(),answer:z.string().max(20000).optional(),profileId:z.string().max(100).optional(),company:z.string().max(100).optional(),
    endpoint:z.string().max(4096).optional(),requestId:z.string().max(1000).optional(),usage:z.record(z.string(),z.unknown()).optional()}).strict()).max(50000).optional(),
  review:reviewSchema.optional(),reviewHistory:z.array(reviewSchema).max(1000).optional(),research:researchSchema.optional(),runtime:runtimeSchema.optional(),
  auditEvents:z.array(z.object({id:z.string().min(1).max(200),at:z.string().datetime(),type:z.string().max(200),reason:z.string().max(20000).optional()}).strict()).max(50000).optional(),
  feedbackAttempts:z.array(z.object({id:z.string().min(1).max(200),at:z.string().datetime(),model:z.string().max(300),raw:z.string().max(2*1024*1024),accepted:z.boolean(),error:z.string().max(20000).optional()}).strict()).max(1000).optional(),
}).strict();
const backupSchema = z.object({ schemaVersion: z.literal('0.2'), exportedAt: z.string().datetime(), simulatedCases: z.literal(true),
  studies: z.array(studySchema).max(1000), participants: z.array(participantSchema).max(20000),
  sessions: z.array(sessionSchema).max(20000), drafts: z.record(z.string(),draftSchema).optional(),
}).strict();
const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+stable(v)).join(',') + '}';
  return JSON.stringify(value);
}
function rejectSecrets(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(api[-_]?key|authorization|password|credentials?|secret|DASHSCOPE_API_KEY|QIANWEN_API_KEY)$/i.test(key))
      throw new LocalError('备份包含凭证字段，不能作为科研数据导入。', 400);
    rejectSecrets(child);
  }
}
export class LocalRepository {
  private sessions = new Map<string, Session>();
  private studies = new Map<string, Study>();
  private participants = new Map<string, Participant>();
  private initialized?: Promise<void>;
  private writing = Promise.resolve();
  readonly warnings: { path: string; message: string; raw?: string }[] = [];
  constructor(private readonly storage: DocumentStorage = documents) {}
  initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.load().catch(error => { this.initialized = undefined; throw error; });
    return this.initialized;
  }
  private async recoverImport() {
    const raw = await this.storage.read('imports/pending.json'); if (!raw) return;
    const pending = z.array(z.object({ path: z.string().regex(/^(studies|participants|sessions|drafts)\/[\da-f-]{36}\.json$/), data: z.string() })).max(50000).parse(JSON.parse(raw));
    for (const operation of pending) await this.storage.write(operation.path, operation.data);
    await this.storage.remove('imports/pending.json');
  }
  private async load() {
    await this.recoverImport();
    this.sessions.clear(); this.studies.clear(); this.participants.clear(); this.warnings.length = 0;
    const loadFolder = async (folder: string, schema: z.ZodType, map: Map<string, any>) => {
      for (const path of await this.storage.list(folder)) {
        let raw: string | null = null;
        try {
          if (!/\/[\da-f-]{36}\.json$/.test(path)) continue;
          raw = await this.storage.read(path); if (!raw) continue;
          const value: any = schema.parse(JSON.parse(raw));
          if (path !== `${folder}/${value.id}.json`) throw new Error('记录ID与文件名不一致');
          if (folder === 'sessions' && value.status === 'feedback_pending') {
            value.status = 'summary'; value.feedbackError = '上次反馈生成中断，独立总结已保存，可以重试。';
            await this.storage.write(path, JSON.stringify(value));
          }
          map.set(value.id, value);
        } catch { this.warnings.push({ path, message: '此记录无法读取，原文件保留，请导出恢复资料后核对。', raw: raw ?? undefined }); }
      }
    };
    await loadFolder('studies', studySchema, this.studies);
    await loadFolder('participants', participantSchema, this.participants);
    await loadFolder('sessions', sessionSchema, this.sessions);
    for (const participant of this.participants.values()) if (!this.studies.has(participant.studyId))
      this.warnings.push({ path: `participants/${participant.id}.json`, message: '学员关联的研究项目缺失，登记原文保留。' });
  }
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    await this.initialize();
    const task = this.writing.catch(() => undefined).then(run);
    this.writing = task.then(() => undefined, () => undefined);
    return task;
  }
  async get(id: string): Promise<Session> { await this.initialize(); const value = this.sessions.get(id); if (!value) throw new LocalError('会话不存在。',404); return clone(value); }
  async list(): Promise<Session[]> { await this.initialize(); return [...this.sessions.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(clone); }
  async create(value: Session): Promise<Session> {
    return this.exclusive(async () => { if(this.sessions.has(value.id)) throw new LocalError('会话编号重复。');
      sessionSchema.parse(value); await this.storage.write(`sessions/${value.id}.json`,JSON.stringify(value)); this.sessions.set(value.id,clone(value));return clone(value); });
  }
  async mutate(id: string, update: (value: Session) => void): Promise<Session> {
    return this.exclusive(async()=>{const current=this.sessions.get(id);if(!current)throw new LocalError('会话不存在。',404);
      const next=clone(current);update(next);await this.storage.write(`sessions/${id}.json`,JSON.stringify(next));this.sessions.set(id,next);return clone(next);});
  }
  async listStudies():Promise<Study[]>{await this.initialize();return [...this.studies.values()].map(clone).sort((a,b)=>a.code.localeCompare(b.code));}
  async listParticipants(studyId?:string):Promise<Participant[]>{await this.initialize();return [...this.participants.values()].filter(x=>!studyId||x.studyId===studyId).map(clone).sort((a,b)=>a.code.localeCompare(b.code));}
  async saveStudy(value:Study):Promise<Study>{return this.exclusive(async()=>{const next=studySchema.parse(value);
    if([...this.studies.values()].some(x=>x.id!==next.id&&x.code.toLocaleLowerCase()===next.code.toLocaleLowerCase()))throw new LocalError('项目代码已存在。');
    await this.storage.write(`studies/${next.id}.json`,JSON.stringify(next));this.studies.set(next.id,next);return clone(next);});}
  async saveParticipant(value:Participant):Promise<Participant>{return this.exclusive(async()=>{const next=participantSchema.parse(value);
    if(!this.studies.has(next.studyId))throw new LocalError('请先登记对应的研究项目。');
    if([...this.participants.values()].some(x=>x.id!==next.id&&x.studyId===next.studyId&&x.code.toLocaleLowerCase()===next.code.toLocaleLowerCase()))throw new LocalError('该项目下的学员编号已存在。');
    const old=this.participants.get(next.id);if(old&&old.studyId!==next.studyId)throw new LocalError('已有学员不能移动到另一项目；请新建对应登记。');
    await this.storage.write(`participants/${next.id}.json`,JSON.stringify(next));this.participants.set(next.id,next);return clone(next);});}
  async deleteParticipant(id:string):Promise<void>{return this.exclusive(async()=>{if([...this.sessions.values()].some(s=>s.research?.participantId===id))throw new LocalError('该登记已关联训练记录，不能删除。可保留原记录并在备注中说明更正。');
    await this.storage.remove(`participants/${id}.json`);this.participants.delete(id);});}
  async getDraft(id:string):Promise<LearnerSummary|null>{await this.get(id);const raw=await this.storage.read(`drafts/${id}.json`);if(!raw)return null;
    try{return draftSchema.parse(JSON.parse(raw));}catch{throw new LocalError('总结草稿无法读取，原文件保留。');}}
  async saveDraft(id:string,value:LearnerSummary|null):Promise<void>{await this.get(id);return this.exclusive(async()=>{if(value===null)await this.storage.remove(`drafts/${id}.json`);else await this.storage.write(`drafts/${id}.json`,JSON.stringify(draftSchema.parse(value)));});}
  async backup(studyId?:string,sessionId?:string):Promise<BackupData>{await this.initialize();
    const sessions=(await this.list()).filter(s=>(!studyId||s.research?.studyId===studyId)&&(!sessionId||s.id===sessionId));
    const studyIds=new Set(sessions.map(s=>s.research?.studyId).filter(Boolean));if(studyId)studyIds.add(studyId);
    const studies=(await this.listStudies()).filter(s=>!studyId&&!sessionId||studyIds.has(s.id));
    const participantIds=new Set(sessions.map(s=>s.research?.participantId).filter(Boolean));
    const participants=(await this.listParticipants()).filter(p=>sessionId?participantIds.has(p.id):!studyId||p.studyId===studyId);
    const drafts:Record<string,LearnerSummary>={};for(const session of sessions){const draft=await this.getDraft(session.id);if(draft)drafts[session.id]=draft;}
    return {schemaVersion:'0.2',exportedAt:new Date().toISOString(),simulatedCases:true,studies,participants,sessions,drafts};}
  async importBackup(text:string):Promise<{studies:number;participants:number;sessions:number;drafts:number;skipped:number}>{
    if(text.length>25*1024*1024)throw new LocalError('JSON备份超过25MB，请分项目导入。',400);
    let input:unknown;try{input=JSON.parse(text);}catch{throw new LocalError('不是有效的JSON备份。',400);}rejectSecrets(input);
    const parsed=backupSchema.safeParse(input);
    if(!parsed.success){const issue=parsed.error.issues[0];throw new LocalError('备份数据结构无效：'+issue.path.join('.')+'。请使用本App导出的完整backup.json。',400);}
    const value=parsed.data as BackupData;
    return this.exclusive(async()=>{
      const operations:{path:string;data:string}[]=[];const counts={studies:0,participants:0,sessions:0,drafts:0,skipped:0};
      const studyIds=new Set([...this.studies.keys(),...value.studies.map(s=>s.id)]);
      const participantById=new Map([...this.participants.entries(),...value.participants.map(p=>[p.id,p] as const)]);
      const incomingIds=new Set<string>();
      const add=(folder:'studies'|'participants'|'sessions',items:any[],map:Map<string,any>)=>{for(const item of items){const key=folder+'/'+item.id;
        if(incomingIds.has(key))throw new LocalError('备份内存在重复ID。',400);incomingIds.add(key);const old=map.get(item.id);
        if(old){if(!equal(old,item))throw new LocalError('同一编号已有不同内容，导入已拒绝，原数据未覆盖：'+item.id);counts.skipped++;continue;}
        if(folder==='studies'&&[...this.studies.values(),...value.studies.filter(s=>s.id!==item.id)].some(s=>s.code.toLocaleLowerCase()===item.code.toLocaleLowerCase()))throw new LocalError('备份项目代码与现有记录冲突。');
        if(folder==='participants'){
          if(!studyIds.has(item.studyId))throw new LocalError('备份学员关联的项目缺失。',400);
          if([...this.participants.values(),...value.participants.filter(p=>p.id!==item.id)].some(p=>p.studyId===item.studyId&&p.code.toLocaleLowerCase()===item.code.toLocaleLowerCase()))throw new LocalError('备份学员编号与现有登记冲突。');
        }
        if(folder==='sessions'&&item.research){
          const research=item.research;
          if(research.studyId&&!studyIds.has(research.studyId)||research.participantId&&!participantById.has(research.participantId))throw new LocalError('备份训练关联的项目或学员缺失。',400);
          if(research.participantId&&(!research.studyId||participantById.get(research.participantId)?.studyId!==research.studyId))throw new LocalError('备份训练的学员与研究项目不匹配。',400);
        }
        operations.push({path:`${folder}/${item.id}.json`,data:JSON.stringify(item)});counts[folder]++;
      }};
      add('studies',value.studies,this.studies);add('participants',value.participants,this.participants);add('sessions',value.sessions,this.sessions);
      const sessionIds=new Set([...this.sessions.keys(),...value.sessions.map(s=>s.id)]);
      for(const [draftId,draft] of Object.entries(value.drafts??{})){id.parse(draftId);if(!sessionIds.has(draftId))throw new LocalError('备份草稿没有对应会话。',400);
        const path=`drafts/${draftId}.json`,old=await this.storage.read(path);if(old){if(!equal(JSON.parse(old),draft))throw new LocalError('已有不同的总结草稿，原内容未覆盖。');counts.skipped++;}else{operations.push({path,data:JSON.stringify(draft)});counts.drafts++;}}
      if(!operations.length)return counts;
      await this.storage.write('imports/pending.json',JSON.stringify(operations));
      try{for(const operation of operations)await this.storage.write(operation.path,operation.data);await this.storage.remove('imports/pending.json');}
      catch(error){this.initialized=undefined;throw new LocalError('导入尚未完成。原始导入日志已保存，释放存储空间后重新打开App将恢复导入。');}
      for(const study of value.studies)this.studies.set(study.id,clone(study));for(const participant of value.participants)this.participants.set(participant.id,clone(participant));for(const session of value.sessions)this.sessions.set(session.id,clone(session));
      return counts;
    });
  }
}
