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
import type { ConnectionSettings, CredentialStatuses, ExportResult, Participant, ResearchSelection, Study, TeacherCorrection } from './platform/contracts';
import { DEFAULT_RESEARCH_SELECTION } from './platform/contracts';
import { loadResearchSelection, saveResearchSelection, validateResearchSelection } from './platform/research-selection';
import { listenForAndroidBackButton } from './platform/android-back';
import { HpbNative } from './platform/native-bridge';
import { ProviderSettings } from './ProviderSettings';
import { ResearchContextCard, ResearchPanel, ResearchSnapshotCard, phaseNames, type ResearchSection, type StudyInput, type ParticipantInput } from './ResearchPanel';
import { FeedbackSettings } from './FeedbackSettings';
import { DEFAULT_FEEDBACK_PREFERENCES, type FeedbackPreferences } from './platform/feedback-preferences';
import { EMPTY_SESSION_FILTERS, sessionWorkflowLabel, summarizeWorkQueue, type SessionFilters } from './session-filters';
import { SessionHistory } from './SessionHistory';
import { SummaryEditor } from './SummaryEditor';
import { TeacherReviewHistory } from './TeacherReviewHistory';
import { summaryValidation, hasReliableLearnerTranscript } from '../../../packages/core/src/summary-rules';
import { initialVoiceState, VoiceConnection, type VoiceState } from './audio';
import { FeedbackAssessment } from './FeedbackAssessment';
import { InterviewResultExplanation } from './InterviewResultExplanation';
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
  const [researchEntry, setResearchEntry] = useState<ResearchSection>('overview');
  const [settingsSection, setSettingsSection] = useState<'connection' | 'assessment'>('connection');
  const [recordFilters, setRecordFilters] = useState<SessionFilters>({ ...EMPTY_SESSION_FILTERS });
  const [feedbackPreferences, setFeedbackPreferences] = useState<FeedbackPreferences>({ ...DEFAULT_FEEDBACK_PREFERENCES });
  const [feedbackPreferencesReady, setFeedbackPreferencesReady] = useState(false);
  const [feedbackPreferencesWarning, setFeedbackPreferencesWarning] = useState('');
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
  const [dataWarnings, setDataWarnings] = useState<{ path: string; message: string; hasRecoveryText: boolean }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [voice, setVoice] = useState<VoiceState>({ ...initialVoiceState });
  const [text, setText] = useState('');
  const [summary, setSummary] = useState<LearnerSummary>({ ...emptySummary });
  const [draftSaved, setDraftSaved] = useState(false);
  const [draftReady, setDraftReady] = useState(true);
  const [draftError, setDraftError] = useState('');
  const [draftLoadFailed, setDraftLoadFailed] = useState(false);
  const [summaryDirty, setSummaryDirty] = useState(false);
  const [summaryLeaveTarget, setSummaryLeaveTarget] = useState<Screen | null>(null);
  const [reviewer, setReviewer] = useState('');
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewCorrections, setReviewCorrections] = useState<Record<string, { score: string; reason: string }>>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewDiscardConfirm, setReviewDiscardConfirm] = useState(false);
  const reviewInitial = useRef('');
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
    try { setDataWarnings(await api.dataWarnings()); }
    catch { setLoadError(previous => previous || '本机异常记录状态未能读取，请稍后刷新。'); }
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
  useEffect(() => {
    let active = true;
    void api.feedbackPreferences().then(({ preferences, warning }) => {
      if (active) { setFeedbackPreferences(preferences); setFeedbackPreferencesWarning(warning || ''); setFeedbackPreferencesReady(true); }
    }).catch(() => { if (active) { setFeedbackPreferences({ version: 1, practice: 'manual', research: 'manual' }); setFeedbackPreferencesWarning('评分偏好未能读取。本次先按手动生成，请到设置页核对后保存。'); setFeedbackPreferencesReady(true); } });
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
    setDraftReady(false); setDraftSaved(false); setDraftError(''); setDraftLoadFailed(false); setSummaryDirty(false);
    setSummary(session.summary || { ...emptySummary });
    if (session.summary) setDraftReady(true);
    else void api.getDraft(session.id).then((saved) => { if (active) { setSummary(saved || { ...emptySummary }); setDraftSaved(Boolean(saved)); setDraftReady(true); } }).catch((cause) => { if (active) { setDraftError('草稿读取失败：' + errorMessage(cause)); setDraftLoadFailed(true); void api.dataWarnings().then(setDataWarnings).catch(() => undefined); } });
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
  function navigate(next: Screen) {
    if (busy) return;
    if (session && !session.summary && summaryDirty && !draftSaved && next !== 'summary' && next !== 'record') { setSummaryLeaveTarget(next); return; }
    setError(''); setScreen(next);
  }
  async function saveDraftAndLeave() {
    if (!session || !summaryLeaveTarget || busy) return;
    const id = session.id, target = summaryLeaveTarget, value = { ...summary };
    setBusy('draft-leave'); setDraftError('');
    try { await draftQueue.current; await api.saveDraft(id, value); setDraftSaved(true); setSummaryDirty(false); setSummaryLeaveTarget(null); setError(''); setScreen(target); }
    catch (cause) { setDraftError('草稿尚未保存：' + errorMessage(cause)); }
    finally { setBusy(''); }
  }
  function openResearch(section: ResearchSection = 'overview') { setResearchEntry(section); navigate('research'); }
  function openAssessmentSettings() { setSettingsSection('assessment'); navigate('settings'); }
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
      openResearch('collection'); setError('上次训练绑定未能恢复，请重新设置训练用途；也可以明确选择练习模式并保存。'); return;
    }
    let selection: ResearchSelection;
    try { selection = validateResearchSelection(researchSelection, { studies, participants }); }
    catch (cause) { openResearch('collection'); setError(errorMessage(cause)); return; }
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
    if (busy) return;
    setBusy('open'); setError('');
    try {
      await closeVoice(); const latest = await api.session(settings, value.id); applySession(latest);
      setVoice({ ...initialVoiceState }); setText('');
      setScreen(latest.status === 'interview' ? 'interview' : latest.summary ? 'feedback' : latest.status === 'summary' ? 'summary' : 'feedback');
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
      applySession(updated); setVoice({ ...initialVoiceState }); setScreen(updated.summary ? 'feedback' : 'summary');
    } catch (cause) { setError('结束问诊未完成：' + errorMessage(cause)); }
    finally { await closeVoice(); setBusy(''); }
  }
  function editSummary(key: keyof LearnerSummary, value: string) {
    if (!draftReady || busy) return;
    const next = { ...summary, [key]: value }; setSummary(next); setSummaryDirty(true);
    if (session) {
      const id = session.id; const revision = ++draftRevision.current;
      setDraftSaved(false); setDraftError('');
      draftQueue.current = draftQueue.current.catch(() => undefined).then(() => api.saveDraft(id, next)).then(() => { if (sessionRef.current?.id === id && draftRevision.current === revision) { setDraftSaved(true); setDraftError(''); } }).catch((cause) => { if (sessionRef.current?.id === id && draftRevision.current === revision) { setDraftSaved(false); setDraftError('草稿尚未保存：' + errorMessage(cause)); } });
    }
  }
  async function retryDraftLoad() {
    if (!session || busy) return;
    const id = session.id; setDraftReady(false); setDraftLoadFailed(false); setDraftError('');
    try { const saved = await api.getDraft(id); if (sessionRef.current?.id === id) { setSummary(saved || { ...emptySummary }); setDraftSaved(!!saved); setDraftReady(true); } }
    catch (cause) { if (sessionRef.current?.id === id) { setDraftLoadFailed(true); setDraftError('草稿读取失败：' + errorMessage(cause)); } }
    finally { try { setDataWarnings(await api.dataWarnings()); } catch { /* Keep existing warning. */ } }
  }
  async function saveSummaryDraft() {
    if (!session || busy || !draftReady) return;
    const id = session.id, value = { ...summary }, revision = ++draftRevision.current;
    setDraftSaved(false); setDraftError('');
    draftQueue.current = draftQueue.current.catch(() => undefined).then(() => api.saveDraft(id, value)).then(() => { if (sessionRef.current?.id === id && draftRevision.current === revision) { setDraftSaved(true); setDraftError(''); } }).catch(cause => { if (sessionRef.current?.id === id && draftRevision.current === revision) setDraftError('草稿尚未保存：' + errorMessage(cause)); });
    await draftQueue.current;
  }
  async function submitSummary(saveOnly = false) {
    if (!session || busy || !draftReady) return;
    const issue = Object.values(summaryValidation(summary))[0];
    if (issue) { setError(issue); return; }
    setBusy('summary'); setError('');
    const mode = saveOnly || !hasReliableLearnerTranscript(session.turns) ? 'manual' : session.runtime?.feedbackGeneration || 'manual';
    try { await draftQueue.current; applySession(await api.summary(settings, session.id, summary, mode === 'manual' ? { generateFeedback: false } : undefined)); await api.saveDraft(session.id, null); setScreen('feedback'); }
    catch (cause) {
      const message = errorMessage(cause);
      try { const latest = await api.session(settings, session.id); applySession(latest); if (latest.summary) setScreen('feedback'); setError(message); }
      catch { setError(message); }
    } finally { setBusy(''); }
  }
  async function retryFeedback() {
    if (!session?.summary || busy || !hasReliableLearnerTranscript(session.turns)) return;
    setBusy('feedback'); setError('');
    try { applySession(await api.summary(settings, session.id, session.summary, { generateFeedback: true })); }
    catch (cause) { setError(errorMessage(cause)); try { applySession(await api.session(settings, session.id)); } catch { /* Keep confirmed data. */ } }
    finally { setBusy(''); }
  }
  async function saveReview(event: FormEvent) {
    event.preventDefault(); if (!session || !reviewer.trim() || !reviewNotes.trim() || busy) return;
    const corrections: TeacherCorrection[] = [];
    for (const [criterionId, correction] of Object.entries(reviewCorrections)) {
      if (!correction.score) continue;
      if (!correction.reason.trim()) { setError('请为每个教师修正分填写理由，原始AI评分将单独保留。'); return; }
      corrections.push({ criterionId, score: correction.score === 'null' ? null : Number(correction.score) as 0 | 1 | 2, reason: correction.reason.trim() });
    }
    if (reviewNotes.trim().length < 2) { setError('请填写至少2个字符的整体复核意见。'); return; }
    setBusy('review'); setError('');
    try { applySession(await api.review(settings, session.id, reviewer.trim(), reviewNotes.trim(), corrections)); setReviewOpen(false); setReviewDiscardConfirm(false); }
    catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  function openReview() {
    if (busy) return;
    const reviewer = session?.review?.reviewer || '', notes = session?.review?.notes || '';
    const corrections = Object.fromEntries((session?.review?.corrections || []).map(value => [value.criterionId, { score: value.score === null ? 'null' : String(value.score), reason: value.reason }]));
    setReviewer(reviewer); setReviewNotes(notes); setReviewCorrections(corrections);
    reviewInitial.current = JSON.stringify({ reviewer, notes, corrections }); setReviewDiscardConfirm(false);
    setReviewOpen(true);
  }
  function requestCloseReview() {
    if (busy) return;
    if (JSON.stringify({ reviewer, notes: reviewNotes, corrections: reviewCorrections }) !== reviewInitial.current) setReviewDiscardConfirm(true);
    else setReviewOpen(false);
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
      return result.fileName + ' · 已发起 JSON 备份下载。音频 ZIP 分享请在安卓 App 中使用。' + (result.recoveryNotice ? ' ' + result.recoveryNotice : '');
    }
    return result.fileName + ' · ' + (result.bytes / 1024).toFixed(1) + ' KB' + (result.shared ? ' · 已打开系统分享' : ' · 文件已生成') + (result.recoveryNotice ? ' · ' + result.recoveryNotice : '');
  }
  async function shareCurrentSession() {
    if (!session || busy) return;
    setBusy('share'); setExportMessage('');
    try { setExportMessage(exportResultMessage(await api.shareSession(session.id, { includeAudio: exportAudio }))); }
    catch (cause) { setExportMessage('导出未完成：' + errorMessage(cause)); }
    finally { setBusy(''); try { setDataWarnings(await api.dataWarnings()); } catch { /* Keep known warnings. */ } }
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
  async function exportResearch(options: { studyId?: string; includeAudio: boolean }) { try { return exportResultMessage(await api.researchExport(options)); } finally { try { setDataWarnings(await api.dataWarnings()); } catch { /* Keep known warnings. */ } } }
  async function importResearch(json: string) {
    const result = await api.importBackup(json);
    await Promise.all([reloadResearch(), reload()]);
    return '恢复完成：项目 ' + result.studies + '，学员 ' + result.participants + '，会话 ' + result.sessions + '，草稿 ' + result.drafts + '；跳过一致记录 ' + result.skipped + '。';
  }
  const clearHighlight = useCallback(() => setHighlight(''), []);
  const levels = ['全部', ...new Set(cases.map((value) => value.level))];
  const visibleCases = filter === '全部' ? cases : cases.filter((value) => value.level === filter);
  const unfinished = sessions.find((value) => value.status === 'interview' || value.status === 'summary');
  const workQueue = summarizeWorkQueue(sessions);
  const interview = screen === 'interview';
  const rootScreen = ['cases', 'history', 'settings', 'research'].includes(screen);
  const pageTitle: Record<Screen, string> = { cases: '问诊陪练', case: '训练准备', interview: '正在问诊', summary: '独立总结', feedback: '反馈复盘', history: '训练记录', record: '完整记录', settings: '设置', research: '科研工作区' };
  const textProfile = settings.profiles.find((profile) => profile.id === settings.textProfileId);
  const voiceProfile = settings.profiles.find((profile) => profile.id === settings.voiceProfileId);
  const voiceAvailable = session?.runtime ? Boolean(session.runtime.voice) : Boolean(voiceProfile);
  const seconds = session ? Math.max(0, Math.floor(((session.endedAt ? Date.parse(session.endedAt) : now) - Date.parse(session.createdAt)) / 1000)) : 0;
  const timer = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  const voiceLabel = voice.connection === 'ready' ? '实时连接已就绪' : voice.connection === 'connecting' ? '正在连接语音服务' : voice.connection === 'idle' ? '语音尚未连接' : '语音连接已断开';
  const activityLabel = voice.microphone === 'starting' ? '正在启用麦克风' : voice.microphone === 'muted' ? '麦克风已静音' : voice.microphone === 'error' ? '点击麦克风重试' : voice.outputLevel > 0.015 ? '患者正在回应' : voice.reasoning ? '正在组织患者回答' : voice.speaking ? '正在聆听你的提问' : voice.responding ? '正在准备语音回应' : voice.microphone === 'listening' ? '正在聆听，随时开口' : '连接后即可开始语音问诊';
  function back() {
    if (busy) return;
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
      {rootScreen ? <div className="wordmark"><IonIcon icon={pulseOutline} aria-hidden="true" /><span>肝胆胰问诊陪练<small>本机训练与研究记录</small></span></div> : <button className="icon-button" aria-label="返回" onClick={back} disabled={Boolean(busy)}><IonIcon icon={arrowBackOutline} /></button>}
      {!rootScreen && <h1>{pageTitle[screen]}</h1>}
      {screen === 'cases' ? <button className="icon-button" aria-label="API 配置" onClick={() => navigate('settings')}><IonIcon icon={settingsOutline} /></button> : interview ? <Badge>虚构患者</Badge> : <span className="header-spacer" />}
    </header>
    <IonContent ref={contentRef} className={'app-content ' + (interview ? 'interview-content' : '')}>
      {error && <div className="global-error"><Notice tone="error">{error}</Notice><button className="icon-button" aria-label="收起错误提示" onClick={() => setError('')}><IonIcon icon={closeOutline} /></button></div>}
      {feedbackPreferencesWarning && <div className="global-error"><Notice>{feedbackPreferencesWarning}<button className="text-button" onClick={openAssessmentSettings}>核对评分设置</button></Notice></div>}
      {researchWarning && <div className="global-error"><Notice>{researchWarning}</Notice><button className="icon-button" aria-label="收起登记提示" onClick={() => setResearchWarning('')}><IonIcon icon={closeOutline} /></button></div>}
      {!!dataWarnings.length && <details className="data-warning-panel"><summary>{dataWarnings.length} 份本机资料需核对，列表或备份可能不完整</summary><p>原文件保留。项目或单次导出不夹带无法确认归属的恢复原文；如需恢复，请在数据页选择“本机全部资料”。</p><ul>{dataWarnings.map(item => <li key={item.path}><code>{item.path}</code><span>{item.message}</span></li>)}</ul><button className="text-button" disabled={!!busy} onClick={() => openResearch('data')}>前往数据页</button></details>}
      {screen === 'cases' && <main className="page-pad cases-page">
        <div className="eyebrow">训练</div><h1 className="page-title">问诊训练</h1><p className="page-subtitle">先核对用途与学员，再选择虚构病例。</p><ResearchContextCard selection={researchSelection} studies={studies} participants={participants} onEdit={() => openResearch('collection')} />
        <div className="training-banner"><IonIcon icon={informationCircleOutline} aria-hidden="true" /><span>虚构病例 · 仅用于教学训练</span></div>
        <section className="home-work-queue" aria-label="训练待办"><h2>继续处理</h2><div>{(['summary','feedback','review'] as const).map(workflow => <button key={workflow} disabled={!!busy} onClick={() => { setRecordFilters({ ...EMPTY_SESSION_FILTERS, workflow }); navigate('history'); }}><strong>{workQueue[workflow]}</strong><span>{workflow === 'summary' ? '待写总结' : workflow === 'feedback' ? '待生成反馈' : '待教师复核'}</span></button>)}</div><p>本机会话条数，不代表学员人数或研究完成率。</p></section>
        {unfinished && !loading && <button className="resume-card" onClick={() => void openSession(unfinished)} disabled={Boolean(busy)}><span className="resume-icon"><IonIcon icon={playOutline} /></span><span className="resume-identity"><small>继续处理原记录</small><strong>{unfinished.caseTitle}</strong><small>{unfinished.research?.mode === 'research' ? [unfinished.research.studyCode || '历史项目', unfinished.research.participantCode || '历史学员', phaseNames[unfinished.research.phase]].join(' · ') : '日常练习'}</small><small>沿用原对象，不使用上方新训练设置</small></span><Badge tone="teal">{sessionWorkflowLabel(unfinished)}</Badge><IonIcon icon={chevronForwardOutline} /></button>}
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
        <p className="case-runtime-note">病例与反馈：<strong>{textProfile ? textProfile.name + ' · ' + textProfile.chatModel : '尚未配置'}</strong><br />语音：<strong>{voiceProfile ? voiceProfile.name + ' · ' + voiceProfile.realtimeModel : '未选择，本次使用文字问诊'}</strong><br />问诊内容将发送至所选 API，登记信息保存在本机。</p>
        <ResearchContextCard selection={researchSelection} studies={studies} participants={participants} onEdit={() => openResearch('collection')} />
        <div className="preparation-feedback"><strong>反馈生成：{!feedbackPreferencesReady ? '正在读取' : feedbackPreferences[researchSelection.mode] === 'manual' ? '提交总结后手动生成' : '提交总结后自动生成'}</strong><p>开始训练后固定本次方式。AI反馈仅作形成性参考。</p><button className="text-button" onClick={openAssessmentSettings}>查看评分设置</button></div>
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
          <form className="text-composer" onSubmit={(event) => void sendText(event)}><label className="sr-only" htmlFor="typed-message">文字补充</label><input id="typed-message" value={text} onChange={(event) => setText(event.target.value)} placeholder={voice.connection === 'ready' ? '也可以用文字补充…' : '语音未接通，可用文字问诊…'} maxLength={3000} disabled={Boolean(busy)} /><button className="send-button" type="submit" aria-label="发送文字" disabled={!text.trim() || Boolean(busy) || voice.connection === 'connecting'}>{busy === 'text' ? <IonSpinner name="crescent" /> : <IonIcon icon={sendOutline} />}</button></form>
          <p className="typed-limit">文字补充 {text.length} / 3000 字</p><button className="end-button" onClick={() => setConfirm('finish')} disabled={Boolean(busy)}>{busy === 'finish' ? '正在结束问诊…' : '结束问诊，撰写总结'}</button>
        </section>
      </main>}
      {screen === 'summary' && session && <SummaryEditor session={session} value={summary} ready={draftReady} saved={draftSaved} error={draftError} loadFailed={draftLoadFailed} busy={busy} onChange={editSummary} onSubmit={saveOnly => void submitSummary(saveOnly)} onSaveDraft={() => void saveSummaryDraft()} onRetryLoad={() => void retryDraftLoad()} onViewRecord={() => navigate('record')} />}
      {screen === 'feedback' && session && <main className="page-pad feedback-page">
        <div className="badge-row">{session.summary && <Badge tone="teal" icon={checkmarkCircle}>总结已提交</Badge>}<Badge tone={session.review ? 'teal' : 'amber'} icon={session.review ? shieldCheckmarkOutline : timeOutline}>{session.review ? '已有本机复核记录' : '待教师复核'}</Badge></div>
        <h1 className="page-title">反馈与教师复核</h1><p className="page-subtitle">AI形成性草稿，供训练复盘；不作为正式研究考核成绩。</p><div className="summary-case"><strong>{session.caseTitle}</strong><span>{formatTime(session.createdAt)}</span></div>
        {!hasReliableLearnerTranscript(session.turns) && <Notice>证据不足：本次没有可靠的学员问诊原文，只保留总结与记录；不生成AI反馈，也不能据此判断问诊能力。</Notice>}
        {!session.summary ? <EmptyState title="请先完成独立总结" action={<button className="primary-button full" onClick={() => navigate('summary')}>去写总结</button>}>先写下自己的判断，再生成本次复盘。</EmptyState>
          : !session.feedback ? <section className="panel feedback-pending"><span className="panel-symbol"><IonIcon icon={sparklesOutline} /></span><h2>{busy === 'feedback' ? '正在生成复盘' : '总结已保存，反馈尚未生成'}</h2><p>{session.feedbackError || (hasReliableLearnerTranscript(session.turns) ? '独立总结已锁定保存在本机。点击下方按钮才会调用模型生成AI反馈。' : '总结已锁定保存在本机。缺少可靠学员问诊原文，暂停AI反馈生成。')}</p><button className="primary-button full" onClick={() => void retryFeedback()} disabled={Boolean(busy) || !hasReliableLearnerTranscript(session.turns)}>{busy === 'feedback' ? <IonSpinner name="crescent" /> : <IonIcon icon={refreshOutline} />}{busy === 'feedback' ? '生成中…' : session.feedbackError ? '重试AI反馈（使用API）' : '生成AI反馈（使用API）'}</button></section>
          : <><InterviewResultExplanation session={session} onEvidence={(turnId) => { setHighlight(turnId); navigate('record'); }} />
            <FeedbackAssessment feedback={session.feedback} session={session} onEvidence={(turnId) => { setHighlight(turnId); navigate('record'); }} />
            <details className="panel original-feedback"><summary>查看原始反馈摘要与通用练习建议</summary><p>{session.feedback.overview}</p>{!!session.feedback.nextPractice.length && <><h3>原有建议（不等于已证实的不足）</h3><ul>{session.feedback.nextPractice.map((item, index) => <li key={index}>{item}</li>)}</ul></>}</details>
          </>}
        {session.summary && <section className="panel teacher-card"><div className="section-heading"><h2>教师复核</h2><Badge>本机记录</Badge></div>{session.review ? <><div className="review-meta"><IonIcon icon={personOutline} /><strong>{session.review.reviewer}</strong><span>{formatTime(session.review.at)}</span></div><p className="pre-wrap">{session.review.notes}</p></> : <p>{session.feedback ? '可逐项记录教师修正分与理由，AI原分单独保留。' : '生成AI反馈后可填写逐项复核；独立真人SP研究考核另行实施。'}</p>}<button className="text-button" onClick={openReview} disabled={!session.feedback}>{session.review ? '更新教师复核' : '填写教师复核'}<IonIcon icon={arrowForwardOutline} /></button></section>}
        <TeacherReviewHistory session={session} /><ResearchSnapshotCard snapshot={session.research} />
        <AudioRecordings key={session.id} session={session} />
        <button className="primary-button full" onClick={() => navigate('record')}><IonIcon icon={documentTextOutline} />查看完整记录</button><div className="inline-actions spread"><button className="text-button" onClick={() => void exportSession()} disabled={Boolean(busy)}><IonIcon icon={downloadOutline} />导出 JSON</button><button className="text-button" onClick={() => navigate('cases')}>再练一个病例<IonIcon icon={arrowForwardOutline} /></button></div>
        {session.feedback && <p className="small-note">反馈生成于 {formatTime(session.feedback.createdAt)} · 模型 {session.feedback.model}</p>}
      </main>}
      {screen === 'history' && <SessionHistory sessions={sessions} studies={studies} filters={recordFilters} onFilters={setRecordFilters} onOpen={value => void openSession(value)} onRefresh={() => void reload()} onStartTraining={() => navigate('cases')} loading={loading} error={loadError} busy={!!busy} />}
      {screen === 'record' && session && <main className="page-pad record-page">
        <Badge tone="teal">虚构病例 · 训练记录</Badge><h1 className="page-title">{session.caseTitle}</h1><div className="record-meta"><span>{formatTime(session.createdAt)}</span><Badge>{sessionWorkflowLabel(session)}</Badge></div><AudioRecordings key={session.id} session={session} />
        <TeacherReviewHistory session={session} /><ResearchSnapshotCard snapshot={session.research} />
        {session.runtime && <details className="runtime-snapshot panel"><summary>模型与版本快照</summary><dl><div><dt>文本模型</dt><dd>{session.runtime.text.company} · {session.runtime.text.model}</dd></div>{session.runtime.voice && <div><dt>语音模型</dt><dd>{session.runtime.voice.company} · {session.runtime.voice.model}</dd></div>}<div><dt>量规版本</dt><dd>{session.runtime.assessmentId} · {session.runtime.assessmentVersion}</dd></div><div><dt>反馈生成</dt><dd>{session.runtime.feedbackGeneration === 'automatic' ? '自动生成' : session.runtime.feedbackGeneration === 'manual' ? '手动生成' : '旧版未记录，按手动处理'}</dd></div><div><dt>App 版本</dt><dd>{session.runtime.appVersion}</dd></div><div><dt>引擎版本</dt><dd>{session.runtime.engineVersion}</dd></div></dl><p>开始时固定的配置快照，不含 API Key。</p></details>}
        <div className="section-heading"><h2>问诊原文</h2><span>{session.turns.length} 条转录</span></div><Transcript session={session} highlight={scrollReadyScreen === 'record' ? highlight : undefined} onClearHighlight={clearHighlight} />
        {session.summary && <><div className="section-heading"><h2>独立总结</h2><Badge tone="teal">已提交</Badge></div><SummaryRead summary={session.summary} /></>}
        {session.review && <section className="panel"><h2>本机教师复核</h2><div className="review-meta"><strong>{session.review.reviewer}</strong><span>{formatTime(session.review.at)}</span></div><p className="pre-wrap">{session.review.notes}</p></section>}
        <button className="secondary-button full" onClick={() => void exportSession()} disabled={Boolean(busy)}><IonIcon icon={downloadOutline} />导出本次完整 JSON</button>{session.summary && <button className="text-button centered" onClick={() => navigate('feedback')}>返回反馈复盘</button>}
      </main>}
      {screen === 'settings' && <><nav className="settings-sections" aria-label="设置分类"><button aria-pressed={settingsSection === 'connection'} onClick={() => setSettingsSection('connection')}>连接设置</button><button aria-pressed={settingsSection === 'assessment'} onClick={() => setSettingsSection('assessment')}>评分设置</button></nav>
      {settingsSection === 'assessment' ? <main className="page-pad"><h1 className="page-title">评分设置</h1><p className="page-subtitle">选择生成方式，核对固定量规；教师复核在每次反馈中完成。</p><FeedbackSettings preferences={feedbackPreferences} ready={feedbackPreferencesReady} onSave={async value => { setFeedbackPreferences(await api.saveFeedbackPreferences(value)); setFeedbackPreferencesWarning(''); }} /></main> : <ProviderSettings settings={settings} credentials={credentials}
        onSaveProfile={async (profile, key) => { await applyProviderSettings(await api.saveProfile(profile, key)); }}
        onDeleteProfile={async (id) => { await applyProviderSettings(await api.deleteProfile(id)); }}
        onSaveSelection={async (value) => { await applyProviderSettings(await saveSettings(value)); }}
        onProbe={async (value, capability) => api.probe(value, capability)} />}</>}
      {screen === 'research' && <ResearchPanel initialSection={researchEntry} sessions={sessions} onStartTraining={() => navigate('cases')} onViewRecords={studyId => { setRecordFilters({ ...EMPTY_SESSION_FILTERS, purpose: 'research', studyId: studyId || '' }); navigate('history'); }} studies={studies} participants={participants} selection={researchSelection} loading={researchLoading || researchSaving} ready={researchReady}
        onRefresh={reloadResearch} onSelection={applyResearchSelection} onSaveStudy={saveStudy} onSaveParticipant={saveParticipant}
        onDeleteParticipant={deleteParticipant} onExport={exportResearch} onImport={importResearch} />}
    </IonContent>
    {screen === 'case' && selectedCase && <footer className="case-start-footer"><button className="primary-button full" onClick={() => void startCase()} disabled={Boolean(busy) || !settingsReady || !feedbackPreferencesReady || !researchReady || researchLoading || researchSaving}>{busy === 'start' ? <IonSpinner name="crescent" /> : <IonIcon icon={voiceProfile ? micOutline : documentTextOutline} />}{busy === 'start' ? '正在创建训练…' : !textProfile || !credentials[textProfile.id]?.hasKey ? '配置 API 后开始' : voiceProfile ? '开始语音问诊' : '开始文字问诊'}</button><p className="small-note">仅使用虚构病例，请勿输入真实患者身份信息。</p></footer>}
    {rootScreen && <nav className="bottom-nav" aria-label="主导航"><button className={screen === 'cases' ? 'active' : ''} aria-current={screen === 'cases' ? 'page' : undefined} onClick={() => navigate('cases')}><IonIcon icon={bookOutline} /><span>训练</span></button><button className={screen === 'history' ? 'active' : ''} aria-current={screen === 'history' ? 'page' : undefined} onClick={() => navigate('history')}><IonIcon icon={documentTextOutline} /><span>记录</span></button><button className={screen === 'research' ? 'active' : ''} aria-current={screen === 'research' ? 'page' : undefined} onClick={() => openResearch()}><IonIcon icon={flaskOutline} /><span>科研</span></button><button className={screen === 'settings' ? 'active' : ''} aria-current={screen === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><IonIcon icon={settingsOutline} /><span>设置</span></button></nav>}
    {summaryLeaveTarget && <Modal title="总结尚未保存" onClose={() => { if (!busy) setSummaryLeaveTarget(null); }} busy={!!busy}><p>新输入还没有确认保存到本机。可先保存再离开；保存失败时会保留当前输入，方便重试。</p>{draftError && <Notice tone="error">{draftError}</Notice>}<div className="dialog-actions"><button className="secondary-button" disabled={!!busy} onClick={() => setSummaryLeaveTarget(null)}>继续编辑</button><button className="primary-button" disabled={!!busy} onClick={() => void saveDraftAndLeave()}>{busy === 'draft-leave' ? '正在保存…' : '保存草稿后离开'}</button></div><button className="text-button centered" disabled={!!busy} onClick={() => { if (busy) return; setSummaryDirty(false); setSummaryLeaveTarget(null); setScreen(summaryLeaveTarget); }}>放弃未保存输入并离开</button></Modal>}
    {confirm && <Modal title={confirm === 'finish' ? '结束本次问诊？' : '暂时离开问诊？'} onClose={() => setConfirm(null)}>
      <p>{confirm === 'finish' ? '请先停止说话，并检查最近的转录是否完整。结束后语音与麦克风将关闭，接下来请独立完成总结。' : '语音与麦克风将关闭，已确认的对话会保留，可从训练记录继续。'}</p>
      {confirm === 'finish' && (voice.speaking || session?.turns.some((turn) => !turn.final)) && <Notice>仍有说话活动或未确认转录。建议等待转录完成；此时结束可能留下未确认片段。</Notice>}
      <div className="dialog-actions"><button className="secondary-button" onClick={() => setConfirm(null)}>继续问诊</button><button className="primary-button" onClick={() => { if (confirm === 'finish') void finishInterview(); else { setConfirm(null); void closeVoice(); navigate('cases'); void reload(); } }}>{confirm === 'finish' ? '结束并写总结' : '保存并离开'}</button></div>
    </Modal>}
    {reviewOpen && <Modal title="教师复核" onClose={requestCloseReview} busy={!!busy}><p className="dialog-intro">独立保存教师判断和理由，保留AI原分与历次复核。此处为本机教学复核，不是真人SP正式考核。</p>{error && <Notice tone="error">{error}</Notice>}{reviewDiscardConfirm && <section className="review-discard-confirm" role="alert"><p>有尚未保存的教师复核。关闭将放弃本次编辑。</p><div className="dialog-actions"><button className="secondary-button" disabled={!!busy} onClick={() => setReviewDiscardConfirm(false)}>继续编辑</button><button className="secondary-button" disabled={!!busy} onClick={() => { if (busy) return; setReviewOpen(false); setReviewDiscardConfirm(false); }}>放弃未保存修改</button></div></section>}<form onSubmit={event => void saveReview(event)}><fieldset disabled={!!busy} className="review-fieldset"><div className="field"><label htmlFor="reviewer">教师编号或姓名</label><input id="reviewer" value={reviewer} onChange={event => setReviewer(event.target.value)} placeholder="填写可核对的复核教师标识" maxLength={100} required /></div>
      <details className="teacher-corrections" open><summary>逐项复核（保留AI原分）</summary>{session?.feedback?.items.map(item => <section className="teacher-correction" key={item.criterionId}><h3>{item.label}</h3><p>AI原分：{typeof item.score === 'number' ? item.score + ' / 2' : '未计分'}</p><div className="field"><label htmlFor={'correction-' + item.criterionId}>教师修正</label><select id={'correction-' + item.criterionId} value={reviewCorrections[item.criterionId]?.score || ''} onChange={event => setReviewCorrections({ ...reviewCorrections, [item.criterionId]: { reason: reviewCorrections[item.criterionId]?.reason || '', score: event.target.value } })}><option value="">不作分值修正</option><option value="2">2 · 充分实现</option><option value="1">1 · 部分实现</option><option value="0">0 · 有原文支持的明确不当行为</option><option value="null">未计分 · 证据不足/不适用/无法观察</option></select></div>{reviewCorrections[item.criterionId]?.score && <div className="field"><label htmlFor={'reason-' + item.criterionId}>修正理由与原文依据</label><textarea id={'reason-' + item.criterionId} value={reviewCorrections[item.criterionId]?.reason || ''} onChange={event => setReviewCorrections({ ...reviewCorrections, [item.criterionId]: { ...reviewCorrections[item.criterionId], reason: event.target.value } })} maxLength={1000} rows={3} required /></div>}</section>)}</details>
      <div className="field"><label htmlFor="review-notes">整体复核意见</label><textarea id="review-notes" rows={4} value={reviewNotes} onChange={event => setReviewNotes(event.target.value)} placeholder="记录证据分歧、判断依据与后续改进。" maxLength={6000} minLength={2} required /></div><button className="primary-button full" type="submit" disabled={Boolean(busy) || !reviewer.trim() || reviewNotes.trim().length < 2}>{busy === 'review' ? '正在保存…' : '保存教师复核'}</button></fieldset></form></Modal>}
    {exportText && <Modal title="导出本次训练记录" onClose={() => { if (!busy) setExportText(''); }} busy={!!busy}><p className="dialog-intro">包含问诊原文、独立总结、反馈、科研快照与本机复核记录。含编号、原文和时间戳，仍可关联登记；ZIP未加密，请保存到受控位置。密钥不进入导出文件。</p><label className="checkbox-row"><input type="checkbox" checked={exportAudio} onChange={(event) => setExportAudio(event.target.checked)} disabled={Boolean(busy) || !Capacitor.isNativePlatform()} /><span>ZIP 包含已保存的录音文件</span></label><div className="inline-actions"><button className="primary-button" onClick={() => void shareCurrentSession()} disabled={Boolean(busy)}>{busy === 'share' ? <IonSpinner name="crescent" /> : <IonIcon icon={downloadOutline} />}{Capacitor.isNativePlatform() ? '导出 ZIP 并分享' : '下载 JSON 备份'}</button><button className="secondary-button" onClick={() => void copyJson()} disabled={Boolean(busy)}>复制 JSON</button></div>{exportMessage && <p role="status" className="small-note">{exportMessage}</p>}<details className="export-preview"><summary>查看 JSON 内容</summary><label className="sr-only" htmlFor="export-json">导出的 JSON</label><textarea id="export-json" className="export-json" readOnly value={exportText} rows={10} onFocus={(event) => event.target.select()} /></details></Modal>}
  </IonPage></IonApp>;
}
export default App;

