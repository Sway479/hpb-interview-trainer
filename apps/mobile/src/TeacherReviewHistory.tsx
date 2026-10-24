import { IonIcon } from '@ionic/react';
import { chevronDownOutline } from 'ionicons/icons';
import type { AssessmentScore, Session } from '../../../packages/core/src/types';
import { Badge } from './components';
import './TeacherReviewHistory.css';

const scoreText = (score: AssessmentScore | undefined) => score === null ? '未计分'
  : score === 0 || score === 1 || score === 2 ? `${score} / 2` : '旧版未记录';
const reviewTime = (at: string) => Number.isNaN(Date.parse(at)) ? at : new Date(at).toLocaleString('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** Read-only revisions; viewing history never restores, rewrites or reapplies a previous review. */
export function TeacherReviewHistory({ session }: { session: Session }) {
  const revisions = [...(session.reviewHistory ?? []), ...(session.review ? [session.review] : [])];
  if (!revisions.length) return null;
  return <details className="teacher-review-history panel">
    <summary><span><strong>历次教师复核</strong><small>共 {revisions.length} 版 · 只读留存，AI原分保留</small></span><IonIcon icon={chevronDownOutline} aria-hidden="true" /></summary>
    <div className="trh-body"><p className="trh-scope">按本机保存顺序编号，最近保存的版本在前。时间来自设备时钟；姓名或编号由人工填写，不代表身份认证或独立盲评。</p>
      {revisions.map((review, index) => ({ review, revision: index + 1, current: !!session.review && index === revisions.length - 1 })).reverse().map(({ review, revision, current }) => <details className="trh-revision" key={revision} open={current}>
        <summary><span><strong>第 {revision} 版 <Badge tone={current ? 'teal' : 'neutral'}>{current ? '当前采用' : '历史留存'}</Badge></strong><small>{review.reviewer || '旧版未记录复核者'} · <time dateTime={review.at}>{reviewTime(review.at)}</time></small></span><IonIcon icon={chevronDownOutline} aria-hidden="true" /></summary>
        <div className="trh-revision-body"><h3>整体意见</h3><p className="trh-notes">{review.notes || '本版未填写整体意见。'}</p>
          {review.corrections?.length ? <><h3>本版逐项修正</h3>{review.corrections.map((correction, correctionIndex) => {
            const originals = session.feedback?.items.filter(item => item.criterionId === correction.criterionId) ?? [];
            const original = originals.length === 1 ? originals[0] : undefined;
            return <section className="trh-correction" key={correction.criterionId + '-' + correctionIndex}>
              <h4>{original?.label || correction.criterionId}</h4>
              <p className="trh-scores">AI原分：{originals.length > 1 ? '条目重复，需核对' : scoreText(original?.score)}<br />本版教师修正：<strong>{scoreText(correction.score)}</strong></p>
              <p className="trh-reason"><strong>理由与原文依据</strong>{correction.reason || '本版未记录理由。'}</p>
            </section>;
          })}</> : <p className="trh-empty">本版仅有整体意见，没有逐项分值修正；不等于确认全部AI条目。</p>}
        </div>
      </details>)}
    </div>
  </details>;
}
