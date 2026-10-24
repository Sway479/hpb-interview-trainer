import { IonSpinner } from '@ionic/react';
import type { LearnerSummary, Session } from '../../../packages/core/src/types';
import { hasReliableLearnerTranscript, SUMMARY_RULES, summaryValidation } from '../../../packages/core/src/summary-rules';
import { Notice, summaryFields } from './components';
import './SummaryEditor.css';

interface Props {
  session: Session; value: LearnerSummary; ready: boolean; saved: boolean; error: string; loadFailed: boolean;
  busy: string; onChange: (key: keyof LearnerSummary, value: string) => void;
  onSubmit: (saveOnly?: boolean) => void; onSaveDraft: () => void; onRetryLoad: () => void; onViewRecord: () => void;
}
export function SummaryEditor({ session, value, ready, saved, error, loadFailed, busy, onChange, onSubmit, onSaveDraft, onRetryLoad, onViewRecord }: Props) {
  const issues = summaryValidation(value), reliable = hasReliableLearnerTranscript(session.turns);
  const manual = session.runtime?.feedbackGeneration !== 'automatic' || !reliable;
  const valid = !Object.keys(issues).length, disabled = !!busy || !ready;
  return <main className="page-pad summary-page">
    <div className="eyebrow">问诊后</div><h1 className="page-title">独立总结</h1><p className="page-subtitle">先完成自己的判断，再查看反馈。</p>
    <Notice>{!reliable ? '没有可靠的学员问诊原文，本次只保存总结，不请求AI反馈。请勿据此判断问诊能力。' : manual ? '本次为手动生成：提交只锁定保存总结，需要时再生成AI反馈。' : '本次设为自动生成：提交会请求模型；也可先仅保存总结，稍后再生成。'}</Notice>
    <div className="summary-case"><strong>{session.caseTitle}</strong><span>{session.turns.length} 条转录</span></div>
    {loadFailed && <div className="summary-load-error"><Notice tone="error">{error} 原文件保留；读取成功前暂停编辑，避免覆盖未恢复的内容。</Notice><button className="secondary-button full" onClick={onRetryLoad} disabled={!!busy}>重新读取草稿</button></div>}
    <form noValidate onSubmit={event => { event.preventDefault(); onSubmit(manual); }}>
      {summaryFields.map((field, index) => {
        const rule = SUMMARY_RULES[field.key], issue = issues[field.key];
        return <div className="field summary-field" key={field.key}><label htmlFor={'summary-' + field.key}><span>{String(index + 1).padStart(2, '0')}</span>{field.label}</label><p>{field.hint}</p>
          <textarea id={'summary-' + field.key} rows={4} value={value[field.key]} maxLength={rule.max} onChange={event => onChange(field.key, event.target.value)} disabled={disabled} aria-invalid={!!value[field.key] && !!issue} aria-describedby={'summary-limit-' + field.key} />
          <p id={'summary-limit-' + field.key} className={'summary-limit ' + (issue && value[field.key] ? 'invalid' : '')}>{value[field.key].length} / {rule.max} 字 · 至少 {rule.min} 字{value[field.key] && issue ? <span>{issue}</span> : null}</p>
        </div>;
      })}
      <div className="summary-draft-status" role="status"><p>{loadFailed ? '草稿尚未恢复' : !ready ? '正在读取草稿…' : saved ? '草稿已保存到本机' : error ? '草稿尚未保存' : '输入后自动保存草稿'}</p><button type="button" className="text-button" disabled={disabled} onClick={onSaveDraft}>{error ? '重试保存草稿' : '保存草稿'}</button></div>
      {!!error && !loadFailed && <Notice tone="error">{error}</Notice>}
      <button className="primary-button full" type="submit" disabled={disabled || !valid}>{busy === 'summary' ? <IonSpinner name="crescent" /> : null}{busy === 'summary' ? '正在处理，请稍候…' : !reliable ? '仅保存总结，不生成AI反馈' : manual ? '提交总结，稍后生成反馈' : '提交总结并生成AI反馈'}</button>
      {!manual && <button className="secondary-button full summary-save-only" type="button" onClick={() => onSubmit(true)} disabled={disabled || !valid}>只保存总结，暂不生成反馈</button>}
      <p className="small-note">提交成功后总结锁定，后续生成或重试使用原总结。</p>
    </form>
    <button className="text-button centered" onClick={onViewRecord} disabled={!!busy}>回看本次问诊原文</button>
  </main>;
}
