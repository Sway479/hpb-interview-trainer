import { IonIcon } from '@ionic/react';
import { chevronDownOutline, chevronForwardOutline, informationCircleOutline, playOutline } from 'ionicons/icons';
import type { AssessmentGroup, Feedback, FeedbackItem, Session } from '../../../packages/core/src/types';
import { createEvidenceResolver } from '../../../packages/core/src/evidence';
import { Badge, Notice, turnTime } from './components';

const groups: { id: AssessmentGroup; label: string; description: string }[] = [
  { id: 'case_history', label: '病例信息采集', description: '病例专属信息 · 本团队自编清单' },
  { id: 'communication_process', label: '可观察的语言沟通过程', description: '借鉴 Calgary–Cambridge 的语言过程领域' },
];
const notScored = { insufficient_evidence: '证据不足', not_applicable: '本次不适用', unobservable: '无法观察' };
export function FeedbackAssessment({ feedback, session, onEvidence }: { feedback: Feedback; session: Session; onEvidence: (id: string) => void }) {
  const resolver = createEvidenceResolver(session.turns);
  function itemCard(item: FeedbackItem) {
    const hasScore = typeof item.score === 'number';
    const correction = session.review?.corrections?.find(value => value.criterionId === item.criterionId);
    return <section className="assessment-item" key={item.criterionId}>
      <div className="feedback-item-heading"><h3>{item.label}</h3><Badge tone={!hasScore ? 'neutral' : item.score === 2 ? 'teal' : 'amber'}>{hasScore ? 'AI ' + item.score + ' / ' + (item.maxScore || 2) : 'AI未计分'}</Badge></div>
      {correction && <div className="teacher-correction-result"><Badge tone="teal">教师：{correction.score === null ? '未计分' : correction.score + ' / 2'}</Badge><p>{correction.reason}</p><small>教师修正单独保存，未覆盖AI原分。</small></div>}
      {!hasScore && <span className="not-scored-label">{item.notScoredReason ? notScored[item.notScoredReason] : '尚无可靠证据'}</span>}
      <p>{item.comment}</p>
      {item.score === 0 && item.zeroEvidence && <div className="zero-evidence"><strong>明确不当行为的原文依据</strong><p>{item.zeroEvidence.problem}</p></div>}
      {!!item.evidence.length ? <div className="evidence-list">{item.evidence.map((evidence, index) => {
        const resolved = resolver.resolve(evidence), source = resolved.turn;
        const issueLabel = resolved.issue === 'duplicate_turn_id' ? '来源ID重复，无法唯一定位'
          : resolved.issue === 'empty_quote' ? '原引用为空，不能作证据'
            : resolved.issue === 'quote_mismatch' ? '引文不匹配 · 查看原文' : '转录待核对 · 查看原文';
        return <button type="button" key={evidence.turnId + index} className="evidence-card" onClick={() => { if (resolved.canNavigate) onEvidence(evidence.turnId); }} disabled={!resolved.canNavigate}>
          <span><IonIcon icon={playOutline} />{source ? turnTime(source, session) : resolved.issue === 'duplicate_turn_id' ? '来源有歧义' : '来源未匹配'}<small>{source?.role === 'learner' ? '你的提问' : source ? '患者回应' : '证据不足'}</small></span>
          <q>{evidence.quote.trim() ? evidence.quote : '（空引用）'}</q><span className="evidence-link">{resolved.reliable ? '查看对应原文' : resolved.issue === 'missing_turn' ? '无法定位原文' : issueLabel}<IonIcon icon={chevronForwardOutline} /></span>
        </button>;
      })}</div> : <p className="insufficient-evidence"><IonIcon icon={informationCircleOutline} />没有可靠的引用原文；未观察项目不计为 0 分。</p>}
    </section>;
  }
  const grouped = feedback.items.some((item) => item.group);
  return <section className="assessment-section">
    {feedback.scoreSummary && <><div className="section-heading"><h2>AI原始分与覆盖</h2><Badge tone="amber">形成性草稿</Badge></div><div className="score-summary-grid">
      {groups.map(({ id, label }) => {
        const value = feedback.scoreSummary?.[id];
        if (!value) return null;
        const canScore = value.scoredItems > 0 && value.maxScore > 0;
        return <section className="score-summary-card" key={id}><h3>{label}</h3><span className="score-caption">{canScore ? '已评部分参考分' : '证据尚不足'}</span><strong className={canScore ? 'numeric-score' : 'unscored'}>{canScore ? <>{value.score}<small> / {value.maxScore}</small></> : '未能评分'}</strong><p>已评 {value.scoredItems} / 总 {value.totalItems} 项</p><p>覆盖率 {Math.round(Math.max(0, Math.min(1, value.coverage)) * 100)}%</p></section>;
      })}
    </div><p className="score-explanation">仅累计有可靠证据的已评项目，不合并百分制，不设合格线；未观察项目不按 0 分处理。</p></>}
    {grouped ? groups.map(({ id, label, description }) => <details className="assessment-group" key={id} open={id === 'case_history'}><summary><span><strong>{label}</strong><small>{description} · {feedback.items.filter((item) => item.group === id).length} 项</small></span><IonIcon icon={chevronDownOutline} /></summary><div className="assessment-group-body">{feedback.items.filter((item) => item.group === id).map(itemCard)}</div></details>) : <section className="panel"><h2>问诊观察</h2>{feedback.items.map(itemCard)}</section>}
    {feedback.assessment && <details className="assessment-source-panel"><summary><span><strong>查看评分依据</strong><small>{feedback.assessment.name}</small></span><IonIcon icon={chevronDownOutline} /></summary><div className="assessment-source-body">
      <Notice>课题改编量规 v{feedback.assessment.version}，用于形成性教学参考。自动评分需经教师复核。</Notice>
      <h3>分值如何理解</h3><dl className="score-legend"><div><dt>2</dt><dd>可靠原文足以支持充分实现。</dd></div><div><dt>1</dt><dd>可靠原文仅支持部分实现。</dd></div><div><dt>0</dt><dd>有直接原文支持的明确不当行为。</dd></div><div><dt>未计分</dt><dd>证据不足、不适用或无法观察，不计入已评分母。</dd></div></dl>
      <h3>原始来源与改编边界</h3><ol className="assessment-sources">{feedback.assessment.sources.map((source) => <li key={source.id}>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a> : <strong>{source.title}</strong>}<p>{source.note}</p></li>)}</ol>
      <h3>适用边界</h3><ul className="assessment-limitations">{feedback.assessment.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
    </div></details>}
  </section>;
}

