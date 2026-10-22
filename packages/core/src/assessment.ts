import type {
  AssessmentGroup, AssessmentMetadata, AssessmentScore, AssessmentScoreSummary, CaseDefinition,
} from './types.ts';

export interface AssessmentCriterion {
  id: string; label: string; expectation: string; group: AssessmentGroup;
  maxScore: 2; sourceIds: string[];
  anchors: { '0': string; '1': string; '2': string; 'null': string };
}

const metadata: AssessmentMetadata = {
  id: 'hpb-voice-formative-assessment', version: '0.1',
  name: '本课题改编的语音问诊形成性量规v0.1', adapted: true,
  sources: [
    {
      id: 'ccg-dalhousie', title: 'Dalhousie：Medical Interview Calgary–Cambridge Guide', kind: 'guidance',
      url: 'https://cdn.dal.ca/content/dam/dalhousie/pdf/faculty/medicine/departments/core-units/postgrad/Medical-Interview-CCG.pdf',
      note: '借鉴启动、信息采集、结构、患者观点、关系与结束等可观察过程领域；原指南未规定本量规分值。',
    },
    {
      id: 'gcrs-2014', title: 'Burt等：Global Consultation Rating Scale 原始研究，BMJ Open 2014', kind: 'primary_research',
      url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3948635/',
      note: '借鉴简洁行为分档与不适用处理思路；未复刻原版12域或24分，也未移植原研究信度。',
    },
    {
      id: 'team-case-checklist-v0.1', title: '本团队自编病例信息清单v0.1（待专家校订）', kind: 'local_adaptation', url: null,
      note: '病例信息点属于本课题自编OSCE教学内容，尚待专家校订；不是现成量表或外部标准。',
    },
  ],
  limitations: [
    '这是本课题的形成性改编量规，不是全国统一住培标准、原版GCRS24分或完整Mini-CEX；不设置合格线。',
    '病例清单、2/1/0/null锚点及保守证据规则需经教学专家校订和评分者校准；尚未验证中文语音AI评分效度。',
    '仅评价可靠转录可支持的语言行为与病例信息；眼神、肢体、查体、语调及真实临床胜任力不由文本代评。',
    '未记录、未确认、不能观察或不适用的项目记null；明确不当做法须有直接原文才可预记0分。',
    '两组只累计已评部分并报告覆盖率，不合并百分制；全部null时为未能评分，不能展示为0分表现。',
    '自动反馈待教师复核；有效原文引用只证明出处，不能自动证明临床理解、评分判断或教学效果正确。',
  ],
};

/** Safe for a public endpoint: no case IDs, hidden answers, or case rubric items. */
export function getAssessmentMetadata(): AssessmentMetadata { return JSON.parse(JSON.stringify(metadata)) as AssessmentMetadata; }

const process = [
  { id: 'identity', label: '自我介绍与身份核对',
    expectation: '用口头语言介绍自己及角色，核对患者称呼或身份，并确认可以开始问诊。',
    full: '学员原文同时支持自我/角色介绍和患者身份核对，表达尊重并确认问诊开始。',
    partial: '有介绍或身份核对的直接学员原文，但只完成其中一部分；不能仅凭未提及推定0分。',
    problem: '直接原文显示明确拒绝核对身份、冒用身份或以不当方式要求患者接受问诊。' },
  { id: 'opening', label: '开放起始与就诊议题',
    expectation: '用开放问题邀请患者叙述就诊原因，并核对本次希望讨论的问题。',
    full: '原文显示开放邀请患者讲述，并确认就诊议题或还有其他需要讨论的问题。',
    partial: '有开放邀请或议题核对的直接证据，但只覆盖一部分。',
    problem: '直接原文显示明确否定患者表达就诊议题的机会，或用强迫诱导语替患者决定其问题。' },
  { id: 'focused_followup', label: '从开放到针对性追问',
    expectation: '根据患者已回答的信息，从开放叙述逐步转向相关的针对性追问，不机械重复已明确的信息。',
    full: '相互关联的学员和患者原文显示开放叙述后，学员沿已有线索作相关追问。',
    partial: '存在相关追问的学员原文，但完整的开放到聚焦过程只能部分确认。',
    problem: '直接原文显示强迫患者接受预设答案、歪曲已给出的信息，或明确拒绝澄清相关线索。' },
  { id: 'clarification_summary', label: '澄清时间线与阶段总结',
    expectation: '对含糊的时间或叙述作澄清，并以阶段小结或过渡核对理解；评价过程而非重复计算已取得的病例时间信息。',
    full: '原文同时显示对时间/含糊叙述的澄清，以及带核对或过渡的阶段总结。',
    partial: '有澄清或阶段总结的直接证据，但尚不能支持两者充分完成。',
    problem: '直接原文显示将患者明确的先后关系说反且坚持错误，或拒绝患者纠正错误总结。' },
  { id: 'patient_perspective', label: '患者想法、担忧与期待',
    expectation: '主动了解患者对问题的想法、担忧与就诊期待，并核对或承接其表达。',
    full: '原文支持对患者想法、担忧与期待的了解，并有学员核对或承接；不要求照念固定词。',
    partial: '直接学员原文涉及其中一个或两个方面，或仅部分承接患者表达。',
    problem: '直接原文显示贬低、否认或强迫压制患者已经表达的想法、担忧或合理期待。' },
  { id: 'empathy_plain_language', label: '通俗回应与共情',
    expectation: '用通俗语言回应患者，并以口头承接或支持表达对其感受的理解；不凭转录评价语调、眼神或表情。',
    full: '学员原文可见通俗解释/回应及对患者感受的口头承接或支持。',
    partial: '有通俗回应或口头共情的直接证据，但只能确认部分实现。',
    problem: '直接原文显示侮辱、嘲讽、责备患者，或明确拒绝解释患者表示不理解的术语。' },
  { id: 'closure', label: '结束小结、核对与说明待查',
    expectation: '结束前概括已获得的信息，邀请纠正或补充，并说明尚待核实的信息和下一步沟通安排。',
    full: '原文同时支持结束小结、邀请核对/补充及说明待查或后续核实安排。',
    partial: '有结束小结、核对或待查说明的直接原文，但仅部分完成。',
    problem: '直接原文显示在资料不足时坚持宣布确定诊断/分级，或明确拒绝患者纠正和必要核实。' },
];

/** Internal only: this includes case-specific assessment targets. */
export function getAssessmentCriteria(definition: CaseDefinition): AssessmentCriterion[] {
  const result: AssessmentCriterion[] = definition.rubric.map(item => ({
    id: `case.${definition.id}.${item.id}`, label: item.label, expectation: item.expectation,
    group: 'case_history', maxScore: 2, sourceIds: ['team-case-checklist-v0.1'],
    anchors: {
      '2': `学员采集或核对的可靠原文足以支持本项关键内容：${item.expectation}。不要求机械重复患者已明确提供且学员已核对的信息。`,
      '1': '有学员采集或核对该信息的直接原文，能够确认部分实现；不足以支持本项全部预定关键内容。',
      '0': '直接学员原文显示明确不当采集、强迫诱导或歪曲信息等行为；单纯未提及、缺少记录或患者不知道不能记0。',
      'null': '缺乏可靠的学员行为原文、记录不完整、该项不适用或不能观察；不计分，不计入已评分母。',
    },
  }));
  result.push(...process.map(item => ({
    id: `process.${item.id}`, label: item.label, expectation: item.expectation,
    group: 'communication_process' as const, maxScore: 2 as const, sourceIds: ['ccg-dalhousie', 'gcrs-2014'],
    anchors: { '2': item.full, '1': item.partial, '0': item.problem,
      'null': '没有可靠原文可判断、本次不适用或只能依赖音调/非语言信息；记null，不由未提到推定0。' },
  })));
  if (new Set(result.map(item => item.id)).size !== result.length) throw new Error('量规项目ID重复，请先修复病例量规。');
  return result;
}

export function summarizeAssessmentScores(items: readonly { group: AssessmentGroup; score: AssessmentScore; maxScore: 2 }[]): AssessmentScoreSummary {
  const groups: AssessmentGroup[] = ['case_history', 'communication_process'];
  for (const item of items) if (!groups.includes(item.group) || item.maxScore !== 2 || ![0, 1, 2, null].includes(item.score))
    throw new Error('评分数据超出锁定的组别或分值范围。');
  return Object.fromEntries(groups.map(group => {
    const selected = items.filter(item => item.group === group);
    const scored = selected.filter(item => item.score !== null);
    return [group, {
      group, label: group === 'case_history' ? '病例信息采集' : '可观察的语言沟通过程',
      score: scored.reduce((sum, item) => sum + item.score!, 0),
      maxScore: scored.length * 2, scoredItems: scored.length, totalItems: selected.length,
      coverage: selected.length ? scored.length / selected.length : 0,
    }];
  })) as AssessmentScoreSummary;
}
