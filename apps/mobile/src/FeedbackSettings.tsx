import { useEffect, useState, type FormEvent } from 'react';
import { IonSpinner } from '@ionic/react';
import { getAssessmentMetadata } from '../../../packages/core/src/assessment';
import { Notice } from './components';
import { validateFeedbackPreferences, type FeedbackPreferences, type FeedbackGeneration } from './platform/feedback-preferences';
import './FeedbackSettings.css';

export interface FeedbackSettingsProps {
  preferences: FeedbackPreferences;
  ready: boolean;
  onSave: (value: FeedbackPreferences) => Promise<void>;
}

/** Only changes defaults for future sessions; the adapted assessment and its weights are not editable here. */
export function FeedbackSettings({ preferences, ready, onSave }: FeedbackSettingsProps) {
  const [draft, setDraft] = useState<FeedbackPreferences>({ ...preferences });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => { setDraft({ ...preferences }); setNotice(''); }, [preferences]);
  const metadata = getAssessmentMetadata();
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!ready || busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await onSave(validateFeedbackPreferences(draft)); setNotice('反馈生成设置已保存，仅用于新开始的训练。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '设置尚未保存，请重试。'); }
    finally { setBusy(false); }
  }
  function change(mode: 'practice' | 'research', value: string) {
    setDraft(current => ({ ...current, [mode]: value as FeedbackGeneration })); setNotice(''); setError('');
  }
  return <section className="panel feedback-settings" aria-labelledby="feedback-settings-title">
    <div className="section-heading"><h2 id="feedback-settings-title">自动反馈设置</h2><span className="feedback-settings-local">本机默认</span></div>
    <p className="feedback-settings-intro">分别设置日常练习与研究用途的生成方式；开始训练时固定，不追改旧记录。旧训练未记录生成方式时，按手动处理。</p>
    {error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}
    {!ready && <Notice>正在读取本机反馈设置，读取完成后可修改。</Notice>}
    <form onSubmit={event => void submit(event)}>
      <div className="feedback-settings-selects">{([['practice', '日常练习'], ['research', '研究用途记录']] as const).map(([mode, label]) => <div className="field" key={mode}>
        <label htmlFor={'feedback-' + mode}>{label}</label>
        <select id={'feedback-' + mode} value={draft[mode]} onChange={event => change(mode, event.target.value)} disabled={!ready || busy}>
          <option value="automatic">提交总结后自动生成</option><option value="manual">先保存总结，手动生成</option>
        </select>
      </div>)}</div>
      <p className="field-note">自动生成会请求所选模型，可能产生 API 用量。手动模式先锁定保存独立总结，需要时再生成反馈。</p>
      <p className="field-note">此设置仅为本机默认，不随研究备份导出或恢复；已有训练保留各自开始时记录的方式。</p>
      <button className="primary-button full" type="submit" disabled={!ready || busy}>{busy ? <><IonSpinner name="crescent" />正在保存…</> : '保存反馈设置'}</button>
    </form>
    <details className="feedback-settings-rubric"><summary>当前量规与评分依据<span>固定规则，不在此修改权重</span></summary>
      <div className="feedback-settings-rubric-body"><strong>{metadata.name}</strong>
        <p>当前共 12 项：病例信息采集 5 项、可观察的语言沟通过程 7 项。两组分别报告已评分与覆盖率，不合并百分制、不设合格线。</p>
        <dl><div><dt>2 分</dt><dd>可靠原文支持充分实现。</dd></div><div><dt>1 分</dt><dd>可靠原文仅支持部分实现。</dd></div><div><dt>0 分</dt><dd>有直接原文支持明确不当行为。</dd></div><div><dt>null / 未计分</dt><dd>证据不足、不适用或无法观察，不计入已评分母。</dd></div></dl>
        <p>这是形成性改编量规；自动反馈需教师复核，不是正式研究考核成绩。已知偏高与跨轮次漏评仍待改进。</p>
        <h3>来源与改编</h3><ol>{metadata.sources.map(source => <li key={source.id}>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a> : <strong>{source.title}</strong>}<p>{source.note}</p></li>)}</ol>
        <h3>适用限制</h3><ul>{metadata.limitations.map(item => <li key={item}>{item}</li>)}</ul>
      </div>
    </details>
  </section>;
}
