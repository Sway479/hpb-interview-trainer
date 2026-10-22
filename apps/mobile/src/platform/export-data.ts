import type { BackupData } from './contracts';

type Row=Record<string,unknown>;
/** UTF-8 BOM, RFC4180 quoting, and spreadsheet formula escaping. Exact source stays in backup.json. */
export function toCsv(rows:Row[],columns:string[]):string {
  const cell=(value:unknown)=>{let text=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);
    if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
  return '\uFEFF'+[columns.map(cell).join(','),...rows.map(row=>columns.map(key=>cell(row[key])).join(','))].join('\r\n')+'\r\n';
}
export function researchFiles(backup:BackupData,includeAudio:boolean,warnings:readonly {path:string;message:string;raw?:string}[]=[]):{path:string;content:string}[]{
  const studies:Row[]=backup.studies.map(x=>({...x})),participants:Row[]=backup.participants.map(x=>({...x}));
  const sessions:Row[]=[],turns:Row[]=[],scores:Row[]=[],calls:Row[]=[],reviews:Row[]=[],attempts:Row[]=[],audit:Row[]=[];
  for(const session of backup.sessions){const r=session.research,t=session.runtime,a=session.feedback?.assessment;
    sessions.push({session_id:session.id,study_id:r?.studyId,study_code:r?.studyCode,participant_id:r?.participantId,participant_code:r?.participantCode,
      training_year_snapshot:r?.trainingYear,rotation_months_snapshot:r?.rotationMonths,group_snapshot:r?.group,consent_snapshot:r?.consent,
      mode:r?.mode,phase:r?.phase,attempt_index:r?.attemptIndex,case_id:session.caseId,case_version:session.caseVersion,case_title:session.caseTitle,
      created_at:session.createdAt,ended_at:session.endedAt,duration_seconds:session.endedAt?Math.max(0,(Date.parse(session.endedAt)-Date.parse(session.createdAt))/1000):null,
      status:session.status,learner_final_turns:session.turns.filter(x=>x.role==='learner'&&x.final&&!x.interrupted).length,
      text_company:t?.text.company,text_endpoint:t?.text.endpoint,text_model_requested:t?.text.model,voice_company:t?.voice?.company,voice_protocol:t?.voice?.protocol,voice_model_requested:t?.voice?.model,
      app_version:t?.appVersion,engine_version:t?.engineVersion,patient_prompt_version:t?.patientPromptVersion,feedback_prompt_version:t?.feedbackPromptVersion,
      assessment_id:a?.id,assessment_version:a?.version,feedback_model:session.feedback?.model,
      case_score:session.feedback?.scoreSummary?.case_history.score,case_scored_max:session.feedback?.scoreSummary?.case_history.maxScore,case_coverage:session.feedback?.scoreSummary?.case_history.coverage,
      process_score:session.feedback?.scoreSummary?.communication_process.score,process_scored_max:session.feedback?.scoreSummary?.communication_process.maxScore,process_coverage:session.feedback?.scoreSummary?.communication_process.coverage,
      learner_recording_expected:session.recordings?.learner??false,patient_recording_expected:session.recordings?.patient??false,
      learner_recording_incomplete:session.auditEvents?.some(e=>e.type==='recording_incomplete'&&e.reason?.startsWith('learner: '))??false,
      patient_recording_incomplete:session.auditEvents?.some(e=>e.type==='recording_incomplete'&&e.reason?.startsWith('patient: '))??false,
      history_summary:session.summary?.history,reasoning_summary:session.summary?.reasoning,plan_summary:session.summary?.plan,uncertainty_summary:session.summary?.uncertainty});
    session.turns.forEach((turn,index)=>turns.push({session_id:session.id,turn_id:turn.id,sequence:index+1,role:turn.role,source:turn.source,at:turn.at,text:turn.text,final:turn.final,interrupted:turn.interrupted??false,verification:turn.verification}));
    session.feedback?.items.forEach(item=>scores.push({session_id:session.id,criterion_id:item.criterionId,label:item.label,group:item.group,score:item.score,max_score:item.maxScore,status:item.status,
      not_scored_reason:item.notScoredReason,comment:item.comment,evidence:item.evidence,source_ids:item.sourceIds,zero_evidence:item.zeroEvidence,model:session.feedback?.model,generated_at:session.feedback?.createdAt,assessment_version:a?.version,grading_origin:'original_model_preassessment'}));
    session.modelCalls?.forEach((call,index)=>calls.push({session_id:session.id,call_index:index+1,...call}));
    [...(session.reviewHistory??[]),...(session.review?[session.review]:[])].forEach((review,index)=>reviews.push({session_id:session.id,review_revision:index+1,reviewer_code:review.reviewer,at:review.at,notes:review.notes,corrections:review.corrections,review_type:review.corrections?.length?'criterion_corrections':'notes_only'}));
    session.feedbackAttempts?.forEach(attempt=>attempts.push({session_id:session.id,...attempt}));
    session.auditEvents?.forEach(event=>audit.push({session_id:session.id,...event}));
  }
  const csv=(path:string,rows:Row[],emptyColumns:string[])=>({path,content:toCsv(rows,rows.length?[...new Set(rows.flatMap(row=>Object.keys(row)))]:emptyColumns)});
  const manifest={schemaVersion:'0.2',exportedAt:backup.exportedAt,simulatedCases:true,timestampSource:'device_clock_iso8601',includeAudio,
    counts:{studies:studies.length,participants:participants.length,sessions:sessions.length,turns:turns.length,assessments:scores.length,modelCalls:calls.length,auditEvents:audit.length},
    csv:{encoding:'UTF-8 with BOM',lineEnding:'CRLF',formulaEscaping:'An apostrophe is prepended to cells whose first non-whitespace character is = + - @. Exact original text remains in backup.json.'},
    audio:{inputRates:'Qwen 16000 Hz, OpenAI Realtime 24000 Hz; actual rate stored in native WAV headers',outputRate:24000,format:'PCM16LE mono WAV',streams:'learner and patient are separate sequential streams, not a synchronized conversation timeline',restoration:'JSON restores text/metadata; WAV files stay in the export ZIP and are not imported by JSON restore.'},
    assessment:'Adapted formative reference scores; denominators cover scored items only. Preserve original AI results alongside teacher notes/corrections. No validated pass line.',
    credentialExported:false,warnings:warnings.map(({path,message})=>({path,message}))};
  const files=[{path:'backup.json',content:JSON.stringify(backup,null,2)},{path:'manifest.json',content:JSON.stringify(manifest,null,2)},
    csv('studies.csv',studies,['id','code','title']),csv('participants.csv',participants,['id','studyId','code','group']),
    csv('sessions.csv',sessions,['session_id','study_id','participant_id','case_id']),csv('turns.csv',turns,['session_id','turn_id','role','text']),
    csv('assessments.csv',scores,['session_id','criterion_id','score','status']),csv('model_calls.csv',calls,['session_id','kind','model','elapsedMs']),
    csv('teacher_reviews.csv',reviews,['session_id','reviewer_code','notes']),csv('feedback_attempts.csv',attempts,['session_id','id','accepted','raw']),
    csv('audit_events.csv',audit,['session_id','id','at','type','reason']),
    {path:'README.txt',content:'问诊陪练科研导出 v0.2\n所有病例为虚构教学病例；研究登记不等于伦理或同意已获批准。\n学员编号由使用者登记，当前表按ID关联。sessions.csv中的组别、年级等是训练开始时快照。\nbackup.json为精确源数据及可恢复的文字/元数据备份；CSV对公式字符加前缀，分析时以JSON核对。\nassessments.csv保存原始模型参考分；teacher_reviews.csv单独保存复核，不覆盖原始结果。\n评分分母只含已评项目，结合coverage解释；不能把null当0。\n录音若选择包含，见audio与recordings-manifest.json；JSON恢复不自动恢复录音文件。\n模型耗时是API调用耗时，不是完整问诊语音延迟。\n时间来自设备时钟，建议科研前校对手机时间。\n'}];
  warnings.forEach((warning,index)=>{if(warning.raw)files.push({path:`recovery/record-${index+1}.txt`,content:warning.raw});});
  return files;
}
