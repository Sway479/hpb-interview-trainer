import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCase } from './cases.ts';
import type { Feedback, LearnerSummary, Session, Turn } from './types.ts';

export class DomainError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    for (const filename of readdirSync(directory).filter(x => /^[\da-f-]{36}\.json$/.test(x))) {
      const session = JSON.parse(readFileSync(join(directory, filename), 'utf8')) as Session;
      if (session.status === 'feedback_pending') {
        session.status = 'summary'; session.feedbackError = '上次反馈生成中断，请重试。';
        delete session.feedback; delete session.review;
        this.save(session);
      } else {
        this.sessions.set(session.id, session);
      }
    }
  }
  private save(session: Session): Session {
    const path = join(this.directory, `${session.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(session, null, 2));
    renameSync(`${path}.tmp`, path);
    // Do not publish a state that failed to reach the atomic file replacement.
    this.sessions.set(session.id, structuredClone(session));
    return structuredClone(session);
  }
  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new DomainError('会话不存在', 404);
    return structuredClone(session);
  }
  list(): Session[] { return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(s => structuredClone(s)); }
  create(caseId: string): Session {
    let definition;
    try { definition = getCase(caseId); } catch { throw new DomainError('病例不存在', 404); }
    return this.save({ id: randomUUID(), caseId, caseVersion: definition.version, caseTitle: definition.title,
      createdAt: new Date().toISOString(), status: 'interview', turns: [] });
  }
  requireInterview(id: string): Session {
    const session = this.get(id);
    if (session.status !== 'interview') throw new DomainError('问诊已结束，不能继续增加对话。');
    return session;
  }
  addTurn(id: string, turn: Turn): Session {
    const session = this.requireInterview(id);
    const index = session.turns.findIndex(item => item.id === turn.id);
    if (index >= 0) session.turns[index] = structuredClone(turn); else session.turns.push(structuredClone(turn));
    return this.save(session);
  }
  setRecordings(id: string, recordings: Session['recordings']): Session {
    const session = this.get(id); session.recordings = recordings; return this.save(session);
  }
  recordModelCall(id: string, event: NonNullable<Session['modelCalls']>[number]): Session {
    const session = this.get(id);
    session.modelCalls = [...(session.modelCalls ?? []), event];
    return this.save(session);
  }
  end(id: string): Session {
    const session = this.get(id);
    if (session.status !== 'interview') return session;
    session.status = 'summary'; session.endedAt = new Date().toISOString();
    return this.save(session);
  }
  beginFeedback(id: string, summary: LearnerSummary): Session {
    const session = this.get(id);
    if (session.status !== 'summary') throw new DomainError('请先结束问诊；反馈生成中或已提交的会话不能重复提交。');
    if (!session.turns.some(t => t.role === 'learner' && t.text.trim())) throw new DomainError('尚无学员问诊记录，无法生成有依据的反馈。', 400);
    session.summary = structuredClone(summary); session.status = 'feedback_pending'; delete session.feedbackError;
    delete session.feedback; delete session.review;
    return this.save(session);
  }
  completeFeedback(id: string, feedback: Feedback): Session {
    const session = this.get(id);
    if (session.status !== 'feedback_pending' || !session.summary) throw new DomainError('反馈状态已改变。');
    session.feedback = structuredClone(feedback); session.status = 'feedback_ready';
    return this.save(session);
  }
  failFeedback(id: string, message: string): Session {
    const session = this.get(id);
    if (session.status !== 'feedback_pending') throw new DomainError('反馈状态已改变。');
    session.status = 'summary'; session.feedbackError = message;
    delete session.feedback; delete session.review;
    return this.save(session);
  }
  review(id: string, reviewer: string, notes: string): Session {
    const session = this.get(id);
    if (!session.feedback || !['feedback_ready', 'reviewed'].includes(session.status)) throw new DomainError('反馈尚未生成，不能填写复核结论。');
    session.review = { reviewer, notes, at: new Date().toISOString() }; session.status = 'reviewed';
    return this.save(session);
  }
}
