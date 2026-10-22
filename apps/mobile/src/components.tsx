import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IonIcon, IonSpinner } from '@ionic/react';
import { bookOutline, closeOutline, informationCircleOutline, micOutline, personOutline, playOutline, volumeHighOutline } from 'ionicons/icons';
import { api, errorMessage, type LearnerSummary, type Session, type Turn } from './api';
import type { VoiceState } from './audio';

export const summaryFields: { key: keyof LearnerSummary; label: string; hint: string }[] = [
  { key: 'history', label: '病史总结', hint: '用自己的话归纳主诉、现病史与重要阴性信息。' },
  { key: 'reasoning', label: '初步判断与依据', hint: '写下初步判断、鉴别思路及支持或不支持的依据。' },
  { key: 'plan', label: '下一步计划', hint: '说明计划补充的检查、评估及处理原则。' },
  { key: 'uncertainty', label: '仍不确定的地方', hint: '记录信息缺口、需要核实的问题，以及判断的边界。' },
];
export const emptySummary: LearnerSummary = { history: '', reasoning: '', plan: '', uncertainty: '' };
export const statusText: Record<Session['status'], string> = { interview: '问诊中', summary: '待写总结', feedback_pending: '复盘待生成', feedback_ready: '待教师复核', reviewed: '已有复核记录' };
export const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export function turnTime(turn: Turn, session: Session) {
  const seconds = Math.max(0, Math.floor((Date.parse(turn.at) - Date.parse(session.createdAt)) / 1000));
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
export function Badge({ children, tone = 'neutral', icon }: { children: ReactNode; tone?: 'neutral' | 'teal' | 'amber' | 'red'; icon?: string }) {
  return <span className={'badge ' + tone}>{icon && <IonIcon icon={icon} aria-hidden="true" />}{children}</span>;
}
export function Notice({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'error' | 'success' }) {
  return <div className={'notice ' + tone} role={tone === 'error' ? 'alert' : undefined}><IonIcon icon={informationCircleOutline} aria-hidden="true" /><div>{children}</div></div>;
}
export function EmptyState({ icon = bookOutline, title, children, action }: { icon?: string; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><IonIcon icon={icon} aria-hidden="true" /></span><h2>{title}</h2><p>{children}</p>{action}</div>;
}
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    const onBack = (event: Event) => {
      const open = document.querySelectorAll('dialog[open]');
      if (!dialog?.open || event.defaultPrevented || open[open.length - 1] !== dialog) return;
      event.preventDefault(); closeRef.current();
    };
    window.addEventListener('hpb:back', onBack);
    return () => { window.removeEventListener('hpb:back', onBack); dialog?.close(); };
  }, []);
  return <dialog ref={ref} className="app-dialog" onCancel={onClose}><div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><IonIcon icon={closeOutline} /></button></div>{children}</dialog>;
}
export function AudioMeter({ voice }: { voice: VoiceState }) {
  const level = voice.connection === 'ready' ? Math.max(voice.inputLevel, voice.outputLevel) : 0;
  return <div className={'audio-meter ' + (level > 0.015 ? 'active' : '')} aria-label={level > 0.015 ? '检测到音频活动' : '当前没有音频活动'}>
    {Array.from({ length: 31 }, (_, index) => <span key={index} style={{ height: Math.max(3, level * (0.22 + (1 - Math.abs(index - 15) / 16) * 0.78) * 70) + 'px' }} />)}
  </div>;
}
export function Transcript({ session, compact = false, highlight, onClearHighlight }: { session: Session; compact?: boolean; highlight?: string; onClearHighlight?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = session.turns[session.turns.length - 1];
  useEffect(() => {
    if (highlight) {
      document.getElementById('turn-' + highlight)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const timer = window.setTimeout(() => onClearHighlight?.(), 5000);
      return () => clearTimeout(timer);
    }
    if (compact && ref.current) {
      const parent = ref.current;
      if (parent.scrollHeight - parent.scrollTop - parent.clientHeight < 220) parent.scrollTop = parent.scrollHeight;
    }
  }, [last?.id, last?.text, highlight, compact, onClearHighlight]);
  return <div ref={ref} className={'transcript ' + (compact ? 'compact' : '')} aria-live="polite" aria-relevant="additions text">
    {!session.turns.length && <div className="transcript-empty"><IonIcon icon={micOutline} /><p>这里将显示本次问诊的转录</p><span>连接后，以医生的身份向患者开口。</span></div>}
    {session.turns.map((turn) => <article id={'turn-' + turn.id} key={turn.id} className={'turn ' + turn.role + (highlight === turn.id ? ' highlighted' : '')}>
      <span className="turn-avatar"><IonIcon icon={turn.role === 'patient' ? personOutline : micOutline} aria-hidden="true" /></span>
      <div className="turn-content"><div className="turn-meta"><span>{turn.role === 'patient' ? '患者' : '你'}</span><time dateTime={turn.at}>{turnTime(turn, session)}</time>{turn.verification === 'paraphrase_unverified' ? <span>转述待核对</span> : !turn.final && <span>未确认转录</span>}</div><p>{turn.text || '正在转录…'}</p>{turn.interrupted && <small>该条回应已被打断</small>}</div>
    </article>)}
  </div>;
}
export function SummaryRead({ summary }: { summary: LearnerSummary }) {
  return <section className="summary-read">{summaryFields.map((field) => <div key={field.key}><h3>{field.label}</h3><p>{summary[field.key] || '未填写'}</p></div>)}</section>;
}
export function AudioRecordings({ session }: { session: Session }) {
  const [urls, setUrls] = useState<Partial<Record<'learner' | 'patient', string>>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const allocated = useRef<string[]>([]);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; allocated.current.forEach((url) => URL.revokeObjectURL(url)); allocated.current = []; }; }, [session.id]);
  if (!session.recordings?.learner && !session.recordings?.patient) return null;
  async function load(role: 'learner' | 'patient') {
    setBusy(role); setError('');
    try {
      const blob = await api.recordingBlob(session.id, role);
      if (!active.current) return;
      const url = URL.createObjectURL(blob);
      allocated.current.push(url);
      setUrls((previous) => ({ ...previous, [role]: url }));
    } catch (cause) { if (active.current) setError(errorMessage(cause)); }
    finally { if (active.current) setBusy(''); }
  }
  return <section className="panel audio-recordings"><h2><IonIcon icon={volumeHighOutline} />录音核对</h2><p>连续录音尚未与转录逐句对齐，可配合原文核对。</p>{(['learner', 'patient'] as const).filter((role) => session.recordings?.[role]).map((role) => <div className="recording-row" key={role}><strong>{role === 'learner' ? '学员原始录音' : '患者合成语音'}</strong>{urls[role] ? <audio controls preload="metadata" src={urls[role]} aria-label={role === 'learner' ? '学员原始录音' : '患者合成语音'} /> : <button className="secondary-button" onClick={() => void load(role)} disabled={Boolean(busy)}>{busy === role ? <IonSpinner name="crescent" /> : <IonIcon icon={playOutline} />}{busy === role ? '正在读取…' : '读取录音'}</button>}</div>)}{error && <Notice tone="error">{error}</Notice>}</section>;
}

