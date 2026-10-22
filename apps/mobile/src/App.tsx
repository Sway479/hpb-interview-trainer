import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Capacitor } from '@capacitor/core';
import { IonApp, IonContent, IonIcon, IonPage, IonSpinner, setupIonicReact } from '@ionic/react';
import {
  arrowBackOutline, arrowForwardOutline, bookOutline, checkmarkCircle, chevronForwardOutline,
  closeOutline, cloudOfflineOutline, documentTextOutline, downloadOutline, eyeOffOutline, eyeOutline,
  informationCircleOutline, linkOutline, micOffOutline, micOutline, pauseOutline, personOutline,
  playOutline, pulseOutline, refreshOutline, sendOutline, settingsOutline, shieldCheckmarkOutline,
  sparklesOutline, stopCircleOutline, timeOutline, volumeHighOutline, flaskOutline,
} from 'ionicons/icons';
import { api, errorMessage, readSettings, saveSettings, type CasePreview, type LearnerSummary, type Session } from './api';
import type { ConnectionSettings, CredentialStatuses, ExportResult, Participant, ResearchSelection, Study } from './platform/contracts';
import { DEFAULT_RESEARCH_SELECTION } from './platform/contracts';
import { loadResearchSelection, saveResearchSelection, validateResearchSelection } from './platform/research-selection';
import { listenForAndroidBackButton } from './platform/android-back';
import { HpbNative } from './platform/native-bridge';
import { ProviderSettings } from './ProviderSettings';
import { ResearchContextCard, ResearchPanel, ResearchSnapshotCard, type StudyInput, type ParticipantInput } from './ResearchPanel';
import { initialVoiceState, VoiceConnection, type VoiceState } from './audio';
import { FeedbackAssessment } from './FeedbackAssessment';
import { AudioMeter, AudioRecordings, Badge, EmptyState, Modal, Notice, SummaryRead, Transcript, emptySummary, formatTime, statusText, summaryFields, turnTime } from './components';
import '@ionic/react/css/core.css';
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';
import './theme/variables.css';
import './App.css';
setupIonicReact({ mode: 'md' });
type Screen = 'cases' | 'case' | 'interview' | 'summary' | 'feedback' | 'history' | 'record' | 'settings' | 'research';

function App() {
  const [screen, setScreen] = useState<Screen>('cases');
  const [scrollReadyScreen, setScrollReadyScreen] = useState<Screen | null>(null);
  const [settings, setSettings] = useState<ConnectionSettings>(readSettings);
  const [settingsReady, setSettingsReady] = useState(false);
  const [credentials, setCredentials] = useState<CredentialStatuses>({});
  const [studies, setStudies] = useState<Study[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [researchLoading, setResearchLoading] = useState(true);
  const [researchReady, setResearchReady] = useState(false);
  const [researchWarning, setResearchWarning] = useState('');
  const [researchRequiresConfirmation, setResearchRequiresConfirmation] = useState(false);
  const [researchSaving, setResearchSaving] = useState(false);
  const [researchSelection, setResearchSelection] = useState<ResearchSelection>({ ...DEFAULT_RESEARCH_SELECTION });
  const [cases, setCases] = useState<CasePreview[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedCase, setSelectedCase] = useState<CasePreview | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [filter, setFilter] = useState('全部');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [voice, setVoice] = useState<VoiceState>({ ...initialVoiceState });
  const [text, setText] = useState('');
  const [summary, setSummary] = useState<LearnerSummary>({ ...emptySummary });
  const [draftSaved, setDraftSaved] = useState(false);
  const [draftReady, setDraftReady] = useState(true);
  const [reviewer, setReviewer] = useState('');
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirm, setConfirm] = useState<'finish' | 'leave' | null>(null);
  const [exportText, setExportText] = useState('');
  const [exportMessage, setExportMessage] = useState('');
  const [exportAudio, setExportAudio] = useState(false);
  const [highlight, setHighlight] = useState('');
  const [now, setNow] = useState(Date.now());
  const contentRef = useRef<HTMLIonContentElement>(null);
  const connection = useRef<VoiceConnection | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const draftQueue = useRef<Promise<void>>(Promise.resolve());
  const draftRevision = useRef(0);
  const androidBackAction = useRef<() => void>(() => {});
  const researchSavePending = useRef(false);
  sessionRef.current = session;

  const applySession = useCallback((value: Session) => {
    setSession(value);
    setSessions((previous) => [value, ...previous.filter((item) => item.id !== value.id)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
  }, []);
  const closeVoice = useCallback(async () => {
    const current = connection.current; connection.current = null;
    if (current) await current.close();
  }, []);
  const reload = useCallback(async () => {
    setLoading(true); setLoadError('');
    const results = await Promise.allSettled([api.cases(settings), api.sessions(settings)]);
    if (results[0].status === 'fulfilled') setCases(results[0].value);
    else setLoadError(errorMessage(results[0].reason));
    if (results[1].status === 'fulfilled') {
      setSessions(results[1].value);
    } else if (results[0].status === 'fulfilled') setLoadError('病例已加载，但本机记录读取失败：' + errorMessage(results[1].reason));
    setLoading(false);
  }, [settings]);
  const reloadResearch = useCallback(async () => {
    setResearchLoading(true);
    try {
      const [nextStudies, nextParticipants] = await Promise.all([api.studies(), api.participants()]);
      const saved = await loadResearchSelection({ studies: nextStudies, participants: nextParticipants });
      setStudies(nextStudies); setParticipants(nextParticipants);
      setResearchSelection(saved.selection); setResearchWarning(saved.warning || ''); setResearchReady(true);
      setResearchRequiresConfirmation(Boolean(saved.warning));
    } catch (cause) { setResearchReady(false); throw cause; }
    finally { setResearchLoading(false); }
  }, []);
  useEffect(() => listenForAndroidBackButton(() => androidBackAction.current(), () => {
    setError('系统返回键未能初始化，请使用页面上的返回按钮。');
  }), []);
  useEffect(() => {
    let active = true;
    setScrollReadyScreen(null);
    const ready = () => { if (active) setScrollReadyScreen(screen); };
    void (contentRef.current?.scrollToTop(0) ?? Promise.resolve()).then(ready, ready);
    return () => { active = false; };
  }, [screen]);
  useEffect(() => {
    let active = true;
    void api.settings().then((value) => { if (active) setSettings(value); }).catch((cause) => { if (active) setError('本机 API 配置读取失败：' + errorMessage(cause)); }).finally(() => { if (active) setSettingsReady(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (settingsReady) void reload(); }, [reload, settingsReady]);
  useEffect(() => { if (settingsReady) void reloadResearch().catch((cause) => setError('科研登记读取失败：' + errorMessage(cause))); }, [reloadResearch, settingsReady]);
  useEffect(() => {
    if (!settingsReady) return;
    let active = true;
    void api.credentialStatus(settings.profiles.map((profile) => profile.id)).then((value) => { if (active) setCredentials(value); }).catch((cause) => { if (active) { setCredentials({}); setError('密钥状态未能确认：' + errorMessage(cause)); } });
    return () => { active = false; };
  }, [settings, settingsReady, screen]);
  useEffect(() => {
    if (!session?.id) return;
    let active = true;
    setDraftReady(false); setDraftSaved(false);
    setSummary(session.summary || { ...emptySummary });
    if (session.summary) setDraftReady(true);
    else void api.getDraft(session.id).then((saved) => { if (active) { setSummary(saved || { ...emptySummary }); setDraftSaved(Boolean(saved)); } }).catch((cause) => { if (active) setError('草稿读取失败：' + errorMessage(cause)); }).finally(() => { if (active) setDraftReady(true); });
    setReviewer(session.review?.reviewer || ''); setReviewNotes(session.review?.notes || '');
    return () => { active = false; };
  }, [session?.id]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => () => { void connection.current?.close(); }, []);
  useEffect(() => {
    const onHidden = () => {
      if (document.hidden && connection.current) {
        void closeVoice();
        setVoice((current) => ({ ...current, connection: 'disconnected', microphone: 'off', inputLevel: 0, outputLevel: 0, error: '应用已进入后台，语音已停止。返回后可重新连接。' }));
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [closeVoice]);
  function navigate(next: Screen) { setError(''); setScreen(next); }
  function makeConnection() {
    const current = new VoiceConnection({
      state: setVoice,
      turn: (turn) => setSession((previous) => {
        if (!previous) return previous;
        const index = previous.turns.findIndex((value) => value.id === turn.id);
        const turns = [...previous.turns];
        if (index < 0) turns.push(turn); else turns[index] = turn;
        const updated = { ...previous, turns }; sessionRef.current = updated; return updated;
      }),
      ended: (value) => { applySession(value); setScreen('summary'); },
    });
    connection.current = current; return current;
  }
  async function startCase() {
    if (!selectedCase || busy) return;
    if (researchSavePending.current) { setError('训练绑定正在保存，请稍后再开始。'); return; }
    if (!researchReady || researchLoading) { setError('训练登记尚未读取完成，请在科研页刷新后重试。'); return; }
    if (researchRequiresConfirmation) {
      navigate('research'); setError('上次训练绑定未能恢复，请重新设置训练用途；也可以明确选择练习模式并保存。'); return;
    }
    let selection: ResearchSelection;
    try { selection = validateResearchSelection(researchSelection, { studies, participants }); }
    catch (cause) { navigate('research'); setError(errorMessage(cause)); return; }
    const textProfile = settings.profiles.find((profile) => profile.id === settings.textProfileId);
    if (!textProfile || !credentials[textProfile.id]?.hasKey) { navigate('settings'); setError('请先保存病例与评价模型的 API 配置与 Key。'); return; }
    setBusy('start'); setError('');
    let current: VoiceConnection | null = null;
    try {
      await closeVoice();
      if (settings.voiceProfileId) {
        current = makeConnection();
        try { await current.prepare(); } catch (cause) { setVoice({ ...initialVoiceState, connection: 'error', error: errorMessage(cause) }); }
      } else setVoice({ ...initialVoiceState });
      const value = await api.start(settings, selectedCase.id, selection);
      applySession(value); setSummary({ ...emptySummary }); setText(''); setScreen('interview');
      if (current) void current.connect(settings, value.id);
    } catch (cause) { setError(errorMessage(cause)); await current?.close(); }
    finally { setBusy(''); }
  }
  async function reconnect() {
    if (!session || busy) return;
    if (!session.runtime?.voice && !settings.voiceProfileId) { navigate('settings'); return; }
    setBusy('connect'); setError('');
    try {
      await closeVoice(); const current = makeConnection();
      try { await current.prepare(); } catch (cause) { setVoice({ ...initialVoiceState, connection: 'error', error: errorMessage(cause) }); }
      const value = await api.session(settings, session.id); applySession(value);
      if (value.status !== 'interview') { await current.close(); setScreen(value.summary ? 'feedback' : 'summary'); return; }
      void current.connect(settings, value.id);
    } catch (cause) { setError(errorMessage(cause)); await closeVoice(); }
    finally { setBusy(''); }
  }
  async function openSession(value: Session) {
    setBusy('open'); setError('');
    try {
      await closeVoice(); const latest = await api.session(settings, value.id); applySession(latest);
      setVoice({ ...initialVoiceState }); setText('');
      navigate(latest.status === 'interview' ? 'interview' : latest.status === 'summary' ? 'summary' : 'feedback');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(''); }
  }
  async function sendText(event: FormEvent) {
    event.preventDefault(); const value = text.trim();
    if (!session || !value || busy || voice.connection === 'connecting') return;
    setBusy('text'); setError('');
    try {
      if (voice.connection === 'ready' && connection.current) { await connection.current.sendText(value); setText(''); }
      else { applySession(await api.text(settings, session.id, value)); setText(''); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(''); }
  }
  async function finishInterview() {
    if (!session || busy) return;
    setConfirm(null); setBusy('finish'); setError('');
    try {
      let updated = await connection.current?.finish(); connection.current = null;
      if (!updated) { updated = await api.session(settings, session.id); if (updated.status === 'interview') updated = await api.end(settings, session.id); }
      applySession(updated); setVoice({ ...initialVoiceState }); navigate(updated.summary ? 'feedback' : 'summary');
    } catch (cause) { setError('结束问诊未完成：' + errorMessage(cause)); }
    finally { await closeVoice(); setBusy(''); }
  }
  function editSummary(key: keyof LearnerSummary, value: string) {
    const next = { ...summary, [key]: value }; setSummary(next);
    if (session) {
      const id = session.id; const revision = ++draftRevision.current;
      setDraftSaved(false);
      draftQueue.current = draftQueue.current.catch(() => undefined).then(() => api.saveDraft(id, next)).then(() => { if (sessionRef.current?.id === id && draftRevision.current === revision) setDraftSaved(true); }).catch((cause) => { if (sessionRef.current?.id === id) { setDraftSaved(false); setError('草稿尚未保存：' + errorMessage(cause)); } });
    }
  }
  async function submitSummary() {
    if (!session || busy) return;
    if (summaryFields.some((field) => !summary[field.key].trim())) { setError('请完成四项独立总结；不确定的内容可以直接说明。'); return; }
    setBusy('summary'); setError('');
    try { await draftQueue.current; applySession(await api.summary(settings, session.id, summary)); await api.saveDraft(session.id, null); navigate('feedback'); }
    catch (cause) {
      const message = errorMessage(cause);
      try { const latest = await api.session(settings, session.id); applySession(latest); if (latest.summary) setScreen('feedback'); setError(message); }
      catch { setError(message); }
    } finally { setBusy(''); }
  }
  async function retryFeedback() {
    if (!session?.summary || busy) return;
    setBusy('feedback'); setError('');
    try { applySession(await api.summary(settings, session.id, session.summary)); }
    catch (cause) { setError(errorMessage(cause)); try { applySession(await api.session(settings, session.id)); } catch { /* Keep confirmed data. */ } }
    finally { setBusy(''); }
  }
  async function saveReview(event: FormEvent) {
    event.preventDefault(); if (!session || !reviewer.trim() || !reviewNotes.trim() || busy) return;
    setBusy('review'); setError('');
    try { applySession(await api.review(settings, session.id, reviewer.trim(), reviewNotes.trim())); setReviewOpen(false); }
    catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  async function exportSession() {
    if (!session || busy) return;
    setBusy('export'); setError(''); setExportMessage(''); setExportAudio(false);
    try { setExportText(JSON.stringify(await api.export(settings, session.id), null, 2)); }
    catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  function exportResultMessage(result: ExportResult) {
    if (result.content !== undefined) {
      const url = URL.createObjectURL(new Blob([result.content], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.fileName; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      return result.fileName + ' · 已发起 JSON 备份下载。音频 ZIP 分享请在安卓 App 中使用。';
    }
    return result.fileName + ' · ' + (result.bytes / 1024).toFixed(1) + ' KB' + (result.shared ? ' · 已打开系统分享' : ' · 文件已生成');
  }
  async function shareCurrentSession() {
    if (!session || busy) return;
    setBusy('share'); setExportMessage('');
    try { setExportMessage(exportResultMessage(await api.shareSession(session.id, { includeAudio: exportAudio }))); }
    catch (cause) { setExportMessage('导出未完成：' + errorMessage(cause)); }
    finally { setBusy(''); }
  }
  async function copyJson() {
    try { await navigator.clipboard.writeText(exportText); setExportMessage('JSON 已复制。'); }
    catch { setExportMessage('当前环境不能自动复制，请在下方文本框中全选复制。'); }
  }
  async function applyProviderSettings(value: ConnectionSettings) {
    await closeVoice(); setSettings(value);
    setCredentials(await api.credentialStatus(value.profiles.map((profile) => profile.id)));
  }
  async function saveStudy(value: StudyInput) { await api.saveStudy(value); await reloadResearch(); }
  async function saveParticipant(value: ParticipantInput) { await api.saveParticipant(value); await reloadResearch(); }
  async function deleteParticipant(id: string) { await api.deleteParticipant(id); await reloadResearch(); }
  async function applyResearchSelection(value: ResearchSelection) {
    if (!researchReady || researchLoading) throw new Error('训练登记尚未读取完成，请刷新后重试。');
    if (researchSavePending.current) throw new Error('训练绑定正在保存，请稍后重试。');
    researchSavePending.current = true; setResearchSaving(true);
    try {
      const saved = await saveResearchSelection(value, { studies, participants });
      setResearchSelection(saved); setResearchWarning(''); setResearchRequiresConfirmation(false);
    } finally { researchSavePending.current = false; setResearchSaving(false); }
  }
  async function exportResearch(options: { studyId?: string; includeAudio: boolean }) { return exportResultMessage(await api.researchExport(options)); }
  async function importResearch(json: string) {
    const result = await api.importBackup(json);
    await Promise.all([reloadResearch(), reload()]);
    return '恢复完成：项目 ' + result.studies + '，学员 ' + result.participants + '，会话 ' + result.sessions + '，草稿 ' + result.drafts + '；跳过一致记录 ' + result.skipped + '。';
  }
  const clearHighlight = useCallback(() => setHighlight(''), []);
  const levels = ['全部', ...new Set(cases.map((value) => value.level))];
  const visibleCases = filter === '全部' ? cases : cases.filter((value) => value.level === filter);
  const unfinished = sessions.find((value) => value.status === 'interview' || value.status === 'summary');
  const interview = screen === 'interview';
  const rootScreen = ['cases', 'history', 'settings', 'research'].includes(screen);
  const pageTitle: Record<Screen, string> = { cases: '问诊陪练', case: '训练准备', interview: '正在问诊', summary: '独立总结', feedback: '反馈复盘', history: '训练记录', record: '完整记录', settings: 'API 配置', research: '科研登记' };
  const textProfile = settings.profiles.find((profile) => profile.id === settings.textProfileId);
  const voiceProfile = settings.profiles.find((profile) => profile.id === settings.voiceProfileId);
  const voiceAvailable = session?.runtime ? Boolean(session.runtime.voice) : Boolean(voiceProfile);
  const seconds = session ? Math.max(0, Math.floor(((session.endedAt ? Date.parse(session.endedAt) : now) - Date.parse(session.createdAt)) / 1000)) : 0;
  const timer = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  const voiceLabel = voice.connection === 'ready' ? '实时连接已就绪' : voice.connection === 'connecting' ? '正在连接语音服务' : voice.connection === 'idle' ? '语音尚未连接' : '语音连接已断开';
  const activityLabel = voice.microphone === 'starting' ? '正在启用麦克风' : voice.microphone === 'muted' ? '麦克风已静音' : voice.microphone === 'error' ? '点击麦克风重试' : voice.outputLevel > 0.015 ? '患者正在回应' : voice.reasoning ? '正在组织患者回答' : voice.speaking ? '正在聆听你的提问' : voice.responding ? '正在准备语音回应' : voice.microphone === 'listening' ? '正在聆听，随时开口' : '连接后即可开始语音问诊';
  function back() {
    if (screen === 'interview') setConfirm('leave');
    else if (screen === 'record') navigate(session?.summary ? 'feedback' : session?.status === 'summary' ? 'summary' : 'history');
    else if (screen === 'feedback' || screen === 'summary') navigate('history');
    else navigate('cases');
  }
  androidBackAction.current = () => {
    if (busy || researchSavePending.current) return;
    if (!rootScreen) back();
    else if (screen !== 'cases') navigate('cases');
    else void HpbNative.minimizeApp().catch(() => setError('暂时无法退到后台，请使用系统主页键。'));
  };

  return <IonApp><IonPage className="app-page">
    <header className={'app-header ' + (rootScreen ? 'root-header' : '')}>
      {rootScreen ? <div className="wordmark"><IonIcon icon={pulseOutline} aria-hidden="true" /><span>问诊陪练<small>肝胆胰外科住培</small></span></div> : <button className="icon-button" aria-label="返回" onClick={back} disabled={Boolean(busy)}><IonIcon icon={arrowBackOutline} /></button>}
      {!rootScreen && <h1>{pageTitle[screen]}</h1>}
      {screen === 'cases' ? <button className="icon-button" aria-label="API 配置" onClick={() => navigate('settings')}><IonIcon icon={settingsOutline} /></button> : interview ? <Badge>虚构患者</Badge> : <span className="header-spacer" />}
    </header>
    <IonContent ref={contentRef} className={'app-content ' + (interview ? 'interview-content' : '')}>
      {error && <div className="global-error"><Notice tone="error">{error}</Notice><button className="icon-button" aria-label="收起错误提示" onClick={() => setError('')}><IonIcon icon={closeOutline} /></button></div>}
      {researchWarning && <div className="global-error"><Notice>{researchWarning}</Notice><button className="icon-button" aria-label="收起登记提示" onClick={() => setResearchWarning('')}><IonIcon icon={closeOutline} /></button></div>}
      {screen === 'cases' && <main className="page-pad cases-page">
        <div className="eyebrow">肝胆胰外科住培</div><h1 className="page-title">选择一个病例</h1><p className="page-subtitle">从主诉开始，练习完整问诊。</p>
        <div className="training-banner"><IonIcon icon={informationCircleOutline} aria-hidden="true" /><span>虚构病例 · 仅用于教学训练</span></div>
        {unfinished && !loading && <button className="resume-card" onClick={() => void openSession(unfinished)} disabled={Boolean(busy)}><span className="resume-icon"><IonIcon icon={playOutline} /></span><span><small>继续上次训练</small><strong>{unfinished.caseTitle}</strong></span><Badge tone="teal">{statusText[unfinished.status]}</Badge><IonIcon icon={chevronForwardOutline} /></button>}
        <div className="section-heading"><h2>病例库</h2><span>{loading ? '正在读取' : cases.length + ' 个病例'}</span></div>
        {!!cases.length && <div className="segmented" aria-label="病例难度">{levels.map((level) => <button key={level} className={filter === level ? 'selected' : ''} aria-pressed={filter === level} onClick={() => setFilter(level)}>{level}</button>)}</div>}
        {loadError && <div className="load-error"><Notice tone="error">{loadError}</Notice><div className="inline-actions"><button className="text-button" onClick={() => void reload()}><IonIcon icon={refreshOutline} />重新加载</button><button className="text-button" onClick={() => navigate('settings')}>API 配置</button></div></div>}
        {loading && !cases.length && <div className="loading-panel"><IonSpinner name="crescent" /><p>正在读取训练病例…</p></div>}
        <div className="case-list">{visibleCases.map((value) => <button className="case-card" key={value.id} onClick={() => { setSelectedCase(value); navigate('case'); }}><span className="case-icon"><IonIcon icon={documentTextOutline} aria-hidden="true" /></span><span className="case-info"><strong>{value.title}</strong><span>{value.level} · 约 {value.durationMinutes} 分钟</span><small>{value.subtitle || '采集病史，形成初步判断'}</small></span><IonIcon className="chevron" icon={chevronForwardOutline} aria-hidden="true" /></button>)}</div>
        {!loading && !loadError && !visibleCases.length && <EmptyState title="暂无匹配的病例">请切换难度，或稍后重新加载病例库。</EmptyState>}
        <div className="page-footnote"><IonIcon icon={shieldCheckmarkOutline} />训练反馈供教学参考，需结合教师复核。</div>
      </main>}
      {screen === 'case' && selectedCase && <main className="page-pad case-detail">
        <Badge tone="teal" icon={documentTextOutline}>病例 {selectedCase.id}</Badge><h1 className="page-title">{selectedCase.title}</h1><p className="page-subtitle">{selectedCase.chiefComplaint}</p>
        <div className="patient-preview"><span className="patient-avatar"><IonIcon icon={personOutline} /></span><div><h2>{selectedCase.patient.alias}</h2><p>{selectedCase.patient.sex} · {selectedCase.patient.age} 岁</p></div><Badge>虚构患者</Badge></div>
        <div className="detail-meta"><div><IonIcon icon={timeOutline} /><span>预计用时<strong>{selectedCase.durationMinutes} 分钟</strong></span></div><div><IonIcon icon={bookOutline} /><span>训练难度<strong>{selectedCase.level}</strong></span></div></div>
        <p className="case-runtime-note">病例与评价：<strong>{textProfile ? textProfile.name + ' · ' + textProfile.chatModel : '尚未配置'}</strong><br />语音：<strong>{voiceProfile ? voiceProfile.name + ' · ' + voiceProfile.realtimeModel : '未选择，本次使用文字问诊'}</strong><br />问诊内容将发送至所选 API，登记信息保存在本机。</p>
        <ResearchContextCard selection={researchSelection} studies={studies} participants={participants} onEdit={() => navigate('research')} />
        <section className="panel"><h2>这次如何练习</h2><ol className="practice-steps"><li><span>1</span><div><strong>像真实问诊一样开口</strong><p>向患者提问，围绕主诉逐步采集病史。</p></div></li><li><span>2</span><div><strong>先完成自己的判断</strong><p>问诊结束后，独立写下总结与下一步计划。</p></div></li><li><span>3</span><div><strong>带着证据回顾</strong><p>提交总结后查看反馈，与教师共同复盘。</p></div></li></ol></section>
        <Notice>建议在安静环境佩戴耳机。连接就绪后会请求麦克风权限，也可使用文字补充。</Notice>
      </main>}
      {interview && session && <main className="interview-page">
        <section className="interview-status"><div className="session-timer" aria-label={'问诊已持续 ' + timer}>{timer}</div><div className={'connection-label ' + voice.connection}><span />{voiceAvailable ? voiceLabel : '文字问诊 · 语音未启用'}</div><h2>{session.caseTitle}</h2></section>
        {voice.error && <div className="voice-error"><Notice tone="error">{voice.error}</Notice></div>}
        {voice.qualityWarning && <div className="voice-quality"><Notice>转述待核对：{voice.qualityWarning}</Notice></div>}
        {voiceAvailable && voice.connection !== 'ready' && voice.connection !== 'connecting' && <div className="connection-cta"><button className="secondary-button" onClick={() => void reconnect()} disabled={Boolean(busy)}><IonIcon icon={linkOutline} />{voice.connection === 'idle' ? '连接并开始问诊' : '重新连接语音'}</button><span>已确认的对话会继续保留</span></div>}
        {voice.connection === 'connecting' && <div className="connecting-hint"><IonSpinner name="dots" />等待实时服务就绪，麦克风尚未开启</div>}
        <Transcript session={session} compact />
        <section className="voice-dock">{voiceAvailable ? <><p className="activity-label" role="status">{activityLabel}</p><AudioMeter voice={voice} />
          <div className="voice-controls"><button className="minor-audio-button" onClick={() => void connection.current?.interrupt()} disabled={voice.connection !== 'ready' || Boolean(busy)} aria-label="打断患者回应"><IonIcon icon={stopCircleOutline} /><span>打断回应</span></button><button className={'microphone-button ' + (voice.microphone === 'muted' ? 'muted' : '')} aria-label={voice.microphone === 'listening' ? '静音麦克风' : '启用麦克风'} disabled={voice.connection !== 'ready' || Boolean(busy) || voice.microphone === 'starting'} onClick={() => { if (voice.microphone === 'listening') void connection.current?.mute(); else void connection.current?.enableMicrophone(); }}>{voice.microphone === 'starting' ? <IonSpinner name="crescent" /> : <IonIcon icon={voice.microphone === 'muted' ? micOffOutline : micOutline} />}</button><div className="minor-audio-button audio-status"><IonIcon icon={voice.outputLevel > 0.015 ? volumeHighOutline : pauseOutline} /><span>{voice.outputLevel > 0.015 ? '正在播放' : '播放静止'}</span></div></div>
          <p className="microphone-hint">{voice.microphone === 'listening' ? '点击静音麦克风' : voice.microphone === 'muted' ? '点击恢复麦克风' : '麦克风仅在连接就绪后启用'}</p></> : <div className="text-mode-hint"><Badge tone="teal" icon={documentTextOutline}>文字问诊模式</Badge><p>在下方输入问题。更换 API 用途配置将用于新训练。</p></div>}
          <form className="text-composer" onSubmit={(event) => void sendText(event)}><label className="sr-only" htmlFor="typed-message">文字补充</label><input id="typed-message" value={text} onChange={(event) => setText(event.target.value)} placeholder={voice.connection === 'ready' ? '也可以用文字补充…' : '语音未接通，可用文字问诊…'} maxLength={4000} disabled={Boolean(busy)} /><button className="send-button" type="submit" aria-label="发送文字" disabled={!text.trim() || Boolean(busy) || voice.connection === 'connecting'}>{busy === 'text' ? <IonSpinner name="crescent" /> : <IonIcon icon={sendOutline} />}</button></form>
          <button className="end-button" onClick={() => setConfirm('finish')} disabled={Boolean(busy)}>{busy === 'finish' ? '正在结束问诊…' : '结束问诊，撰写总结'}</button>
        </section>
      </main>}
      {screen === 'summary' && session && <main className="page-pad summary-page">
        <div className="eyebrow">先形成自己的判断</div><h1 className="page-title">把问诊串成思路</h1><p className="page-subtitle">完成独立总结后，再查看本次复盘。</p><div className="summary-case"><IonIcon icon={documentTextOutline} /><strong>{session.caseTitle}</strong><span>{session.turns.length} 条转录</span></div>
        {!session.turns.length && <Notice>本次没有已确认的问诊转录。后续反馈将标记证据不足。</Notice>}
        <form onSubmit={(event) => { event.preventDefault(); void submitSummary(); }}>{summaryFields.map((field, index) => <div className="field summary-field" key={field.key}><label htmlFor={'summary-' + field.key}><span>{String(index + 1).padStart(2, '0')}</span>{field.label}</label><p>{field.hint}</p><textarea id={'summary-' + field.key} rows={4} value={summary[field.key]} maxLength={10000} onChange={(event) => editSummary(field.key, event.target.value)} disabled={Boolean(busy) || !draftReady} required /></div>)}<p className="draft-hint">{!draftReady ? '正在读取本机草稿…' : draftSaved ? '草稿已保存到本机' : '填写后自动保存到本机'}</p><button className="primary-button full" type="submit" disabled={Boolean(busy) || !draftReady}>{busy === 'summary' ? <IonSpinner name="crescent" /> : <IonIcon icon={arrowForwardOutline} />}{busy === 'summary' ? '正在提交并生成复盘…' : '提交总结，查看复盘'}</button>{busy === 'summary' && <p className="small-note" role="status">反馈生成可能需要一些时间，请保留此页面。</p>}</form>
        <button className="text-button centered" onClick={() => navigate('record')}>回看本次问诊原文</button>
      </main>}
      {screen === 'feedback' && session && <main className="page-pad feedback-page">
        <div className="badge-row">{session.summary && <Badge tone="teal" icon={checkmarkCircle}>总结已提交</Badge>}<Badge tone={session.review ? 'teal' : 'amber'} icon={session.review ? shieldCheckmarkOutline : timeOutline}>{session.review ? '已有本机复核记录' : '待教师复核'}</Badge></div>
        <h1 className="page-title">本次问诊回顾</h1><p className="page-subtitle">AI 辅助反馈，供教学参考。</p><div className="summary-case"><strong>{session.caseTitle}</strong><span>{formatTime(session.createdAt)}</span></div>
        {!session.turns.length && <Notice>证据不足：本次没有已确认的问诊转录，不能据此判断问诊能力。</Notice>}
        {!session.summary ? <EmptyState title="请先完成独立总结" action={<button className="primary-button full" onClick={() => navigate('summary')}>去写总结</button>}>先写下自己的判断，再生成本次复盘。</EmptyState>
          : !session.feedback ? <section className="panel feedback-pending"><span className="panel-symbol"><IonIcon icon={sparklesOutline} /></span><h2>{busy === 'feedback' ? '正在生成复盘' : '总结已保存，反馈尚未生成'}</h2><p>{session.feedbackError || '可根据已保存的总结重试生成。训练记录和独立总结已保留。'}</p><button className="primary-button full" onClick={() => void retryFeedback()} disabled={Boolean(busy)}>{busy === 'feedback' ? <IonSpinner name="crescent" /> : <IonIcon icon={refreshOutline} />}{busy === 'feedback' ? '生成中…' : '重新生成反馈'}</button></section>
          : <><section className="overview-card"><span className="card-kicker"><IonIcon icon={sparklesOutline} />问诊回顾</span><p>{session.feedback.overview}</p></section>
            <FeedbackAssessment feedback={session.feedback} session={session} onEvidence={(turnId) => { setHighlight(turnId); navigate('record'); }} />
            {!!session.feedback.nextPractice.length && <section className="panel next-practice"><h2>下一次可以这样练</h2><ul>{session.feedback.nextPractice.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
          </>}
        {session.summary && <section className="panel teacher-card"><div className="section-heading"><h2>教师复核</h2><Badge>本机记录</Badge></div>{session.review ? <><div className="review-meta"><IonIcon icon={personOutline} /><strong>{session.review.reviewer}</strong><span>{formatTime(session.review.at)}</span></div><p className="pre-wrap">{session.review.notes}</p></> : <p>等待教师确认与补充。</p>}<button className="text-button" onClick={() => { setReviewer(session.review?.reviewer || ''); setReviewNotes(session.review?.notes || ''); setReviewOpen(true); }}>{session.review ? '更新复核备注' : '填写复核备注'}<IonIcon icon={arrowForwardOutline} /></button></section>}
        <ResearchSnapshotCard snapshot={session.research} />
        <AudioRecordings key={session.id} session={session} />
        <button className="primary-button full" onClick={() => navigate('record')}><IonIcon icon={documentTextOutline} />查看完整记录</button><div className="inline-actions spread"><button className="text-button" onClick={() => void exportSession()} disabled={Boolean(busy)}><IonIcon icon={downloadOutline} />导出 JSON</button><button className="text-button" onClick={() => navigate('cases')}>再练一个病例<IonIcon icon={arrowForwardOutline} /></button></div>
        {session.feedback && <p className="small-note">反馈生成于 {formatTime(session.feedback.createdAt)} · 模型 {session.feedback.model}</p>}
      </main>}
      {screen === 'history' && <main className="page-pad history-page">
        <div className="eyebrow">每一次练习，都可以回看</div><h1 className="page-title">训练记录</h1><p className="page-subtitle">已保存的问诊、总结与复核。</p><div className="section-heading"><h2>全部记录</h2><button className="text-button" onClick={() => void reload()} disabled={loading}><IonIcon icon={refreshOutline} />刷新</button></div>
        {loadError && <Notice tone="error">{loadError}</Notice>}
        {loading && !sessions.length ? <div className="loading-panel"><IonSpinner name="crescent" /><p>正在读取记录…</p></div> : !sessions.length ? <EmptyState title="从第一次问诊开始" action={<button className="primary-button full" onClick={() => navigate('cases')}>选择训练病例</button>}>你的训练记录将在这里保存。</EmptyState> : <div className="history-list">{sessions.map((value) => <button className="history-card" key={value.id} onClick={() => void openSession(value)} disabled={Boolean(busy)}><div className="history-icon"><IonIcon icon={documentTextOutline} /></div><div><strong>{value.caseTitle}</strong><span>{formatTime(value.createdAt)}</span>{value.research && <p className="history-research">{value.research.mode === 'research' ? '科研' : '练习'} · {value.research.participantCode || '未关联编号'} · {value.research.phase === 'baseline' ? '基线' : value.research.phase === 'post' ? '训练后' : value.research.phase === 'retention' ? '保持期' : '训练'}</p>}<div className="history-bottom"><Badge tone={value.status === 'reviewed' ? 'teal' : value.status === 'interview' ? 'neutral' : 'amber'}>{statusText[value.status]}</Badge><small>{value.turns.length} 条转录</small></div></div><IonIcon icon={chevronForwardOutline} /></button>)}</div>}
        <p className="small-note">训练与科研登记保存在当前手机。请定期导出备份。</p>
      </main>}
      {screen === 'record' && session && <main className="page-pad record-page">
        <Badge tone="teal">虚构病例 · 训练记录</Badge><h1 className="page-title">{session.caseTitle}</h1><div className="record-meta"><span>{formatTime(session.createdAt)}</span><Badge>{statusText[session.status]}</Badge></div><AudioRecordings key={session.id} session={session} />
        <ResearchSnapshotCard snapshot={session.research} />
        {session.runtime && <details className="runtime-snapshot panel"><summary>模型与版本快照</summary><dl><div><dt>文本模型</dt><dd>{session.runtime.text.company} · {session.runtime.text.model}</dd></div>{session.runtime.voice && <div><dt>语音模型</dt><dd>{session.runtime.voice.company} · {session.runtime.voice.model}</dd></div>}<div><dt>量规版本</dt><dd>{session.runtime.assessmentId} · {session.runtime.assessmentVersion}</dd></div><div><dt>App 版本</dt><dd>{session.runtime.appVersion}</dd></div><div><dt>引擎版本</dt><dd>{session.runtime.engineVersion}</dd></div></dl><p>开始时固定的配置快照，不含 API Key。</p></details>}
        <div className="section-heading"><h2>问诊原文</h2><span>{session.turns.length} 条转录</span></div><Transcript session={session} highlight={scrollReadyScreen === 'record' ? highlight : undefined} onClearHighlight={clearHighlight} />
        {session.summary && <><div className="section-heading"><h2>独立总结</h2><Badge tone="teal">已提交</Badge></div><SummaryRead summary={session.summary} /></>}
        {session.review && <section className="panel"><h2>本机教师复核</h2><div className="review-meta"><strong>{session.review.reviewer}</strong><span>{formatTime(session.review.at)}</span></div><p className="pre-wrap">{session.review.notes}</p></section>}
        <button className="secondary-button full" onClick={() => void exportSession()} disabled={Boolean(busy)}><IonIcon icon={downloadOutline} />导出本次完整 JSON</button>{session.summary && <button className="text-button centered" onClick={() => navigate('feedback')}>返回反馈复盘</button>}
      </main>}
      {screen === 'settings' && <ProviderSettings settings={settings} credentials={credentials}
        onSaveProfile={async (profile, key) => { await applyProviderSettings(await api.saveProfile(profile, key)); }}
        onDeleteProfile={async (id) => { await applyProviderSettings(await api.deleteProfile(id)); }}
        onSaveSelection={async (value) => { await applyProviderSettings(await saveSettings(value)); }}
        onProbe={async (value, capability) => api.probe(value, capability)} />}
      {screen === 'research' && <ResearchPanel studies={studies} participants={participants} selection={researchSelection} loading={researchLoading || researchSaving} ready={researchReady}
        onRefresh={reloadResearch} onSelection={applyResearchSelection} onSaveStudy={saveStudy} onSaveParticipant={saveParticipant}
        onDeleteParticipant={deleteParticipant} onExport={exportResearch} onImport={importResearch} />}
    </IonContent>
    {screen === 'case' && selectedCase && <footer className="case-start-footer"><button className="primary-button full" onClick={() => void startCase()} disabled={Boolean(busy) || !settingsReady || !researchReady || researchLoading || researchSaving}>{busy === 'start' ? <IonSpinner name="crescent" /> : <IonIcon icon={voiceProfile ? micOutline : documentTextOutline} />}{busy === 'start' ? '正在创建训练…' : !textProfile || !credentials[textProfile.id]?.hasKey ? '配置 API 后开始' : voiceProfile ? '开始语音问诊' : '开始文字问诊'}</button><p className="small-note">仅使用虚构病例，请勿输入真实患者身份信息。</p></footer>}
    {rootScreen && <nav className="bottom-nav" aria-label="主导航"><button className={screen === 'cases' ? 'active' : ''} aria-current={screen === 'cases' ? 'page' : undefined} onClick={() => navigate('cases')}><IonIcon icon={bookOutline} /><span>训练</span></button><button className={screen === 'history' ? 'active' : ''} aria-current={screen === 'history' ? 'page' : undefined} onClick={() => navigate('history')}><IonIcon icon={documentTextOutline} /><span>记录</span></button><button className={screen === 'research' ? 'active' : ''} aria-current={screen === 'research' ? 'page' : undefined} onClick={() => navigate('research')}><IonIcon icon={flaskOutline} /><span>科研</span></button><button className={screen === 'settings' ? 'active' : ''} aria-current={screen === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><IonIcon icon={settingsOutline} /><span>API</span></button></nav>}
    {confirm && <Modal title={confirm === 'finish' ? '结束本次问诊？' : '暂时离开问诊？'} onClose={() => setConfirm(null)}>
      <p>{confirm === 'finish' ? '请先停止说话，并检查最近的转录是否完整。结束后语音与麦克风将关闭，接下来请独立完成总结。' : '语音与麦克风将关闭，已确认的对话会保留，可从训练记录继续。'}</p>
      {confirm === 'finish' && (voice.speaking || session?.turns.some((turn) => !turn.final)) && <Notice>仍有说话活动或未确认转录。建议等待转录完成；此时结束可能留下未确认片段。</Notice>}
      <div className="dialog-actions"><button className="secondary-button" onClick={() => setConfirm(null)}>继续问诊</button><button className="primary-button" onClick={() => { if (confirm === 'finish') void finishInterview(); else { setConfirm(null); void closeVoice(); navigate('cases'); void reload(); } }}>{confirm === 'finish' ? '结束并写总结' : '保存并离开'}</button></div>
    </Modal>}
    {reviewOpen && <Modal title="本机教师复核" onClose={() => setReviewOpen(false)}><p className="dialog-intro">记录复核人和教学意见。此处为本机教学备注。</p><form onSubmit={(event) => void saveReview(event)}><div className="field"><label htmlFor="reviewer">复核人</label><input id="reviewer" value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="填写复核教师姓名" maxLength={100} required /></div><div className="field"><label htmlFor="review-notes">复核意见</label><textarea id="review-notes" rows={5} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="补充对问诊过程、判断依据和改进方向的意见。" maxLength={10000} required /></div><button className="primary-button full" type="submit" disabled={Boolean(busy) || !reviewer.trim() || !reviewNotes.trim()}>{busy === 'review' ? '正在保存…' : '保存复核记录'}</button></form></Modal>}
    {exportText && <Modal title="导出本次训练记录" onClose={() => { if (!busy) setExportText(''); }}><p className="dialog-intro">包含问诊原文、独立总结、反馈、科研快照与本机复核记录。密钥不进入导出文件。</p><label className="checkbox-row"><input type="checkbox" checked={exportAudio} onChange={(event) => setExportAudio(event.target.checked)} disabled={Boolean(busy) || !Capacitor.isNativePlatform()} /><span>ZIP 包含已保存的录音文件</span></label><div className="inline-actions"><button className="primary-button" onClick={() => void shareCurrentSession()} disabled={Boolean(busy)}>{busy === 'share' ? <IonSpinner name="crescent" /> : <IonIcon icon={downloadOutline} />}{Capacitor.isNativePlatform() ? '导出 ZIP 并分享' : '下载 JSON 备份'}</button><button className="secondary-button" onClick={() => void copyJson()} disabled={Boolean(busy)}>复制 JSON</button></div>{exportMessage && <p role="status" className="small-note">{exportMessage}</p>}<details className="export-preview"><summary>查看 JSON 内容</summary><label className="sr-only" htmlFor="export-json">导出的 JSON</label><textarea id="export-json" className="export-json" readOnly value={exportText} rows={10} onFocus={(event) => event.target.select()} /></details></Modal>}
  </IonPage></IonApp>;
}
export default App;

