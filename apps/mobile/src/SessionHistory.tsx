import { useMemo } from 'react';
import { IonIcon, IonSpinner } from '@ionic/react';
import { chevronForwardOutline, documentTextOutline, refreshOutline } from 'ionicons/icons';
import type { Session, Study } from '../../../packages/core/src/types';
import { Badge, EmptyState, Notice, formatTime } from './components';
import { EMPTY_SESSION_FILTERS, SESSION_WORKFLOW_LABELS, filterSessions, getSessionWorkflow, sessionDateFilterError, sessionWorkflowLabel, summarizeWorkQueue, type SessionFilters, type SessionWorkflow } from './session-filters';
import './SessionHistory.css';

interface Props {
  sessions: Session[];
  studies: Study[];
  filters: SessionFilters;
  onFilters: (filters: SessionFilters) => void;
  onOpen: (session: Session) => void;
  onRefresh: () => void;
  onStartTraining: () => void;
  loading: boolean;
  error: string;
  busy: boolean;
}
const phaseLabels = { baseline: '基线阶段', training: '训练阶段', post: '训练后阶段', retention: '随访阶段' };
const workflows: SessionWorkflow[] = ['interview', 'summary', 'feedback', 'generating', 'review', 'reviewed'];

export function SessionHistory({ sessions, studies, filters, onFilters, onOpen, onRefresh, onStartTraining, loading, error, busy }: Props) {
  const visible = useMemo(() => filterSessions(sessions, filters), [sessions, filters]);
  const scope = useMemo(() => filterSessions(sessions, { ...filters, workflow: 'all', review: 'all' }), [sessions, filters]);
  const counts = useMemo(() => summarizeWorkQueue(scope), [scope]);
  const dateError = sessionDateFilterError(filters);
  const projectOptions = useMemo(() => Array.from(new Map([
    ...sessions.filter(value => value.research?.mode === 'research' && value.research.studyId).map(value => [value.research!.studyId!, { id: value.research!.studyId!, code: value.research!.studyCode || '历史项目', title: value.research!.studyTitle || '' }] as const),
    ...studies.map(value => [value.id, value] as const),
  ]).values()), [sessions, studies]);
  const caseOptions = useMemo(() => Array.from(new Map(sessions.map(value => [value.caseId, value.caseTitle])).entries()), [sessions]);
  const advancedCount = [filters.studyId, filters.review !== 'all', filters.caseId, filters.phase, filters.dateFrom, filters.dateTo].filter(Boolean).length;
  const activeFilters = filters.purpose !== 'all' || filters.workflow && filters.workflow !== 'all' || filters.query.trim() || advancedCount > 0;
  function update(value: Partial<SessionFilters>) { onFilters({ ...filters, ...value }); }
  function clear() { onFilters({ ...EMPTY_SESSION_FILTERS }); }

  return <main className="page-pad session-history">
    <h1 className="page-title">记录与待办</h1>
    <p className="page-subtitle">先处理未完成步骤，再按项目、学员和采集时间核对资料。</p>
    <section className="sh-work-queue" aria-label="记录处理步骤">
      <div className="sh-queue-heading"><h2>处理步骤</h2><span>当前检索范围 · 按记录计数</span></div>
      <div className="sh-queue-grid">{workflows.map(workflow => <button key={workflow} type="button" className={filters.workflow === workflow ? 'selected' : ''} aria-pressed={filters.workflow === workflow} aria-label={SESSION_WORKFLOW_LABELS[workflow] + ' ' + counts[workflow] + ' 条记录，筛选此步骤'} disabled={busy} onClick={() => update({ workflow: filters.workflow === workflow ? 'all' : workflow, review: 'all' })}>
        <strong>{counts[workflow]}</strong><span>{SESSION_WORKFLOW_LABELS[workflow]}</span>
      </button>)}</div>
      <p>计数保留用途、关键词和日期等范围，不受步骤或复核状态筛选限制。数量不代表独立学员数或能力达标。</p>
    </section>

    <section className="sh-filter-panel" aria-label="记录筛选">
      <div className="segmented" aria-label="记录用途">{(['all', 'research', 'practice'] as const).map(value => <button type="button" key={value} className={filters.purpose === value ? 'selected' : ''} aria-pressed={filters.purpose === value} disabled={busy} onClick={() => update({ purpose: value, studyId: value === 'practice' ? '' : filters.studyId })}>{value === 'all' ? '全部' : value === 'research' ? '研究用途' : '日常练习'}</button>)}</div>
      <div className="field"><label htmlFor="record-workflow">工作步骤</label><select id="record-workflow" value={filters.workflow || 'all'} disabled={busy} onChange={event => update({ workflow: event.target.value as SessionFilters['workflow'], review: 'all' })}><option value="all">全部步骤</option>{workflows.map(workflow => <option key={workflow} value={workflow}>{SESSION_WORKFLOW_LABELS[workflow]}</option>)}</select></div>
      <div className="field"><label htmlFor="record-search">学员编号或病例</label><input id="record-search" type="search" value={filters.query} disabled={busy} onChange={event => update({ query: event.target.value })} placeholder="检索编号、病例、项目或 UUID" /></div>
      <details className="sh-advanced"><summary>进阶筛选<span>{advancedCount ? '已启用 ' + advancedCount + ' 项' : '项目 / 病例 / 阶段 / 日期'}</span></summary><div className="sh-advanced-body">
        <div className="sh-filter-grid">
          <div className="field"><label htmlFor="record-project">研究项目</label><select id="record-project" value={filters.studyId} disabled={busy || filters.purpose === 'practice'} onChange={event => update({ studyId: event.target.value, purpose: event.target.value ? 'research' : filters.purpose })}><option value="">全部项目</option>{projectOptions.map(project => <option key={project.id} value={project.id}>{project.code} · {project.title}</option>)}</select></div>
          <div className="field"><label htmlFor="record-review">教师复核</label><select id="record-review" value={filters.review} disabled={busy} onChange={event => update({ review: event.target.value as SessionFilters['review'], workflow: 'all' })}><option value="all">全部复核状态</option><option value="pending">已有AI反馈，待复核</option><option value="reviewed">已有教师复核</option></select></div>
          <div className="field"><label htmlFor="record-case">病例</label><select id="record-case" value={filters.caseId || ''} disabled={busy} onChange={event => update({ caseId: event.target.value })}><option value="">全部病例</option>{caseOptions.map(([id, title]) => <option key={id} value={id}>{title} · {id}</option>)}</select></div>
          <div className="field"><label htmlFor="record-phase">App训练标记</label><select id="record-phase" value={filters.phase || ''} disabled={busy} onChange={event => update({ phase: event.target.value as SessionFilters['phase'] })}><option value="">全部阶段</option>{(Object.keys(phaseLabels) as (keyof typeof phaseLabels)[]).map(phase => <option key={phase} value={phase}>{phaseLabels[phase]}</option>)}</select></div>
          <div className="field"><label htmlFor="record-date-from">开始日期（含当日）</label><input id="record-date-from" type="date" value={filters.dateFrom || ''} disabled={busy} aria-invalid={Boolean(dateError)} aria-describedby="record-date-help" onChange={event => update({ dateFrom: event.target.value })} /></div>
          <div className="field"><label htmlFor="record-date-to">结束日期（含当日）</label><input id="record-date-to" type="date" value={filters.dateTo || ''} disabled={busy} aria-invalid={Boolean(dateError)} aria-describedby="record-date-help" onChange={event => update({ dateTo: event.target.value })} /></div>
        </div><p id="record-date-help" className="sh-filter-note">按本设备当地日期检索训练开始时间。阶段为App训练标记，不等同于正式研究访视或SP考核。</p>
      </div></details>
      {activeFilters && <p className="sh-filter-active" role="status">已应用检索条件{advancedCount ? '，其中进阶条件 ' + advancedCount + ' 项' : ''}。<button type="button" className="text-button" disabled={busy} onClick={clear}>清除全部筛选</button></p>}
    </section>
    {dateError && <Notice tone="error">{dateError}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <div className="sh-results-heading"><h2>{visible.length} 条记录</h2><div><button type="button" className="text-button" onClick={clear} disabled={busy}>清除筛选</button><button type="button" className="text-button" onClick={onRefresh} disabled={loading || busy}><IonIcon icon={refreshOutline} />{loading ? '读取中' : '刷新'}</button></div></div>
    {loading && !sessions.length ? <div className="loading-panel"><IonSpinner name="crescent" /><p>正在读取本机记录…</p></div> : !visible.length ? <EmptyState title={sessions.length ? '没有符合筛选的记录' : '本机尚无训练记录'} action={<button type="button" className="secondary-button" disabled={busy} onClick={sessions.length ? clear : onStartTraining}>{sessions.length ? '清除筛选' : '前往训练'}</button>}>{dateError ? '调整日期范围后重新检索。' : '记录按训练开始时固定的项目和学员快照检索。'}</EmptyState> : <div className="sh-record-list">{visible.map(value => <article className="sh-record" key={value.id}>
      <button type="button" className="sh-record-open" disabled={busy} onClick={() => onOpen(value)}>
        <IonIcon className="sh-record-icon" icon={documentTextOutline} aria-hidden="true" /><span className="sh-record-body">
          <span className="sh-record-meta"><Badge tone={value.research?.mode === 'research' ? 'amber' : 'neutral'}>{value.research?.mode === 'research' ? '研究用途' : '日常练习'}</Badge><time dateTime={value.createdAt}>{formatTime(value.createdAt)}</time></span>
          <strong>{value.caseTitle}</strong>
          {value.research?.mode === 'research' && <span className="sh-record-research">{value.research.participantCode || '未关联编号'} · {phaseLabels[value.research.phase]}<br />{value.research.studyCode || '历史项目'}</span>}
          {value.research?.mode === 'practice' && <span className="sh-record-research">{phaseLabels[value.research.phase]}</span>}
          <span className="sh-record-status"><Badge tone={getSessionWorkflow(value) === 'reviewed' ? 'teal' : 'neutral'}>{sessionWorkflowLabel(value)}</Badge><span>{value.turns.length} 条转录</span></span>
        </span><IonIcon className="sh-record-chevron" icon={chevronForwardOutline} aria-hidden="true" />
      </button>
      <details className="sh-record-identifiers"><summary>核对固定编号与 UUID</summary><dl><div><dt>会话 UUID</dt><dd>{value.id}</dd></div><div><dt>病例编号 / 版本</dt><dd>{value.caseId} / {value.caseVersion}</dd></div>{value.research?.studyId && <><div><dt>固定项目编号</dt><dd>{value.research.studyCode || '未记录'}</dd></div><div><dt>项目 UUID</dt><dd>{value.research.studyId}</dd></div></>}{value.research?.participantId && <><div><dt>固定学员编号</dt><dd>{value.research.participantCode || '未记录'}</dd></div><div><dt>学员 UUID</dt><dd>{value.research.participantId}</dd></div></>}</dl><p>开始时固定的快照，不随当前登记名称变更。</p></details>
    </article>)}</div>}
    <p className="sh-footer-note">本机记录与教师复核均需妥善保管。AI反馈为形成性草稿，处理步骤和条数不表示正式考核通过。</p>
  </main>;
}
