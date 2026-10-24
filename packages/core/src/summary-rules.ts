import type { LearnerSummary, Turn } from './types.ts';

export const SUMMARY_RULES: Record<keyof LearnerSummary, { label: string; min: number; max: number }> = {
  history: { label: '病史总结', min: 10, max: 6000 },
  reasoning: { label: '初步判断与依据', min: 2, max: 4000 },
  plan: { label: '下一步计划', min: 2, max: 4000 },
  uncertainty: { label: '仍不确定的地方', min: 2, max: 4000 },
};
export function summaryValidation(value: LearnerSummary): Partial<Record<keyof LearnerSummary, string>> {
  const issues: Partial<Record<keyof LearnerSummary, string>> = {};
  for (const key of Object.keys(SUMMARY_RULES) as (keyof LearnerSummary)[]) {
    const rule = SUMMARY_RULES[key], length = value[key].trim().length;
    if (length < rule.min) issues[key] = `${rule.label}请填写至少${rule.min}个非首尾空白字符。`;
    else if (length > rule.max) issues[key] = `${rule.label}超过${rule.max}字，请自行缩减；原草稿不会自动截断。`;
  }
  return issues;
}
export function hasReliableLearnerTranscript(turns: readonly Turn[]): boolean {
  const counts = new Map<string, number>(); turns.forEach(t => counts.set(t.id, (counts.get(t.id) || 0) + 1));
  return turns.some(t => t.role === 'learner' && counts.get(t.id) === 1 && t.final && !t.interrupted && t.verification !== 'paraphrase_unverified' && !!t.text.trim());
}
