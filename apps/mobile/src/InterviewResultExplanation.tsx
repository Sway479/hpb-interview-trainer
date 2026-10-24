import { useEffect, useMemo, useState } from 'react';
import { IonIcon } from '@ionic/react';
import { chevronDownOutline, chevronForwardOutline, copyOutline } from 'ionicons/icons';
import { buildInterviewResultExplanation, formatInterviewResultExplanation } from '../../../packages/core/src/result-explanation';
import type { Session } from '../../../packages/core/src/types';
import { createEvidenceResolver } from '../../../packages/core/src/evidence';
import { Badge, formatTime, turnTime } from './components';
import './InterviewResultExplanation.css';

type ExplanationItem = ReturnType<typeof buildInterviewResultExplanation>['improvements'][number];

export function InterviewResultExplanation({ session, onEvidence }: { session: Session; onEvidence: (id: string) => void }) {
  const report = useMemo(() => buildInterviewResultExplanation(session), [session]);
  const resolver = useMemo(() => createEvidenceResolver(session.turns), [session.turns]);
  const copyText = useMemo(() => formatInterviewResultExplanation(report), [report]);
  const [copyMessage, setCopyMessage] = useState('');
  const [showCopyText, setShowCopyText] = useState(false);
  const [copying, setCopying] = useState(false);
  useEffect(() => { setCopyMessage(''); setShowCopyText(false); }, [copyText]);
  const otherImprovements = report.improvements.filter(item => !report.practicePlan.includes(item));

  async function copyResult() {
    if (copying) return;
    setCopying(true); setCopyMessage('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(copyText);
      setCopyMessage('结果说明已复制。');
    } catch {
      setShowCopyText(true);
      setCopyMessage('当前环境不能自动复制，请在下方文本框中全选复制。');
    } finally { setCopying(false); }
  }

  function evidenceList(item: ExplanationItem) {
    if (!item.evidence.length) return <p className="ire-no-evidence">暂无可引用的可靠问诊原文，请先核对完整记录。</p>;
    return <div className="ire-evidence-list">{item.evidence.map((evidence, index) => {
      const resolved = resolver.resolve(evidence), source = resolved.turn;
      return <button className="ire-evidence" type="button" key={evidence.turnId + '-' + index} disabled={!resolved.canNavigate} onClick={() => { if (resolved.canNavigate) onEvidence(evidence.turnId); }}>
        <span className="ire-evidence-heading"><span>{source?.role === 'learner' ? '学员原文' : source ? '患者原文' : '来源未匹配'}{source && <time dateTime={source.at}>{turnTime(source, session)}</time>}</span><span>{source ? '查看对应原文' : '无法定位'}<IonIcon icon={chevronForwardOutline} aria-hidden="true" /></span></span>
        <q>{evidence.quote}</q>
      </button>;
    })}</div>;
  }

  function itemCard(item: ExplanationItem, index: number, priority = false) {
    return <article className={'ire-item ire-item-' + item.disposition} key={item.criterionId + '-' + index}>
      <div className="ire-item-heading"><h4>{priority && <span className="ire-priority-number" aria-hidden="true">{index + 1}</span>}{item.label}</h4><Badge tone={item.origin === 'teacher' ? 'teal' : 'neutral'}>{item.origin === 'teacher' ? '本机教师复核' : '自动预评'}</Badge></div>
      <p className="ire-finding">{item.finding}</p>
      {item.teacherReason && <div className="ire-comment ire-teacher-comment"><strong>教师复核理由</strong><p>{item.teacherReason}</p></div>}
      {item.assessmentComment && <div className="ire-comment"><strong>AI原评意见{item.origin === 'teacher' ? '（保留原文）' : '（待核对）'}</strong><p>{item.assessmentComment}</p></div>}
      <div className="ire-evidence-section"><h5>可核对的原文依据</h5>{evidenceList(item)}</div>
      {item.disposition === 'improve' ? <dl className="ire-practice"><div><dt>改进目标</dt><dd>{item.practice.goal}</dd></div><div className="ire-question"><dt>练习问法 <span>教学示例，非本次原文</span></dt><dd>{item.practice.question}</dd></div><div><dt>完成标志</dt><dd>{item.practice.completion}</dd></div></dl> : item.disposition === 'strength' ? <div className="ire-retain-check"><strong>继续核对的完成标志</strong><p>{item.practice.completion}</p></div> : null}
      {!!item.warnings.length && <details className="ire-item-notes"><summary>本项核对提醒<span>{item.warnings.length} 条</span></summary><ul>{item.warnings.map((warning, warningIndex) => <li key={warningIndex}>{warning}</li>)}</ul></details>}
    </article>;
  }

  return <section className="panel interview-result-explanation" aria-labelledby="interview-result-explanation-title">
    <div className="ire-heading"><h2 id="interview-result-explanation-title">问诊考核结果说明</h2><Badge tone="amber">形成性</Badge></div>
    <p className="ire-context"><strong>{session.caseTitle}</strong><time dateTime={session.createdAt}>{formatTime(session.createdAt)}</time></p>
    <p className="ire-headline">{report.headline}</p>
    <p className="ire-scope">{report.scopeNote}</p>
    <div className="ire-basis"><span>可靠学员发言 <strong>{report.reliableLearnerTurns} / {report.totalLearnerTurns}</strong> 条</span>{report.teacherReview ? <span>本机复核：{report.teacherReview.reviewer} · {formatTime(report.teacherReview.at)}</span> : <span>本次尚无教师复核记录</span>}</div>

    {report.available && <>
      <div className="ire-section-heading"><h3>优先改进</h3><span>每次先练最多 3 项</span></div>
      {report.practicePlan.length ? <div className="ire-priority-list">{report.practicePlan.map((item, index) => itemCard(item, index, true))}</div> : <p className="ire-empty">当前没有可列入优先改进的条目。请继续核对下方保留做法与未能判断的项目，不能据此认定已全面掌握。</p>}
      {!!otherImprovements.length && <details className="ire-detail-group"><summary><span><strong>其他改进项目</strong><small>{otherImprovements.length} 项，可在后续练习中逐一处理</small></span><IonIcon icon={chevronDownOutline} aria-hidden="true" /></summary><div className="ire-detail-body">{otherImprovements.map((item, index) => itemCard(item, index))}</div></details>}
      <details className="ire-detail-group"><summary><span><strong>可保留的做法</strong><small>{report.strengths.length} 项，仍需对照完整完成标志核对</small></span><IonIcon icon={chevronDownOutline} aria-hidden="true" /></summary><div className="ire-detail-body">{report.strengths.length ? report.strengths.map((item, index) => itemCard(item, index)) : <p className="ire-empty">本次没有可归入此处的条目，不据此判断学员没有良好做法。</p>}</div></details>
      <details className="ire-detail-group"><summary><span><strong>待核对 / 未能判断</strong><small>{report.unresolved.length} 项，不列为已证实的学员不足</small></span><IonIcon icon={chevronDownOutline} aria-hidden="true" /></summary><div className="ire-detail-body"><p className="ire-group-intro">先核对转录、完整轮次和适用性。未记录、不适用或无法观察，不等于没有完成。</p>{report.unresolved.length ? report.unresolved.map((item, index) => itemCard(item, index)) : <p className="ire-empty">本次没有归入此处的条目。</p>}</div></details>
    </>}

    {report.reviewNote && <section className="ire-review-note"><h3>教师整体意见</h3><p>{report.reviewNote}</p></section>}
    <details className="ire-detail-group ire-limitations"><summary><span><strong>说明依据与适用边界</strong><small>原评分保留，结果说明不产生新的分数</small></span><IonIcon icon={chevronDownOutline} aria-hidden="true" /></summary><div className="ire-detail-body"><ul>{report.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul><p className="ire-version">整理规则 v{report.version} · 原量规 {report.assessmentVersion || '旧版未记录'}<br />量规ID：{report.assessmentId || '旧版未记录'}<br />原反馈生成时间：{report.feedbackCreatedAt || (report.available ? '旧版未记录' : '尚未生成')}<br />原反馈模型：{report.feedbackModel || (report.available ? '旧版未记录' : '尚未生成')}<br />训练时固定版本：App {report.runtimeVersions?.appVersion || '旧版未记录'} · 引擎 {report.runtimeVersions?.engineVersion || '旧版未记录'}<br />病例提示词 {report.runtimeVersions?.patientPromptVersion || '旧版未记录'} · 反馈提示词 {report.runtimeVersions?.feedbackPromptVersion || '旧版未记录'}{report.teacherReview && <><br />当前教师复核：{report.reviewRevision ? `第${report.reviewRevision}版` : '修订号旧版未记录'}</>}<br />时间来自设备时钟；不是当前查看时间，也未经外部授时认证。</p></div></details>
    <div className="ire-copy-actions"><button type="button" className="secondary-button" onClick={() => void copyResult()} disabled={copying}><IonIcon icon={copyOutline} aria-hidden="true" />{copying ? '正在复制…' : '复制结果说明'}</button><button type="button" className="ire-text-toggle" aria-expanded={showCopyText} aria-controls="interview-result-copy-text" onClick={() => setShowCopyText(value => !value)}>{showCopyText ? '收起文本' : '查看可复制文本'}</button></div>
    {copyMessage && <p className="ire-copy-message" role="status">{copyMessage}</p>}
    {showCopyText && <div className="ire-copy-text" id="interview-result-copy-text"><label htmlFor="interview-result-explanation-text">结果说明文本</label><p>包含本次引用原文及教师复核记录，可在下框中全选复制。</p><textarea id="interview-result-explanation-text" readOnly value={copyText} rows={12} onFocus={event => event.target.select()} /></div>}
  </section>;
}
