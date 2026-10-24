import { getAssessmentCriteria, getAssessmentMetadata } from './assessment.ts';
import { getCase } from './cases.ts';
import { createEvidenceResolver, isReliableTurn } from './evidence.ts';
import type { AssessmentScore, FeedbackItem, Session } from './types.ts';

export interface ExplanationPractice { goal: string; question: string; completion: string }
export interface ExplanationItem {
  criterionId: string; label: string; origin: 'automatic' | 'teacher';
  disposition: 'strength' | 'improve' | 'unresolved'; originalScore?: AssessmentScore; score: AssessmentScore;
  finding: string; assessmentComment?: string; teacherReason?: string;
  evidence: { turnId: string; quote: string }[]; practice: ExplanationPractice; warnings: string[];
}
export interface InterviewResultExplanation {
  version: string; sessionId: string; caseTitle: string; caseVersion: string; sessionCreatedAt: string;
  feedbackModel?: string; feedbackCreatedAt?: string; assessmentId?: string; assessmentVersion?: string;
  runtimeVersions?: { appVersion: string; engineVersion: string; patientPromptVersion: string; feedbackPromptVersion: string };
  reviewRevision?: number; teacherReview?: { reviewer: string; at: string };
  available: boolean; headline: string; scopeNote: string;
  reliableLearnerTurns: number; totalLearnerTurns: number;
  strengths: ExplanationItem[]; improvements: ExplanationItem[]; unresolved: ExplanationItem[];
  practicePlan: ExplanationItem[]; reviewNote?: string; limitations: string[];
}

const processPractice: Record<string, ExplanationPractice> = {
  identity: { goal: '把角色介绍、患者称呼核对和开始问诊的确认连在一起。', question: '您好，我是本次接诊的住院医师。请问怎么称呼您？现在方便聊一下您的情况吗？', completion: '原文同时出现自我/角色介绍、患者称呼或身份核对，以及开始问诊的确认。' },
  opening: { goal: '先让患者自由叙述，再核对本次希望解决的议题。', question: '这次主要是什么不舒服让您来就诊？除了这个，还有哪些问题希望一起讨论？', completion: '既有开放邀请，也有对就诊议题或其他问题的明确核对；不能仅以“隐含关注”替代。' },
  focused_followup: { goal: '沿患者刚提供的线索继续追问，避免机械重复。', question: '您刚才提到这次和以前不一样，能具体说说哪里不同吗？', completion: '跨轮原文能连起开放叙述、患者提供的线索和随后相关追问；需一起检查多轮记录。' },
  clarification_summary: { goal: '澄清含糊处后，用一句阶段小结核对理解。', question: '我确认一下：先出现的是……，之后才……，我理解得对吗？', completion: '既有澄清，也有基于已获信息的小结或过渡核对；取得时间资料本身不等于阶段总结。' },
  patient_perspective: { goal: '了解患者的想法、担忧和期待，并在其回答后作出承接。', question: '您觉得可能是什么原因？最担心什么？这次希望得到怎样的帮助？（听完后）我听到您主要担心的是……，对吗？', completion: '患者表达之后有学员核对或回应的原文；只问“担心什么”不能当作已经承接。' },
  empathy_plain_language: { goal: '先回应患者感受，再用通俗语言说明当前理解。', question: '听起来这让您很担心。我先确认您的顾虑，再用容易理解的方式说明目前知道和还不知道的情况。', completion: '有口头支持/承接及通俗回应的实际原文；文本不代评语调、眼神或表情。' },
  closure: { goal: '结束前概括已经获得的病史，邀请纠正，并说明待核实事项。', question: '我小结一下刚才了解到的情况：……。有没有理解错或需要补充的？还有……需要进一步核实。', completion: '已获病史小结、邀请核对/补充、待查说明三部分均可定位；未来计划不能代替已做的小结。' },
};

function practiceFor(id: string, label: string, expectation?: string): ExplanationPractice {
  if (expectation && id.startsWith('process.') && processPractice[id.slice(8)]) return { ...processPractice[id.slice(8)] };
  const topic = expectation ? id.split('.').at(-1) : undefined;
  const examples: Record<string, string> = {
    timeline: '最早什么时候开始？之后症状怎样变化？和以前类似情况有什么不同？',
    pain: '请指一下最不舒服的位置，是什么感觉、有多重，会向其他地方延伸吗？',
    associated: '除了刚才说的症状，还有哪些同时出现的不舒服？各自是什么时候开始的？',
    biliary_history: '以前有过类似发作吗？当时做过什么检查或处理，后来怎样了？',
    background: '以前有哪些疾病或相关处理经历？目前在用哪些药？不清楚的名称我们先记为待核实。',
    pain_fever: '腹痛和发热分别什么时候出现？是否量过体温？症状发生了哪些变化？',
    jaundice: '您什么时候注意到眼睛或皮肤颜色变化？尿色、粪便颜色有没有观察到变化？没观察过可以直接说明。',
    severity: '这段时间精神状态、饮水、尿量和整体感觉有没有变化？请描述您实际注意到的情况。',
    surgery_allergy: '以前做过腹部手术吗？有哪些已知药物过敏或用药后不舒服的经历？',
    systemic: '最近食欲或体重怎样变化？大约多长时间、变化多少？是否有主动减重？',
    other_history: '以前做过哪些手术？有已知药物过敏或相关家族病史吗？',
  };
  return {
    goal: expectation ? `对照本例要求练习：${expectation}。` : `围绕“${label}”与教师确认需要观察的行为，再作针对性练习。`,
    question: examples[topic || ''] || '请再具体说说刚才的情况；我确认一下哪些已经知道、哪些还需要核实。',
    completion: expectation ? `可靠问诊原文能逐一支持“${expectation}”；未知信息如实标记，不诱导或补造。` : '由教师结合该记录对应版本的量规核对；没有版本依据时不套用新版锚点。',
  };
}

const scoreValue = (value: unknown): value is AssessmentScore => value === null || value === 0 || value === 1 || value === 2;
const omission = /(?:未(?:曾)?(?:询问|问及|问到|问清|提及|采集|收集|记录|体现|完成)|没有(?:询问|问及|问到|提及|采集|收集|记录|体现)|没(?:有)?问|遗漏|缺少(?:询问|问诊|采集|记录|证据)|未见(?:.*?)(?:记录|询问|采集))/;

/** Read-only, deterministic interpretation of existing records; never calls a model or changes a score. */
export function buildInterviewResultExplanation(session: Session): InterviewResultExplanation {
  const learnerTurns = session.turns.filter(t => t.role === 'learner' && t.text.trim());
  const resolver = createEvidenceResolver(session.turns);
  const matchedEvidence = (item: FeedbackItem) => item.evidence.filter(e => resolver.resolve(e).reliable);
  let criteria: ReturnType<typeof getAssessmentCriteria> = [];
  try {
    const definition = getCase(session.caseId), metadata = getAssessmentMetadata();
    if (definition.version === session.caseVersion && session.feedback?.assessment?.id === metadata.id && session.feedback.assessment.version === metadata.version)
      criteria = getAssessmentCriteria(definition);
  } catch { /* Historical unknown cases remain readable without applying current anchors. */ }
  const report: InterviewResultExplanation = {
    version: '1.0', sessionId: session.id, caseTitle: session.caseTitle, caseVersion: session.caseVersion, sessionCreatedAt: session.createdAt,
    ...(session.feedback ? { feedbackModel: session.feedback.model, feedbackCreatedAt: session.feedback.createdAt,
      assessmentId: session.feedback.assessment?.id, assessmentVersion: session.feedback.assessment?.version } : {}),
    ...(session.runtime ? { runtimeVersions: { appVersion: session.runtime.appVersion, engineVersion: session.runtime.engineVersion,
      patientPromptVersion: session.runtime.patientPromptVersion, feedbackPromptVersion: session.runtime.feedbackPromptVersion } } : {}),
    ...(session.review ? { teacherReview: { reviewer: session.review.reviewer, at: session.review.at }, reviewRevision: (session.reviewHistory?.length ?? 0) + 1 } : {}), available: !!session.feedback,
    headline: session.feedback ? '逐项结合原文复盘，不作合格或能力等级判定。' : '反馈尚未生成，暂不评价学员表现。',
    scopeNote: '依据本次已有反馈、可靠问诊原文和本机教师复核整理；不额外调用模型，不重新评分。',
    reliableLearnerTurns: learnerTurns.filter(t => isReliableTurn(t) && !resolver.isDuplicate(t.id)).length,
    totalLearnerTurns: learnerTurns.length, strengths: [], improvements: [], unresolved: [], practicePlan: [],
    ...(session.review ? { reviewNote: session.review.notes } : {}),
    limitations: ['这是形成性结果说明，自动预评仍可能偏高或漏用跨轮证据，不能直接作为正式研究考核成绩。',
      '练习问法仅为教学示例，不是本次已经发生的对话；未记录、不适用或无法观察不等于能力不足。',
      '本机教师姓名/编号是人工填写的复核记录，不代表身份认证或独立盲评。'],
  };
  if (!session.feedback) return report;
  const seen = new Set<string>(), duplicateCriteria = new Set<string>();
  session.feedback.items.forEach(item => { if (seen.has(item.criterionId)) duplicateCriteria.add(item.criterionId); seen.add(item.criterionId); });
  for (const item of session.feedback.items) {
    const criterion = criteria.find(c => c.id === item.criterionId);
    const correction = session.review?.corrections?.find(c => c.criterionId === item.criterionId && scoreValue(c.score) && c.reason.trim());
    const originalScore = scoreValue(item.score) ? item.score : undefined;
    const origin = correction ? 'teacher' as const : 'automatic' as const;
    const score = correction?.score ?? (correction ? null : originalScore ?? null);
    const evidence = matchedEvidence(item);
    const learnerEvidence = evidence.some(e => resolver.uniqueTurn(e.turnId)?.role === 'learner');
    const warnings: string[] = [];
    let disposition: ExplanationItem['disposition'] = 'unresolved', finding: string;
    const duplicate = duplicateCriteria.has(item.criterionId);
    const zero = item.zeroEvidence;
    const explicitZero = !!zero && !omission.test(zero.problem + ' ' + item.comment) && !!zero.problem.trim() && evidence.some(e => e.turnId === zero.turnId && e.quote === zero.quote && resolver.uniqueTurn(e.turnId)?.role === 'learner');
    if (duplicate) {
      finding = '同一条目在反馈中重复，先核对源记录，暂不据此归纳表现。';
    } else if (!criterion) {
      finding = '本条记录缺少可匹配的量规/病例版本依据，保留原评，需教师按对应版本解释。';
    } else if (score === null) {
      finding = correction ? '本机教师将此项记为未计分；不能把它解释为0分或已证实的学员问题。'
        : item.notScoredReason === 'not_applicable' ? '当前原评标为本次不适用；不列为学员不足，适用性由教师核对。'
          : item.notScoredReason === 'unobservable' ? '本次材料无法观察所需行为，不列为学员不足。'
            : '本次记录尚不能判断；可能涉及转录缺失或跨轮漏评，需先核对原文和录音。';
    } else if (!learnerEvidence) {
      finding = '缺少可定位的可靠学员原文，暂不能把该分档写成学员表现结论。';
    } else if (evidence.length !== item.evidence.length) {
      finding = '原评依赖的部分引用无法可靠核对，暂不沿用该分档归纳表现；请教师重新核对完整证据。';
    } else if (score === 0 && !correction && !explicitZero) {
      finding = '原评为0分，但缺少可核对的直接不当行为依据，暂不据此认定学员存在该问题。';
    } else {
      disposition = score === 2 ? 'strength' : 'improve';
      finding = correction ? `本机教师复核记录为${score === 2 ? '充分实现，可保留并继续练习' : score === 1 ? '部分实现，建议继续完善' : '需改进'}；具体判断以复核理由为准。`
        : score === 2 ? 'AI原评标为充分实现，可作为保留做法的候选；仍需对照全部完成标志核对。'
          : score === 1 ? 'AI原评标为部分实现：有相关行为证据，建议对照完成标志核对并补强尚未落实的环节。'
            : 'AI原评标记了明确不当行为，建议优先与教师复盘；有出处不等于该语义判断已被证实。';
    }
    if (evidence.length !== item.evidence.length) warnings.push('部分原引用无法匹配、未确认、被打断或待核对，未用作本说明的行为依据。');
    if (correction) warnings.push('教师意见独立保留；原始AI分数和汇总未被覆盖。');
    if (origin === 'automatic' && ['process.patient_perspective','process.opening','process.closure','process.focused_followup'].includes(item.criterionId))
      warnings.push('该类条目有历史偏高或跨轮漏评记录，请核对整个对话序列，不能只看单句引文。');
    const entry: ExplanationItem = { criterionId: item.criterionId, label: item.label, origin, disposition, originalScore, score, finding,
      assessmentComment: item.comment, ...(correction ? { teacherReason: correction.reason } : {}), evidence,
      practice: practiceFor(item.criterionId, item.label, criterion?.expectation), warnings };
    (disposition === 'strength' ? report.strengths : disposition === 'improve' ? report.improvements : report.unresolved).push(entry);
  }
  // Prioritize explicit low/partial ratings; unresolved records never become asserted learner deficiencies.
  const ordered = [...report.improvements].sort((a,b) => Number(b.origin === 'teacher') - Number(a.origin === 'teacher') || (a.score ?? 2) - (b.score ?? 2));
  report.practicePlan = ordered.slice(0,3);
  report.headline = report.improvements.length
    ? `本次有${report.improvements.length}项被原评或复核标记为需改进，建议先练以下${report.practicePlan.length}项；另有${report.unresolved.length}项需核对或本次未计分。`
    : report.unresolved.length ? `当前没有可直接列入优先改进的条目；${report.unresolved.length}项需核对或本次未计分，不能据此判断已全面掌握。`
      : '当前原评/复核未标记需改进项；仍应核对全部行为锚点，不据此判定已合格或全面掌握。';
  return report;
}

export function formatInterviewResultExplanation(report: InterviewResultExplanation): string {
  const lines = ['问诊考核结果说明（形成性）', `病例：${report.caseTitle}；病例版本：${report.caseVersion}`, `训练开始时间：${report.sessionCreatedAt}`,
    `整理规则版本：${report.version}；会话ID：${report.sessionId}`,
    `原反馈生成时间：${report.feedbackCreatedAt || (report.available ? '旧版未记录' : '尚未生成')}`,
    `原反馈模型：${report.feedbackModel || (report.available ? '旧版未记录' : '尚未生成')}；原量规ID：${report.assessmentId || '旧版未记录'}；原量规版本：${report.assessmentVersion || '旧版未记录'}`,
    `训练时固定版本：App ${report.runtimeVersions?.appVersion || '旧版未记录'}；引擎 ${report.runtimeVersions?.engineVersion || '旧版未记录'}；病例提示词 ${report.runtimeVersions?.patientPromptVersion || '旧版未记录'}；反馈提示词 ${report.runtimeVersions?.feedbackPromptVersion || '旧版未记录'}`,
    ...(report.teacherReview ? [`本机教师复核：${report.reviewRevision ? `第${report.reviewRevision}版` : '修订号旧版未记录'}；${report.teacherReview.reviewer}；时间：${report.teacherReview.at}`] : []),
    '上述训练、反馈和复核时间来自设备时钟；不是当前查看时间，也未经外部授时认证。', report.scopeNote,
    `可靠学员发言：${report.reliableLearnerTurns}/${report.totalLearnerTurns}条`, report.headline];
  const append = (heading: string, items: ExplanationItem[]) => {
    lines.push('', heading);
    if (!items.length) { lines.push('本次没有可列出的条目。'); return; }
    items.forEach((item,index) => {
      lines.push(`${index+1}. ${item.label}（${item.origin === 'teacher' ? '本机教师复核' : 'AI原评，待核对'}）`, item.finding);
      if (item.teacherReason) lines.push(`教师理由：${item.teacherReason}`);
      item.evidence.forEach(e => lines.push(`原文[${e.turnId}]：“${e.quote}”`));
      if (!item.evidence.length) lines.push('暂无可引用的可靠问诊原文。');
      if (item.disposition === 'improve') lines.push(`改进目标：${item.practice.goal}`, `练习问法（非本次原文）：${item.practice.question}`, `完成标志：${item.practice.completion}`);
      if (item.disposition === 'strength') lines.push(`仍需核对的完成标志：${item.practice.completion}`);
      item.warnings.forEach(w => lines.push(`核对提醒：${w}`));
    });
  };
  append('建议优先改进（最多3项）', report.practicePlan);
  const priorityIds = new Set(report.practicePlan.map(i => i.criterionId));
  append('其他需改进项目', report.improvements.filter(i => !priorityIds.has(i.criterionId)));
  append('可保留的做法（需核对）', report.strengths); append('待核对 / 本次未计分', report.unresolved);
  if (report.reviewNote) lines.push('', `教师整体意见：${report.reviewNote}`);
  lines.push('', ...report.limitations);
  return lines.join('\n');
}
