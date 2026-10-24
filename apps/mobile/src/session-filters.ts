import type { Session } from '../../../packages/core/src/types.js';

export interface SessionFilters {
  purpose: 'all' | 'practice' | 'research';
  studyId: string;
  query: string;
  review: 'all' | 'pending' | 'reviewed';
  workflow?: 'all' | 'interview' | 'summary' | 'feedback' | 'generating' | 'review' | 'reviewed';
  phase?: '' | 'baseline' | 'training' | 'post' | 'retention';
  caseId?: string;
  dateFrom?: string;
  dateTo?: string;
}
export type SessionWorkflow = Exclude<NonNullable<SessionFilters['workflow']>, 'all'>;
export const EMPTY_SESSION_FILTERS: SessionFilters = { purpose: 'all', studyId: '', query: '', review: 'all', workflow: 'all', phase: '', caseId: '', dateFrom: '', dateTo: '' };
export const SESSION_WORKFLOW_LABELS: Record<SessionWorkflow, string> = {
  interview: '问诊进行中', summary: '待写总结', feedback: '待生成AI反馈', generating: 'AI反馈生成中', review: '待教师复核', reviewed: '已有教师复核',
};

export function getSessionWorkflow(session: Session): SessionWorkflow {
  if (session.status === 'feedback_pending') return 'generating';
  if (session.review) return 'reviewed';
  if (session.feedback) return 'review';
  if (session.status === 'interview') return 'interview';
  return session.summary ? 'feedback' : 'summary';
}
export function sessionWorkflowLabel(session: Session): string { return SESSION_WORKFLOW_LABELS[getSessionWorkflow(session)]; }
export function summarizeWorkQueue(sessions: Session[]): Record<SessionWorkflow, number> {
  const counts: Record<SessionWorkflow, number> = { interview: 0, summary: 0, feedback: 0, generating: 0, review: 0, reviewed: 0 };
  for (const session of sessions) counts[getSessionWorkflow(session)]++;
  return counts;
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export function sessionDateFilterError(filters: Pick<SessionFilters, 'dateFrom' | 'dateTo'>): string {
  if (filters.dateFrom && !validCalendarDate(filters.dateFrom)) return '开始日期无效，请选择有效日期。';
  if (filters.dateTo && !validCalendarDate(filters.dateTo)) return '结束日期无效，请选择有效日期。';
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) return '结束日期不能早于开始日期，请调整检索范围。';
  return '';
}
function localCalendarDate(value: string): string | null {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return [String(parsed.getFullYear()).padStart(4, '0'), String(parsed.getMonth() + 1).padStart(2, '0'), String(parsed.getDate()).padStart(2, '0')].join('-');
}

export function filterSessions(sessions: Session[], filters: SessionFilters): Session[] {
  if (sessionDateFilterError(filters)) return [];
  const query = filters.query.trim().toLocaleLowerCase();
  return sessions.filter((session) => {
    const research = session.research?.mode === 'research';
    if (filters.purpose === 'research' && !research) return false;
    if (filters.purpose === 'practice' && research) return false;
    if (filters.studyId && (!research || session.research?.studyId !== filters.studyId)) return false;
    if (filters.review === 'reviewed' && !session.review) return false;
    if (filters.review === 'pending' && (!session.feedback || session.review)) return false;
    if (filters.workflow && filters.workflow !== 'all' && getSessionWorkflow(session) !== filters.workflow) return false;
    if (filters.phase && session.research?.phase !== filters.phase) return false;
    if (filters.caseId && session.caseId !== filters.caseId) return false;
    if (filters.dateFrom || filters.dateTo) {
      const date = localCalendarDate(session.createdAt);
      if (!date || filters.dateFrom && date < filters.dateFrom || filters.dateTo && date > filters.dateTo) return false;
    }
    const search = [session.caseTitle, session.caseId, session.id, session.research?.studyId, session.research?.participantId, session.research?.studyCode, session.research?.studyTitle, session.research?.participantCode, session.research?.group].filter(Boolean).join(' ').toLocaleLowerCase();
    return !query || search.includes(query);
  });
}
