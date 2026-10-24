import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSessions, EMPTY_SESSION_FILTERS, getSessionWorkflow, sessionWorkflowLabel, summarizeWorkQueue, sessionDateFilterError } from '../apps/mobile/src/session-filters.ts';
import type { Session } from '../packages/core/src/types.ts';

const sessions = [
  {id:'old',caseTitle:'右上腹痛'},
  {id:'a',caseTitle:'黄疸',research:{mode:'research',studyId:'study-a',studyCode:'OLD-A',participantCode:'P01'},feedback:{},review:{notes:'复核'}},
  {id:'b',caseTitle:'右上腹痛',research:{mode:'research',studyId:'study-b',studyCode:'B',participantCode:'P02'},feedback:{}},
  {id:'c',caseTitle:'黄疸',research:{mode:'practice',phase:'training'}},
] as Session[];
test('research filters use frozen study UUID, not a renamed display code',()=>{
  const original=JSON.stringify(sessions);
  assert.deepEqual(filterSessions(sessions,{...EMPTY_SESSION_FILTERS,purpose:'research',studyId:'study-a'}).map(s=>s.id),['a']);
  assert.equal(JSON.stringify(sessions),original);
});
test('legacy records without research snapshot remain in practice, not research',()=>{
  assert.deepEqual(filterSessions(sessions,{...EMPTY_SESSION_FILTERS,purpose:'practice'}).map(s=>s.id),['old','c']);
});
test('pending review excludes unfinished or already reviewed records',()=>{
  assert.deepEqual(filterSessions(sessions,{...EMPTY_SESSION_FILTERS,review:'pending'}).map(s=>s.id),['b']);
  assert.deepEqual(filterSessions(sessions,{...EMPTY_SESSION_FILTERS,review:'reviewed'}).map(s=>s.id),['a']);
});
test('search matches frozen learner identifiers and combines with project scope',()=>{
  assert.deepEqual(filterSessions(sessions,{...EMPTY_SESSION_FILTERS,query:' p01 '}).map(s=>s.id),['a']);
  assert.deepEqual(filterSessions(sessions,{...EMPTY_SESSION_FILTERS,query:'p01',studyId:'study-b'}),[]);
});

const at='2026-10-23T06:00:00.000Z';
const independentSummary={history:'SIMULATED_ONLY：患者自述腹痛，仍需核实相关病史。',reasoning:'病因尚未明确。',plan:'继续核实病史。',uncertainty:'检查未知。'};
const feedback:NonNullable<Session['feedback']>={overview:'SIMULATED_ONLY',items:[],nextPractice:[],model:'stub-only',createdAt:at,reviewStatus:'pending'};
function record(id:string,extra:Partial<Session>={}):Session{return {id,caseId:'ruq-01',caseVersion:'0.1',caseTitle:'SIMULATED_ONLY：右上腹痛',createdAt:at,status:'interview',turns:[],...extra};}
const workRecords:Session[]=[
  record('interview'),
  record('summary',{status:'summary'}),
  record('manual',{status:'summary',summary:independentSummary}),
  record('failed',{status:'summary',summary:independentSummary,feedbackError:'SIMULATED_ONLY：请求未完成'}),
  record('generating',{status:'feedback_pending',summary:independentSummary}),
  record('review',{status:'feedback_ready',summary:independentSummary,feedback}),
  record('reviewed',{status:'reviewed',summary:independentSummary,feedback,review:{reviewer:'SIMULATED_ONLY',notes:'软件测试复核',at}}),
];
test('workflows distinguish editing, submitted manual summaries, failed feedback, active generation and teacher review',()=>{
  assert.deepEqual(workRecords.map(getSessionWorkflow),['interview','summary','feedback','feedback','generating','review','reviewed']);
  assert.equal(sessionWorkflowLabel(workRecords[2]),'待生成AI反馈');
  assert.equal(sessionWorkflowLabel(workRecords[4]),'AI反馈生成中');
  assert.doesNotMatch(sessionWorkflowLabel(workRecords[2]),/待写总结/);
});
test('each work-queue record has exactly one step and counting never mutates or reorders records',()=>{
  const before=JSON.stringify(workRecords);
  const counts=summarizeWorkQueue(workRecords);
  assert.deepEqual(counts,{interview:1,summary:1,feedback:2,generating:1,review:1,reviewed:1});
  assert.equal(Object.values(counts).reduce((sum,value)=>sum+value,0),workRecords.length);
  assert.equal(JSON.stringify(workRecords),before);
  assert.deepEqual(summarizeWorkQueue([]),{interview:0,summary:0,feedback:0,generating:0,review:0,reviewed:0});
});
test('work-queue filters return the corresponding records rather than inferring completion from counts',()=>{
  assert.deepEqual(filterSessions(workRecords,{...EMPTY_SESSION_FILTERS,workflow:'feedback'}).map(value=>value.id),['manual','failed']);
  assert.deepEqual(filterSessions(workRecords,{...EMPTY_SESSION_FILTERS,workflow:'summary'}).map(value=>value.id),['summary']);
  assert.deepEqual(filterSessions(workRecords,{...EMPTY_SESSION_FILTERS,workflow:'generating'}).map(value=>value.id),['generating']);
  assert.deepEqual(filterSessions(workRecords,{...EMPTY_SESSION_FILTERS,workflow:'reviewed',review:'pending'}),[]);
});
test('phase and case filters combine with frozen research identifiers while unknown legacy phases do not match',()=>{
  const values=[
    record('baseline',{research:{mode:'research',phase:'baseline',studyId:'fixed-project',participantId:'fixed-person',studyCode:'原项目',participantCode:'原学员',attemptIndex:1,capturedAt:at}}),
    record('post',{research:{mode:'research',phase:'post',studyId:'fixed-project',participantId:'fixed-person',studyCode:'原项目',participantCode:'原学员',attemptIndex:2,capturedAt:at}}),
    record('other-case',{caseId:'painless-jaundice-01',research:{mode:'research',phase:'baseline',studyId:'fixed-project',participantId:'fixed-person',attemptIndex:1,capturedAt:at}}),
    record('legacy'),
  ];
  const before=JSON.stringify(values);
  assert.deepEqual(filterSessions(values,{...EMPTY_SESSION_FILTERS,phase:'baseline',caseId:'ruq-01',studyId:'fixed-project',query:'fixed-person'}).map(value=>value.id),['baseline']);
  assert.equal(JSON.stringify(values),before);
  assert.deepEqual(filterSessions(values,{...EMPTY_SESSION_FILTERS,phase:'training'}),[]);
  assert.equal(filterSessions(values,{...EMPTY_SESSION_FILTERS}).length,4);
});
test('search includes case and frozen UUIDs without changing historical code matching',()=>{
  const value=record('session-UUID',{research:{mode:'research',phase:'training',studyId:'study-UUID',participantId:'person-UUID',studyCode:'LOCKED',participantCode:'P007',attemptIndex:1,capturedAt:at}});
  for(const query of ['ruq-01','session-uuid','study-uuid','person-uuid','locked','P007'])assert.deepEqual(filterSessions([value],{...EMPTY_SESSION_FILTERS,query}),[value],query);
});
test('dates match device-local days inclusively at both midnight boundaries',()=>{
  const previous=process.env.TZ;
  process.env.TZ='Asia/Shanghai';
  try{
    const values=[
      record('before',{createdAt:'2026-10-22T15:59:59.999Z'}),
      record('start',{createdAt:'2026-10-22T16:00:00.000Z'}),
      record('end',{createdAt:'2026-10-23T15:59:59.999Z'}),
      record('after',{createdAt:'2026-10-23T16:00:00.000Z'}),
    ];
    assert.deepEqual(filterSessions(values,{...EMPTY_SESSION_FILTERS,dateFrom:'2026-10-23',dateTo:'2026-10-23'}).map(value=>value.id),['start','end']);
    assert.deepEqual(filterSessions(values,{...EMPTY_SESSION_FILTERS,dateFrom:'2026-10-24'}).map(value=>value.id),['after']);
    assert.deepEqual(filterSessions(values,{...EMPTY_SESSION_FILTERS,dateTo:'2026-10-22'}).map(value=>value.id),['before']);
  }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
test('the same timestamp is assigned to the device local date rather than the UTC date or a fixed China timezone',()=>{
  const previous=process.env.TZ,value=record('time-zone-check',{createdAt:'2026-10-23T02:00:00.000Z'});
  try{
    process.env.TZ='America/New_York';
    assert.deepEqual(filterSessions([value],{...EMPTY_SESSION_FILTERS,dateFrom:'2026-10-22',dateTo:'2026-10-22'}),[value]);
    assert.deepEqual(filterSessions([value],{...EMPTY_SESSION_FILTERS,dateFrom:'2026-10-23',dateTo:'2026-10-23'}),[]);
    process.env.TZ='Asia/Shanghai';
    assert.deepEqual(filterSessions([value],{...EMPTY_SESSION_FILTERS,dateFrom:'2026-10-23',dateTo:'2026-10-23'}),[value]);
  }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
test('invalid calendar dates and inverted ranges fail closed with a visible explanation',()=>{
  for(const invalid of ['2026-02-29','2026-02-30','2026-13-01','2026-00-01','0000-01-01','2026-1-01','not-a-date']){
    assert.ok(sessionDateFilterError({...EMPTY_SESSION_FILTERS,dateFrom:invalid}),invalid);
    assert.deepEqual(filterSessions(workRecords,{...EMPTY_SESSION_FILTERS,dateFrom:invalid}),[],invalid);
    assert.ok(sessionDateFilterError({...EMPTY_SESSION_FILTERS,dateTo:invalid}),invalid);
  }
  const reversed={...EMPTY_SESSION_FILTERS,dateFrom:'2026-10-24',dateTo:'2026-10-23'};
  assert.match(sessionDateFilterError(reversed),/不能早于/);
  assert.deepEqual(filterSessions(workRecords,reversed),[]);
  assert.equal(sessionDateFilterError({...EMPTY_SESSION_FILTERS,dateFrom:'2024-02-29',dateTo:'2024-02-29'}),'');
  assert.equal(sessionDateFilterError({...EMPTY_SESSION_FILTERS,dateFrom:'2000-02-29'}),'');
  assert.ok(sessionDateFilterError({...EMPTY_SESSION_FILTERS,dateFrom:'1900-02-29'}));
});
test('malformed session timestamps remain available without a date filter and never match a date range',()=>{
  const malformed=record('invalid-time',{createdAt:'SIMULATED_ONLY-invalid-time'});
  assert.deepEqual(filterSessions([malformed],{...EMPTY_SESSION_FILTERS}),[malformed]);
  assert.deepEqual(filterSessions([malformed],{...EMPTY_SESSION_FILTERS,dateFrom:'2026-01-01'}),[]);
});
test('new optional filters keep older caller objects compatible and clearing restores every default',()=>{
  assert.deepEqual(filterSessions(workRecords,{purpose:'all',studyId:'',query:'',review:'all'}),workRecords);
  assert.deepEqual(EMPTY_SESSION_FILTERS,{purpose:'all',studyId:'',query:'',review:'all',workflow:'all',phase:'',caseId:'',dateFrom:'',dateTo:''});
});
