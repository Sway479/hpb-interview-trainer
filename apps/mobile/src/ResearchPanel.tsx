import { useEffect, useRef, useState, type FormEvent } from 'react';
import { IonIcon, IonSpinner } from '@ionic/react';
import { Capacitor } from '@capacitor/core';
import { addOutline, archiveOutline, chevronForwardOutline, cloudOfflineOutline, downloadOutline, flaskOutline, folderOpenOutline, pencilOutline, personOutline, trashOutline } from 'ionicons/icons';
import type { Participant, ResearchSelection, ResearchSnapshot, Study } from './platform/contracts';
import { Badge, EmptyState, Modal, Notice, formatTime } from './components';
import { researchErrorMessage, researchFieldLimits, validateParticipantForm, validateStudyForm } from './research-validation';

export type StudyInput = Pick<Study, 'code' | 'title' | 'ethicsId'> & { id?: string };
export type ParticipantInput = Omit<Participant, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
interface Props {
  studies: Study[]; participants: Participant[]; selection: ResearchSelection; loading?: boolean; ready: boolean;
  onRefresh: () => Promise<void>;
  onSelection: (selection: ResearchSelection) => Promise<void>;
  onSaveStudy: (study: StudyInput) => Promise<void>;
  onSaveParticipant: (participant: ParticipantInput) => Promise<void>;
  onDeleteParticipant: (id: string) => Promise<void>;
  onExport: (options: { studyId?: string; includeAudio: boolean }) => Promise<string>;
  onImport: (json: string) => Promise<string>;
}
export const phaseNames: Record<ResearchSelection['phase'], string> = { baseline: '基线', training: '训练', post: '训练后', retention: '保持期' };
const consentNames: Record<Participant['consent'], string> = { not_recorded: '未登记同意状态', recorded: '已记录同意', not_applicable: '按方案不适用' };
const messageOf = researchErrorMessage;
export function ResearchContextCard({ selection, studies, participants, onEdit }: { selection: ResearchSelection; studies: Study[]; participants: Participant[]; onEdit?: () => void }) {
  const study = studies.find((item) => item.id === selection.studyId);
  const participant = participants.find((item) => item.id === selection.participantId);
  return <section className="research-context-card"><div><Badge tone={selection.mode === 'research' ? 'amber' : 'teal'} icon={flaskOutline}>{selection.mode === 'research' ? '科研模式' : '练习模式'}</Badge><Badge>{phaseNames[selection.phase]}</Badge></div>
    {selection.mode === 'research' ? <p><strong>{study?.code || '未选择项目'} · {participant?.code || '未选择学员编号'}</strong><span>{participant?.group ? '登记组别：' + participant.group : '未登记组别'} · {participant ? consentNames[participant.consent] : '请先完成科研登记'}</span></p> : <p><strong>本次作为日常练习</strong><span>不会自动归为科研样本。</span></p>}
    {onEdit && <button className="text-button" onClick={onEdit}>调整训练绑定<IonIcon icon={chevronForwardOutline} /></button>}
  </section>;
}
export function ResearchSnapshotCard({ snapshot }: { snapshot?: ResearchSnapshot }) {
  if (!snapshot) return null;
  return <section className="panel research-snapshot"><div className="section-heading"><h2>本次登记快照</h2><Badge tone={snapshot.mode === 'research' ? 'amber' : 'teal'}>{snapshot.mode === 'research' ? '科研' : '练习'} · {phaseNames[snapshot.phase]}</Badge></div>
    <dl><div><dt>项目</dt><dd>{snapshot.studyCode || '未关联'}{snapshot.studyTitle ? ' · ' + snapshot.studyTitle : ''}</dd></div><div><dt>学员编号</dt><dd>{snapshot.participantCode || '未关联'}</dd></div>{snapshot.group && <div><dt>登记组别</dt><dd>{snapshot.group}</dd></div>}{snapshot.trainingYear && <div><dt>培训年级</dt><dd>{snapshot.trainingYear}</dd></div>}{snapshot.rotationMonths !== undefined && <div><dt>轮转月数</dt><dd>{snapshot.rotationMonths}</dd></div>}{snapshot.consent && <div><dt>同意登记</dt><dd>{consentNames[snapshot.consent]}</dd></div>}<div><dt>训练序次</dt><dd>{snapshot.attemptIndex}</dd></div><div><dt>固定时间</dt><dd>{formatTime(snapshot.capturedAt)}</dd></div></dl><p>训练开始时固定；后续修改登记不会改写本次快照。组别为人工登记。</p>
  </section>;
}
export function ResearchPanel({ studies, participants, selection, loading, ready, onRefresh, onSelection, onSaveStudy, onSaveParticipant, onDeleteParticipant, onExport, onImport }: Props) {
  const native = Capacitor.isNativePlatform();
  const [studyId, setStudyId] = useState(selection.studyId || studies[0]?.id || '');
  const [selectionDraft, setSelectionDraft] = useState(selection);
  const [studyEditor, setStudyEditor] = useState<StudyInput | null>(null);
  const [participantEditor, setParticipantEditor] = useState<ParticipantInput | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Participant | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const [exportStudy, setExportStudy] = useState('');
  const [includeAudio, setIncludeAudio] = useState(false);
  const [importFile, setImportFile] = useState<{ name: string; content: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const selectionSaving = useRef(false);
  useEffect(() => { setSelectionDraft(selection); }, [selection]);
  useEffect(() => { if (!studies.some((study) => study.id === studyId)) setStudyId(studies[0]?.id || ''); }, [studies, studyId]);
  const currentStudy = studies.find((study) => study.id === studyId);
  const displayedParticipants = participants.filter((participant) => participant.studyId === studyId && participant.code.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedParticipants = participants.filter((participant) => participant.studyId === selectionDraft.studyId);
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
    if (selectionDraft.mode === 'research' && (!selectionDraft.studyId || !selectionDraft.participantId)) { setError('科研模式需选择项目与学员编号。'); return; }
    if (selectionDraft.mode === 'research' && selectionDraft.participantId && !participants.some((participant) => participant.id === selectionDraft.participantId && participant.studyId === selectionDraft.studyId)) { setError('学员编号与所选项目不匹配，请重新选择。'); return; }
    const next = selectionDraft.mode === 'practice' ? { ...selectionDraft, studyId: undefined, participantId: undefined } : selectionDraft;
    selectionSaving.current = true; setBusy('selection'); setError('');
    try { await onSelection(next); setMessage('已设置下次训练绑定；新训练开始时固定快照。'); }
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
  return <main className="page-pad research-page">
    <div className="eyebrow">登记、关联与数据导出</div><h1 className="page-title">科研登记</h1><p className="page-subtitle">使用学员编号，不需要姓名。</p>
    {!editing && error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    <div className="research-offline-note"><IonIcon icon={cloudOfflineOutline} /><span>登记与旧记录可离线使用；新对话和自动评价需要网络。</span></div>
    <div className="section-heading"><h2>研究项目</h2><button className="text-button" onClick={() => { setStudyEditor({ code: '', title: '', ethicsId: '' }); setError(''); }}><IonIcon icon={addOutline} />新建项目</button></div>
    {loading && !studies.length ? <div className="loading-panel"><IonSpinner name="crescent" /><p>正在读取本机登记…</p></div> : !studies.length ? <EmptyState icon={folderOpenOutline} title="先登记一个研究项目">也可以继续使用练习模式，登记完成后再关联科研训练。</EmptyState> : <div className="study-list">{studies.map((study) => <button key={study.id} className={'study-card ' + (studyId === study.id ? 'selected' : '')} onClick={() => { setStudyId(study.id); setQuery(''); }} aria-pressed={studyId === study.id}><span className="study-code">{study.code}</span><strong>{study.title}</strong><small>{study.ethicsId ? '伦理/备案编号：' + study.ethicsId : '尚未登记伦理/备案编号'}</small></button>)}</div>}
    {currentStudy && <><div className="section-heading"><h2>学员编号</h2><button className="text-button" onClick={() => { setStudyEditor({ id: currentStudy.id, code: currentStudy.code, title: currentStudy.title, ethicsId: currentStudy.ethicsId }); setError(''); }}><IonIcon icon={pencilOutline} />编辑项目</button></div>
      <div className="participant-toolbar"><label className="sr-only" htmlFor="participant-search">搜索学员编号</label><input id="participant-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索学员编号" /><button className="secondary-button" onClick={() => { setParticipantEditor({ studyId, code: '', trainingYear: '', consent: 'not_recorded', group: '', note: '' }); setError(''); }}><IonIcon icon={addOutline} />登记学员</button></div>
      <div className="participant-list">{displayedParticipants.map((participant) => <section className="participant-card" key={participant.id}><span className="participant-icon"><IonIcon icon={personOutline} /></span><div className="participant-info"><strong>{participant.code}</strong><p>{[participant.trainingYear, participant.rotationMonths === undefined ? '' : '轮转 ' + participant.rotationMonths + ' 月', participant.group ? '组别：' + participant.group : '未登记组别'].filter(Boolean).join(' · ')}</p><Badge tone={participant.consent === 'recorded' ? 'teal' : 'neutral'}>{consentNames[participant.consent]}</Badge></div><div className="participant-actions"><button className="icon-button" aria-label={'编辑学员 ' + participant.code} onClick={() => { setParticipantEditor({ ...participant }); setError(''); }}><IonIcon icon={pencilOutline} /></button><button className="icon-button danger-quiet" aria-label={'删除学员 ' + participant.code} onClick={() => { setDeleteTarget(participant); setError(''); }}><IonIcon icon={trashOutline} /></button></div></section>)}</div>
      {!displayedParticipants.length && <p className="empty-inline">{query ? '没有匹配的学员编号。' : '本项目尚未登记学员编号。'}</p>}
    </>}
    <form noValidate onSubmit={(event) => void applySelection(event)}><section className="panel training-selection"><h2>下次训练如何登记</h2><div className="segmented"><button type="button" className={selectionDraft.mode === 'practice' ? 'selected' : ''} aria-pressed={selectionDraft.mode === 'practice'} disabled={Boolean(busy) || loading || !ready} onClick={() => setSelectionDraft({ ...selectionDraft, mode: 'practice' })}>练习模式</button><button type="button" className={selectionDraft.mode === 'research' ? 'selected' : ''} aria-pressed={selectionDraft.mode === 'research'} disabled={Boolean(busy) || loading || !ready} onClick={() => setSelectionDraft({ ...selectionDraft, mode: 'research' })}>科研模式</button></div>
      {selectionDraft.mode === 'research' && <><div className="field"><label htmlFor="binding-study">研究项目</label><select id="binding-study" disabled={Boolean(busy) || loading || !ready} value={selectionDraft.studyId || ''} onChange={(event) => setSelectionDraft({ ...selectionDraft, studyId: event.target.value || undefined, participantId: undefined })} required><option value="">请选择项目</option>{studies.map((study) => <option value={study.id} key={study.id}>{study.code} · {study.title}</option>)}</select></div><div className="field"><label htmlFor="binding-participant">学员编号</label><select id="binding-participant" disabled={Boolean(busy) || loading || !ready} value={selectionDraft.participantId || ''} onChange={(event) => setSelectionDraft({ ...selectionDraft, participantId: event.target.value || undefined })} required><option value="">请选择学员编号</option>{selectedParticipants.map((participant) => <option value={participant.id} key={participant.id}>{participant.code}{participant.group ? ' · ' + participant.group : ''}</option>)}</select></div></>}
      <div className="field"><label htmlFor="binding-phase">训练时间点</label><select id="binding-phase" disabled={Boolean(busy) || loading || !ready} value={selectionDraft.phase} onChange={(event) => setSelectionDraft({ ...selectionDraft, phase: event.target.value as ResearchSelection['phase'] })}>{Object.entries(phaseNames).map(([phase, name]) => <option key={phase} value={phase}>{name}</option>)}</select></div>
      <p className="field-note">组别按实际方案手工登记，不代表 App 已随机分配。训练开始后保留当时快照。</p><button className="primary-button full" type="submit" disabled={Boolean(busy) || loading || !ready}>{busy === 'selection' ? '正在保存…' : '设置下次训练'}</button>
    </section></form>
    <ResearchContextCard selection={selection} studies={studies} participants={participants} />
    <section className="panel research-export"><h2>备份与科研导出</h2><p>导出登记、会话、独立总结、评分依据与教师备注；密钥不进入导出文件。</p><div className="field"><label htmlFor="export-study">导出范围</label><select id="export-study" value={exportStudy} onChange={(event) => setExportStudy(event.target.value)}><option value="">全部研究项目</option>{studies.map((study) => <option key={study.id} value={study.id}>{study.code} · {study.title}</option>)}</select></div><label className="checkbox-row"><input type="checkbox" checked={includeAudio} disabled={!native} onChange={(event) => setIncludeAudio(event.target.checked)} /><span>包含已保存的录音文件<small>{native ? '文件可能较大，请按项目数据管理要求保存。' : '浏览器下载 JSON 备份；录音 ZIP 分享请在安卓 App 使用。'}</small></span></label><button className="primary-button full" onClick={() => void exportResearch()} disabled={Boolean(busy)}>{busy === 'export' ? <IonSpinner name="crescent" /> : <IonIcon icon={downloadOutline} />}{native ? '导出科研 ZIP 并分享' : '下载 JSON 预览备份'}</button>
      <div className="import-divider"><h3>从 JSON 备份恢复</h3><p>导入时检查格式与重复记录，不恢复 API Key。</p><label className="file-picker"><IonIcon icon={archiveOutline} /><span>{importFile?.name || '选择 JSON 备份文件'}</span><input ref={fileInput} type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (!file) { setImportFile(null); return; } setError(''); void file.text().then((content) => setImportFile({ name: file.name, content })).catch(() => setError('无法读取所选文件，请重新选择。')); }} /></label><button className="secondary-button full" onClick={() => void importResearch()} disabled={!importFile || Boolean(busy)}>{busy === 'import' ? <IonSpinner name="crescent" /> : <IonIcon icon={folderOpenOutline} />}校验并恢复 JSON 备份</button></div>
    </section>
    <button className="text-button centered" onClick={() => void onRefresh().catch((cause) => setError(messageOf(cause)))} disabled={loading}>刷新本机登记</button>
    {studyEditor && <Modal title={studyEditor.id ? '编辑研究项目' : '新建研究项目'} onClose={() => setStudyEditor(null)}><form noValidate onSubmit={(event) => void saveStudy(event)}>{error && <Notice tone="error">{error}</Notice>}<div className="field"><label htmlFor="study-code">项目编号</label><input id="study-code" value={studyEditor.code} onChange={(event) => setStudyEditor({ ...studyEditor, code: event.target.value })} placeholder="如：HPB-EDU-2026" maxLength={researchFieldLimits.studyCode} aria-describedby="study-code-hint" required /><p id="study-code-hint">最多 {researchFieldLimits.studyCode} 个字符。</p></div><div className="field"><label htmlFor="study-title">项目名称</label><input id="study-title" value={studyEditor.title} onChange={(event) => setStudyEditor({ ...studyEditor, title: event.target.value })} maxLength={researchFieldLimits.studyTitle} required /></div><div className="field"><label htmlFor="study-ethics">伦理批件或备案编号（如有）</label><input id="study-ethics" value={studyEditor.ethicsId || ''} onChange={(event) => setStudyEditor({ ...studyEditor, ethicsId: event.target.value })} maxLength={researchFieldLimits.ethicsId} /><p>仅登记编号，App 不核验审批状态。</p></div><button className="primary-button full" type="submit" disabled={Boolean(busy)}>{busy === 'study' ? '正在保存…' : '保存项目登记'}</button></form></Modal>}
    {participantEditor && <Modal title={participantEditor.id ? '编辑学员登记' : '登记学员编号'} onClose={() => setParticipantEditor(null)}><form noValidate onSubmit={(event) => void saveParticipant(event)}>{error && <Notice tone="error">{error}</Notice>}<div className="field"><label htmlFor="participant-code">学员编号</label><input id="participant-code" value={participantEditor.code} onChange={(event) => setParticipantEditor({ ...participantEditor, code: event.target.value })} placeholder="使用项目内的匿名编号" maxLength={researchFieldLimits.participantCode} aria-describedby="participant-code-hint" required /><p id="participant-code-hint">最多 {researchFieldLimits.participantCode} 个字符；请勿填写姓名、身份证号或手机号。</p></div><div className="field"><label htmlFor="participant-year">培训年级（可选）</label><input id="participant-year" value={participantEditor.trainingYear || ''} onChange={(event) => setParticipantEditor({ ...participantEditor, trainingYear: event.target.value })} placeholder="如：住培 2 年级" maxLength={researchFieldLimits.trainingYear} /></div><div className="field"><label htmlFor="participant-months">相关轮转月数（可选）</label><input id="participant-months" type="number" inputMode="numeric" min={researchFieldLimits.rotationMonthsMin} max={researchFieldLimits.rotationMonthsMax} step="any" value={participantEditor.rotationMonths ?? ''} onChange={(event) => setParticipantEditor({ ...participantEditor, rotationMonths: event.target.value === '' ? undefined : Number(event.target.value) })} /></div><div className="field"><label htmlFor="participant-group">组别（按方案手工登记）</label><input id="participant-group" value={participantEditor.group || ''} onChange={(event) => setParticipantEditor({ ...participantEditor, group: event.target.value })} placeholder="如：A 组、常规教学组" maxLength={researchFieldLimits.group} /><p>此字段不执行或证明随机分配。</p></div><div className="field"><label htmlFor="participant-consent">同意状态登记</label><select id="participant-consent" value={participantEditor.consent} onChange={(event) => setParticipantEditor({ ...participantEditor, consent: event.target.value as Participant['consent'] })}>{Object.entries(consentNames).map(([consent, name]) => <option key={consent} value={consent}>{name}</option>)}</select></div><div className="field"><label htmlFor="participant-note">登记备注（可选）</label><textarea id="participant-note" rows={3} value={participantEditor.note || ''} onChange={(event) => setParticipantEditor({ ...participantEditor, note: event.target.value })} placeholder="仅记录与本项目有关的非身份信息" maxLength={researchFieldLimits.note} /></div><button className="primary-button full" type="submit" disabled={Boolean(busy)}>{busy === 'participant' ? '正在保存…' : '保存学员登记'}</button></form></Modal>}
    {deleteTarget && <Modal title="删除学员编号登记？" onClose={() => setDeleteTarget(null)}><p>仅未关联训练记录的登记可以删除。已有会话快照不会被修改。</p><p><strong>{deleteTarget.code}</strong></p>{error && <Notice tone="error">{error}</Notice>}<div className="dialog-actions"><button className="secondary-button" onClick={() => setDeleteTarget(null)}>取消</button><button className="primary-button danger-button" onClick={() => void removeParticipant()} disabled={Boolean(busy)}>确认删除登记</button></div></Modal>}
  </main>;
}

