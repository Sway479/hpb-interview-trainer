import { useEffect, useRef, useState, type FormEvent } from 'react';
import { IonIcon, IonSpinner } from '@ionic/react';
import { Capacitor } from '@capacitor/core';
import { addOutline, archiveOutline, chevronForwardOutline, cloudOfflineOutline, downloadOutline, flaskOutline, folderOpenOutline, pencilOutline, personOutline, refreshOutline, trashOutline } from 'ionicons/icons';
import type { Session } from './api';
import type { Participant, ResearchSelection, ResearchSnapshot, Study } from './platform/contracts';
import { Badge, EmptyState, Modal, Notice, formatTime } from './components';
import { researchErrorMessage, researchFieldLimits, validateParticipantForm, validateStudyForm } from './research-validation';
import './ResearchPanel.css';

export type ResearchSection = 'overview' | 'participants' | 'collection' | 'data';
export type StudyInput = Pick<Study, 'code' | 'title' | 'ethicsId'> & { id?: string };
export type ParticipantInput = Omit<Participant, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
interface Props {
  studies: Study[]; participants: Participant[]; selection: ResearchSelection; sessions?: Session[]; loading?: boolean; ready: boolean;
  initialSection?: ResearchSection; onViewRecords?: (studyId?: string) => void; onStartTraining?: () => void;
  onRefresh: () => Promise<void>;
  onSelection: (selection: ResearchSelection) => Promise<void>;
  onSaveStudy: (study: StudyInput) => Promise<void>;
  onSaveParticipant: (participant: ParticipantInput) => Promise<void>;
  onDeleteParticipant: (id: string) => Promise<void>;
  onExport: (options: { studyId?: string; includeAudio: boolean }) => Promise<string>;
  onImport: (json: string) => Promise<string>;
}
export const phaseNames: Record<ResearchSelection['phase'], string> = { baseline: '基线阶段', training: '训练阶段', post: '训练后阶段', retention: '随访阶段' };
const consentNames: Record<Participant['consent'], string> = { not_recorded: '未登记同意状态', recorded: '已人工登记同意', not_applicable: '按方案不适用' };
const sections: { id: ResearchSection; label: string }[] = [{ id: 'overview', label: '概览' }, { id: 'participants', label: '学员' }, { id: 'collection', label: '采集准备' }, { id: 'data', label: '数据' }];
const messageOf = researchErrorMessage;
const selectionKey = (value: ResearchSelection) => [value.mode, value.phase, value.mode === 'research' ? value.studyId || '' : '', value.mode === 'research' ? value.participantId || '' : ''].join('|');
export function ResearchContextCard({ selection, studies, participants, onEdit }: { selection: ResearchSelection; studies: Study[]; participants: Participant[]; onEdit?: () => void }) {
  const study = studies.find((item) => item.id === selection.studyId);
  const participant = participants.find((item) => item.id === selection.participantId);
  return <section className="research-context-card"><div><Badge tone={selection.mode === 'research' ? 'amber' : 'teal'} icon={flaskOutline}>{selection.mode === 'research' ? '研究用途记录' : '日常练习'}</Badge><Badge>{phaseNames[selection.phase]}</Badge></div>
    {selection.mode === 'research' ? <p><strong>{study?.code || '未选择项目'} · {participant?.code || '未选择学员编号'}</strong><span>{participant?.group ? '手工登记组别：' + participant.group : '未登记组别'} · {participant ? consentNames[participant.consent] : '请先完成学员登记'}</span></p> : <p><strong>本次作为日常练习</strong><span>本次不关联研究学员。</span></p>}
    {onEdit && <button className="text-button" onClick={onEdit}>更换下一次训练对象<IonIcon icon={chevronForwardOutline} /></button>}
  </section>;
}
export function ResearchSnapshotCard({ snapshot }: { snapshot?: ResearchSnapshot }) {
  if (!snapshot) return null;
  return <section className="panel research-snapshot"><div className="section-heading"><h2>开始时登记快照</h2><Badge tone={snapshot.mode === 'research' ? 'amber' : 'teal'}>{snapshot.mode === 'research' ? '项目记录' : '练习'} · {phaseNames[snapshot.phase]}</Badge></div>
    <dl><div><dt>项目</dt><dd>{snapshot.studyCode || '未关联'}{snapshot.studyTitle ? ' · ' + snapshot.studyTitle : ''}</dd></div><div><dt>学员编号</dt><dd>{snapshot.participantCode || '未关联'}</dd></div>{snapshot.group && <div><dt>登记组别</dt><dd>{snapshot.group}</dd></div>}{snapshot.trainingYear && <div><dt>培训年级</dt><dd>{snapshot.trainingYear}</dd></div>}{snapshot.rotationMonths !== undefined && <div><dt>轮转月数</dt><dd>{snapshot.rotationMonths}</dd></div>}{snapshot.consent && <div><dt>同意登记</dt><dd>{consentNames[snapshot.consent]}</dd></div>}<div><dt>训练序次</dt><dd>{snapshot.attemptIndex}</dd></div><div><dt>固定时间</dt><dd>{formatTime(snapshot.capturedAt)}</dd></div></dl><p>开始时固定；后续修改登记不改写本次快照。组别为人工登记。</p>
  </section>;
}
export function ResearchPanel({ studies, participants, selection, sessions, loading, ready, initialSection = 'overview', onViewRecords, onStartTraining, onRefresh, onSelection, onSaveStudy, onSaveParticipant, onDeleteParticipant, onExport, onImport }: Props) {
  const native = Capacitor.isNativePlatform();
  const [section, setSection] = useState<ResearchSection>(initialSection);
  const [studyId, setStudyId] = useState(selection.studyId || studies[0]?.id || '');
  const [selectionDraft, setSelectionDraft] = useState(selection);
  const [studyEditor, setStudyEditor] = useState<StudyInput | null>(null);
  const [participantEditor, setParticipantEditor] = useState<ParticipantInput | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Participant | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const [exportStudy, setExportStudy] = useState(studyId);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [importFile, setImportFile] = useState<{ name: string; content: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sectionStart = useRef<HTMLDivElement>(null);
  const selectionSaving = useRef(false);
  const savedSelectionKey = selectionKey(selection);
  const lastSavedSelectionKey = useRef(savedSelectionKey);
  useEffect(() => { setSection(initialSection); }, [initialSection]);
  useEffect(() => {
    // Registry refreshes return a new selection object. Preserve an unsaved draft
    // unless the actual saved purpose, phase or UUID relationship has changed.
    if (lastSavedSelectionKey.current !== savedSelectionKey) {
      lastSavedSelectionKey.current = savedSelectionKey;
      setSelectionDraft(selection);
    }
  }, [savedSelectionKey, selection]);
  useEffect(() => { if (!studies.some((study) => study.id === studyId)) setStudyId(studies.find((study) => study.id === selection.studyId)?.id || studies[0]?.id || ''); }, [studies, studyId, selection.studyId]);
  useEffect(() => { setExportStudy(studyId); }, [studyId]);
  const currentStudy = studies.find((study) => study.id === studyId);
  const currentParticipants = participants.filter((participant) => participant.studyId === studyId);
  const displayedParticipants = currentParticipants.filter((participant) => participant.code.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedParticipants = participants.filter((participant) => participant.studyId === selectionDraft.studyId);
  const projectRecords = sessions?.filter((item) => item.research?.mode === 'research' && item.research.studyId === studyId);
  const exportSessions = sessions?.filter((item) => !exportStudy || item.research?.studyId === exportStudy);
  const draftChanged = selectionKey(selectionDraft) !== selectionKey(selection);
  const draftStudy = studies.find((study) => study.id === selectionDraft.studyId);
  const draftParticipant = participants.find((participant) => participant.id === selectionDraft.participantId && participant.studyId === selectionDraft.studyId);
  const selectionBlocked = Boolean(busy) || Boolean(loading) || !ready;
  function openSection(next: ResearchSection) { setSection(next); setError(''); setMessage(''); sectionStart.current?.scrollIntoView({ block: 'start' }); }
  function editStudy() { if (currentStudy) { setStudyEditor({ id: currentStudy.id, code: currentStudy.code, title: currentStudy.title, ethicsId: currentStudy.ethicsId }); setError(''); } }
  function newParticipant() { if (studyId) { setParticipantEditor({ studyId, code: '', trainingYear: '', consent: 'not_recorded', group: '', note: '' }); setError(''); } }
  function prepareForParticipant(participant: Participant) { setSelectionDraft({ ...selectionDraft, mode: 'research', studyId: participant.studyId, participantId: participant.id }); openSection('collection'); }
  async function saveStudy(event: FormEvent) {
    event.preventDefault(); if (!studyEditor || busy) return;
    setMessage('');
    const validationError = validateStudyForm(studyEditor);
    if (validationError) { setError(validationError); return; }
    setBusy('study'); setError('');
    try { await onSaveStudy(studyEditor); setStudyEditor(null); setMessage('项目登记已保存到本机。'); }
    catch (cause) { setError(messageOf(cause, 'study')); } finally { setBusy(''); }
  }
  async function saveParticipant(event: FormEvent) {
    event.preventDefault(); if (!participantEditor || busy) return;
    setMessage('');
    const validationError = validateParticipantForm(participantEditor);
    if (validationError) { setError(validationError); return; }
    setBusy('participant'); setError('');
    try { await onSaveParticipant(participantEditor); setParticipantEditor(null); setMessage('学员编号登记已保存到本机。'); }
    catch (cause) { setError(messageOf(cause, 'participant')); } finally { setBusy(''); }
  }
  async function applySelection(event: FormEvent) {
    event.preventDefault(); if (busy || loading || !ready || selectionSaving.current) return; setMessage('');
    if (selectionDraft.mode === 'research' && (!selectionDraft.studyId || !selectionDraft.participantId)) { setError('关联项目记录需选择项目与学员编号。'); return; }
    if (selectionDraft.mode === 'research' && selectionDraft.participantId && !participants.some((participant) => participant.id === selectionDraft.participantId && participant.studyId === selectionDraft.studyId)) { setError('学员编号与所选项目不匹配，请重新选择。'); return; }
    const next = selectionDraft.mode === 'practice' ? { ...selectionDraft, studyId: undefined, participantId: undefined } : selectionDraft;
    selectionSaving.current = true; setBusy('selection'); setError('');
    try { await onSelection(next); setSelectionDraft(next); setMessage('已保存下一次训练设置；开始时固定项目、学员与时间点。'); }
    catch (cause) { setError(messageOf(cause)); } finally { selectionSaving.current = false; setBusy(''); }
  }
  async function removeParticipant() {
    if (!deleteTarget || busy) return; setBusy('delete'); setError('');
    try { await onDeleteParticipant(deleteTarget.id); setDeleteTarget(null); setMessage('未关联训练的登记已删除。'); }
    catch (cause) { setError(messageOf(cause)); } finally { setBusy(''); }
  }
  async function exportResearch() {
    if (busy) return; setBusy('export'); setError(''); setMessage('');
    try { setMessage(await onExport({ studyId: exportStudy || undefined, includeAudio })); }
    catch (cause) { setError(messageOf(cause)); } finally { setBusy(''); }
  }
  async function importResearch() {
    if (!importFile || busy) return; setBusy('import'); setError(''); setMessage('');
    try { setMessage(await onImport(importFile.content)); setImportFile(null); if (fileInput.current) fileInput.current.value = ''; }
    catch (cause) { setError(messageOf(cause)); } finally { setBusy(''); }
  }
  const editing = !!studyEditor || !!participantEditor || !!deleteTarget;
  return <main className="page-pad research-page research-workspace">
    <header className="rp-heading"><div><div className="rp-kicker">项目 · 学员 · 记录</div><h1>科研工作区</h1></div><span className="rp-local"><IonIcon icon={cloudOfflineOutline} />本机资料</span></header>
    <section className="rp-project-bar" aria-label="当前查看项目">
      <div className="field rp-project-select"><label htmlFor="research-view-study">当前查看项目</label><select id="research-view-study" value={studyId} disabled={Boolean(loading) || !studies.length || Boolean(busy)} onChange={(event) => { setStudyId(event.target.value); setQuery(''); }}>{!studies.length && <option value="">尚无项目</option>}{studies.map((study) => <option value={study.id} key={study.id}>{study.code} · {study.title}</option>)}</select></div>
      <div className="rp-project-actions"><button className="text-button" disabled={Boolean(busy)} onClick={() => { setStudyEditor({ code: '', title: '', ethicsId: '' }); setError(''); }}><IonIcon icon={addOutline} />新建项目</button>{currentStudy && <button className="text-button" disabled={Boolean(busy)} onClick={editStudy}><IonIcon icon={pencilOutline} />编辑项目</button>}</div>
      {currentStudy && <div className="rp-project-identity"><strong>{currentStudy.code}</strong><span>{currentStudy.title}</span></div>}
    </section>
    <div className="rp-section-start" ref={sectionStart} />
    <nav className="rp-tabs" role="tablist" aria-label="科研工作区分区">{sections.map((item) => <button type="button" role="tab" id={'research-tab-' + item.id} aria-selected={section === item.id} aria-controls={'research-section-' + item.id} key={item.id} disabled={Boolean(busy)} className={section === item.id ? 'active' : ''} onClick={() => openSection(item.id)}>{item.label}</button>)}</nav>
    {!editing && error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    <div id={'research-section-' + section} role="tabpanel" aria-labelledby={'research-tab-' + section} className="rp-content">
      {section === 'overview' && <>
        <div className="rp-section-title"><h2>项目概览</h2><button className="text-button" onClick={() => void onRefresh().catch((cause) => setError(messageOf(cause)))} disabled={Boolean(loading) || Boolean(busy)}><IonIcon icon={refreshOutline} />刷新</button></div>
        {loading && !studies.length ? <div className="loading-panel"><IonSpinner name="crescent" /><p>正在读取本机登记…</p></div> : !currentStudy ? <EmptyState icon={folderOpenOutline} title="先登记一个研究项目" action={<button className="primary-button full" onClick={() => { setStudyEditor({ code: '', title: '', ethicsId: '' }); setError(''); }}>新建项目</button>}>项目登记后，可按编号管理学员与训练记录。日常练习不需要项目。</EmptyState> : <>
          <div className="rp-metrics"><section><span>本项目登记学员</span><strong>{currentParticipants.length}<small>名</small></strong></section><section><span>关联项目的训练记录</span><strong>{projectRecords === undefined ? '—' : projectRecords.length}<small>条</small></strong></section></div><p className="rp-note">本机已登记数量，不代表有效样本或研究完成情况。</p>
          <div className="rp-project-meta"><span>{currentStudy.ethicsId ? '登记的伦理/备案编号：' + currentStudy.ethicsId : '尚未登记伦理/备案编号'}</span><span>最近修改 {formatTime(currentStudy.updatedAt)}</span></div>
        </>}
        <section className="rp-next"><div className="rp-section-title"><h2>下一次训练</h2><Badge tone="teal">当前设置</Badge></div><ResearchContextCard selection={selection} studies={studies} participants={participants} /><button className="primary-button full" onClick={() => openSection('collection')}>确认采集对象与用途<IonIcon icon={chevronForwardOutline} /></button></section>
        <div className="rp-task-grid"><button onClick={() => openSection('participants')} disabled={!currentStudy}><IonIcon icon={personOutline} /><strong>学员登记</strong><span>查找编号与人工标签</span></button>{onViewRecords && <button onClick={() => onViewRecords(studyId || undefined)}><IonIcon icon={folderOpenOutline} /><strong>查看记录</strong><span>问诊、总结与原始反馈</span></button>}<button onClick={() => openSection('data')}><IonIcon icon={downloadOutline} /><strong>导出与备份</strong><span>按项目整理本机资料</span></button></div>
        <details className="rp-details"><summary>登记与使用范围</summary><p>登记、旧记录和数据整理可离线使用；新问诊与自动反馈需要可用模型连接。编号、组别和同意状态由操作者登记，App不执行随机分配或核验伦理审批。自动分只作形成性参考。</p></details>
      </>}
      {section === 'participants' && <>
        <div className="rp-section-title"><h2>学员编号</h2><span>{currentParticipants.length} 名已登记</span></div>
        {!currentStudy ? <EmptyState title="尚未选择研究项目">请先新建或选择一个项目，再登记学员编号。</EmptyState> : <><div className="participant-toolbar"><label className="sr-only" htmlFor="participant-search">搜索学员编号</label><input id="participant-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目内编号" /><button className="secondary-button" disabled={Boolean(busy)} onClick={newParticipant}><IonIcon icon={addOutline} />登记学员</button></div>
          <p className="rp-note">使用项目内编号，不填写真实患者信息。组别与同意状态均为人工登记。</p>
          <div className="participant-list">{displayedParticipants.map((participant) => <section className="participant-card rp-participant" key={participant.id}><div className="rp-participant-main"><span className="participant-icon"><IonIcon icon={personOutline} /></span><div className="participant-info"><strong>{participant.code}</strong><p>{[participant.trainingYear, participant.rotationMonths === undefined ? '' : '轮转 ' + participant.rotationMonths + ' 月', participant.group ? '手工组别：' + participant.group : '未登记组别'].filter(Boolean).join(' · ')}</p><Badge tone={participant.consent === 'recorded' ? 'teal' : 'neutral'}>{consentNames[participant.consent]}</Badge></div></div><div className="rp-participant-footer"><button className="text-button" disabled={Boolean(busy)} onClick={() => prepareForParticipant(participant)}>用于下一次训练<IonIcon icon={chevronForwardOutline} /></button><div className="participant-actions"><button className="icon-button" disabled={Boolean(busy)} aria-label={'编辑学员 ' + participant.code} onClick={() => { setParticipantEditor({ ...participant }); setError(''); }}><IonIcon icon={pencilOutline} /></button><button className="icon-button danger-quiet" disabled={Boolean(busy)} aria-label={'删除学员 ' + participant.code} onClick={() => { setDeleteTarget(participant); setError(''); }}><IonIcon icon={trashOutline} /></button></div></div></section>)}</div>
          {!displayedParticipants.length && <p className="empty-inline">{query ? '没有匹配的学员编号，请调整搜索。' : '本项目尚未登记学员编号。'}</p>}
        </>}
      </>}
      {section === 'collection' && <>
        <div className="rp-section-title"><h2>下一次训练登记</h2><Badge tone={draftChanged ? 'amber' : 'teal'}>{draftChanged ? '草稿·未保存' : '与当前设置一致'}</Badge></div>
        <p className="rp-note">此处决定下一次训练属于哪个项目和学员；切换上方查看项目不会自动改变已保存设置。</p>
        <form noValidate onSubmit={(event) => void applySelection(event)}><section className="panel training-selection rp-collection-form"><div className="segmented"><button type="button" className={selectionDraft.mode === 'practice' ? 'selected' : ''} aria-pressed={selectionDraft.mode === 'practice'} disabled={selectionBlocked} onClick={() => setSelectionDraft({ ...selectionDraft, mode: 'practice' })}>日常练习</button><button type="button" className={selectionDraft.mode === 'research' ? 'selected' : ''} aria-pressed={selectionDraft.mode === 'research'} disabled={selectionBlocked} onClick={() => setSelectionDraft({ ...selectionDraft, mode: 'research' })}>研究用途记录</button></div>
          {selectionDraft.mode === 'research' && <><div className="field"><label htmlFor="binding-study">研究项目</label><select id="binding-study" disabled={selectionBlocked} value={selectionDraft.studyId || ''} onChange={(event) => setSelectionDraft({ ...selectionDraft, studyId: event.target.value || undefined, participantId: undefined })} required><option value="">请选择项目</option>{studies.map((study) => <option value={study.id} key={study.id}>{study.code} · {study.title}</option>)}</select>{currentStudy && currentStudy.id !== selectionDraft.studyId && <button type="button" className="text-button rp-use-current" disabled={selectionBlocked} onClick={() => setSelectionDraft({ ...selectionDraft, studyId: currentStudy.id, participantId: undefined })}>使用当前查看项目</button>}</div><div className="field"><label htmlFor="binding-participant">学员编号</label><select id="binding-participant" disabled={selectionBlocked} value={selectionDraft.participantId || ''} onChange={(event) => setSelectionDraft({ ...selectionDraft, participantId: event.target.value || undefined })} required><option value="">请选择学员编号</option>{selectedParticipants.map((participant) => <option value={participant.id} key={participant.id}>{participant.code}{participant.group ? ' · ' + participant.group : ''}</option>)}</select></div><div className="rp-draft-identity"><span>待保存对象</span><strong>{draftStudy?.code || '尚未选择项目'}</strong><strong>{draftParticipant?.code || '尚未选择学员编号'}</strong></div></>}
          <div className="field"><label htmlFor="binding-phase">App 训练标记</label><select id="binding-phase" disabled={selectionBlocked} value={selectionDraft.phase} onChange={(event) => setSelectionDraft({ ...selectionDraft, phase: event.target.value as ResearchSelection['phase'] })}>{Object.entries(phaseNames).map(([phase, name]) => <option key={phase} value={phase}>{name}</option>)}</select><p>仅标记本次App训练；真人SP研究考核另行实施。</p></div>
          <button className="primary-button full" type="submit" disabled={selectionBlocked}>{busy === 'selection' ? <IonSpinner name="crescent" /> : null}{busy === 'selection' ? '正在保存…' : '保存下一次训练设置'}</button>
        </section></form>
        <section className="rp-saved-selection"><h3>当前生效设置</h3><ResearchContextCard selection={selection} studies={studies} participants={participants} />{onStartTraining && <button className="secondary-button full" disabled={selectionBlocked || draftChanged} onClick={onStartTraining}>选择训练病例<IonIcon icon={chevronForwardOutline} /></button>}{draftChanged && <p className="rp-note">请先保存修改，再进入病例选择。</p>}</section>
        <details className="rp-details"><summary>登记、组别与快照如何保留</summary><p>组别按方案人工登记，App不随机分配或核验同意。训练开始时固定本次登记快照；之后修改项目或学员，不改写旧记录。新对话和自动反馈需网络及可用配置。</p></details>
      </>}
      {section === 'data' && <>
        <div className="rp-section-title"><h2>数据导出</h2><Badge>本机资料</Badge></div>
        <section className="panel research-export rp-data-card"><div className="field"><label htmlFor="export-study">导出范围</label><select id="export-study" value={exportStudy} disabled={Boolean(busy) || Boolean(loading)} onChange={(event) => setExportStudy(event.target.value)}><option value="">本机全部资料（含未关联练习）</option>{studies.map((study) => <option key={study.id} value={study.id}>{study.code} · {study.title}</option>)}</select></div><div className="rp-export-summary"><strong>{exportStudy ? studies.find((study) => study.id === exportStudy)?.code || '所选项目' : '本机全部登记与记录'}</strong><span>{exportSessions === undefined ? '按所选范围生成文件' : exportSessions.length + ' 条训练记录'} · {includeAudio ? '包含已保存录音' : '不含录音文件'}</span></div>
          <label className="checkbox-row"><input type="checkbox" checked={includeAudio} disabled={!native || Boolean(busy)} onChange={(event) => setIncludeAudio(event.target.checked)} /><span>包含已保存的录音<small>{native ? '原声可能识别说话者；按项目权限保管。' : '浏览器仅下载文字与元数据JSON。'}</small></span></label><button className="primary-button full" onClick={() => void exportResearch()} disabled={Boolean(busy) || Boolean(loading)}>{busy === 'export' ? <IonSpinner name="crescent" /> : <IonIcon icon={downloadOutline} />}{native ? '生成ZIP并打开分享' : '下载JSON备份'}</button><p className="rp-note">文件含编号、原文与时间戳，可关联登记。ZIP未加密，请保存到受控位置。</p>
          <details className="rp-details"><summary>导出内容与保存范围</summary><p>登记、会话、独立总结、原始反馈与人工备注按UUID关联。安卓ZIP包含CSV、精确backup.json及清单，可选已保存录音；Key不导出。默认范围为当前查看项目，选择本机全部资料时还包含未关联练习。打开分享面板不代表文件已发送或保存，请在接收位置核对。</p></details>
        </section>
        <section className="panel rp-import-card"><h3>合并导入JSON备份</h3><p>导入App导出的backup.json；相同记录跳过，冲突不覆盖。</p><label className="file-picker"><IonIcon icon={archiveOutline} /><span>{importFile?.name || '选择backup.json文件'}</span><input ref={fileInput} type="file" accept=".json,application/json" disabled={Boolean(busy)} onChange={(event) => { const file = event.target.files?.[0]; if (!file) { setImportFile(null); return; } setError(''); void file.text().then((content) => setImportFile({ name: file.name, content })).catch(() => setError('无法读取所选文件，请重新选择。')); }} /></label><button className="secondary-button full" onClick={() => void importResearch()} disabled={!importFile || Boolean(busy)}>{busy === 'import' ? <IonSpinner name="crescent" /> : <IonIcon icon={folderOpenOutline} />}校验并合并导入</button><p className="rp-note">不恢复API Key、录音WAV或下一次训练设置。</p><details className="rp-details"><summary>导入前需要知道</summary><p>请先从ZIP提取backup.json，不能直接导入ZIP。导入只合并文字与元数据，保留原记录及UUID；不同内容的同一UUID或编号冲突会拒绝导入，不自动覆盖。恢复后需重新确认下一次训练用途。</p></details></section>
      </>}
    </div>
    {studyEditor && <Modal title={studyEditor.id ? '编辑研究项目' : '新建研究项目'} onClose={() => { if (!busy) setStudyEditor(null); }}><form noValidate onSubmit={(event) => void saveStudy(event)}>{error && <Notice tone="error">{error}</Notice>}<div className="field"><label htmlFor="study-code">项目编号</label><input id="study-code" value={studyEditor.code} onChange={(event) => setStudyEditor({ ...studyEditor, code: event.target.value })} placeholder="如：HPB-EDU-2026" maxLength={researchFieldLimits.studyCode} aria-describedby="study-code-hint" required /><p id="study-code-hint">最多 {researchFieldLimits.studyCode} 个字符。</p></div><div className="field"><label htmlFor="study-title">项目名称</label><input id="study-title" value={studyEditor.title} onChange={(event) => setStudyEditor({ ...studyEditor, title: event.target.value })} maxLength={researchFieldLimits.studyTitle} required /></div><div className="field"><label htmlFor="study-ethics">伦理/备案编号（仅登记）</label><input id="study-ethics" value={studyEditor.ethicsId || ''} onChange={(event) => setStudyEditor({ ...studyEditor, ethicsId: event.target.value })} maxLength={researchFieldLimits.ethicsId} /><p>仅登记编号，App 不核验审批状态。</p></div><button className="primary-button full" type="submit" disabled={Boolean(busy)}>{busy === 'study' ? '正在保存…' : '保存项目登记'}</button></form></Modal>}
    {participantEditor && <Modal title={participantEditor.id ? '编辑学员登记' : '登记学员编号'} onClose={() => { if (!busy) setParticipantEditor(null); }}><form noValidate onSubmit={(event) => void saveParticipant(event)}>{error && <Notice tone="error">{error}</Notice>}<div className="field"><label htmlFor="participant-code">学员编号</label><input id="participant-code" value={participantEditor.code} onChange={(event) => setParticipantEditor({ ...participantEditor, code: event.target.value })} placeholder="使用项目内学员编号" maxLength={researchFieldLimits.participantCode} aria-describedby="participant-code-hint" required /><p id="participant-code-hint">最多 {researchFieldLimits.participantCode} 个字符；请勿填写姓名、身份证号或手机号。</p></div><div className="field"><label htmlFor="participant-year">培训年级（可选）</label><input id="participant-year" value={participantEditor.trainingYear || ''} onChange={(event) => setParticipantEditor({ ...participantEditor, trainingYear: event.target.value })} placeholder="如：住培 2 年级" maxLength={researchFieldLimits.trainingYear} /></div><div className="field"><label htmlFor="participant-months">相关轮转月数（可选）</label><input id="participant-months" type="number" inputMode="numeric" min={researchFieldLimits.rotationMonthsMin} max={researchFieldLimits.rotationMonthsMax} step="any" value={participantEditor.rotationMonths ?? ''} onChange={(event) => setParticipantEditor({ ...participantEditor, rotationMonths: event.target.value === '' ? undefined : Number(event.target.value) })} /></div><div className="field"><label htmlFor="participant-group">组别（按方案手工登记）</label><input id="participant-group" value={participantEditor.group || ''} onChange={(event) => setParticipantEditor({ ...participantEditor, group: event.target.value })} placeholder="如：A 组、常规教学组" maxLength={researchFieldLimits.group} /><p>此字段不执行或证明随机分配。</p></div><div className="field"><label htmlFor="participant-consent">同意状态（人工登记）</label><select id="participant-consent" value={participantEditor.consent} onChange={(event) => setParticipantEditor({ ...participantEditor, consent: event.target.value as Participant['consent'] })}>{Object.entries(consentNames).map(([consent, name]) => <option key={consent} value={consent}>{name}</option>)}</select></div><div className="field"><label htmlFor="participant-note">登记备注（可选）</label><textarea id="participant-note" rows={3} value={participantEditor.note || ''} onChange={(event) => setParticipantEditor({ ...participantEditor, note: event.target.value })} placeholder="仅记录与本项目有关的非身份信息" maxLength={researchFieldLimits.note} /></div><button className="primary-button full" type="submit" disabled={Boolean(busy)}>{busy === 'participant' ? '正在保存…' : '保存学员登记'}</button></form></Modal>}
    {deleteTarget && <Modal title="删除学员编号登记？" onClose={() => { if (!busy) setDeleteTarget(null); }}><p>仅未关联训练记录的登记可以删除。已有会话快照不会被修改。</p><p><strong>{deleteTarget.code}</strong></p>{error && <Notice tone="error">{error}</Notice>}<div className="dialog-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => setDeleteTarget(null)}>取消</button><button className="primary-button danger-button" onClick={() => void removeParticipant()} disabled={Boolean(busy)}>确认删除登记</button></div></Modal>}
  </main>;
}

