import test from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_RULES, summaryValidation, hasReliableLearnerTranscript } from '../packages/core/src/summary-rules.ts';
const { summarySchema } = await import(new URL('../apps/mobile/src/platform/repository.ts', import.meta.url).href);
import type { LearnerSummary, Turn } from '../packages/core/src/types.ts';

const valid: LearnerSummary = { history: '患者病史尚有重要信息需要核实。', reasoning: '病因待核实。', plan: '继续核实资料。', uncertainty: '证据仍不充分。' };
test('summary entry and persistence accept the same trimmed length boundaries', () => {
  for (const key of Object.keys(SUMMARY_RULES) as (keyof LearnerSummary)[]) {
    const { min, max } = SUMMARY_RULES[key];
    for (const n of [min - 1, min, max, max + 1]) {
      const value = { ...valid, [key]: ' ' + '字'.repeat(n) + ' ' };
      assert.equal(!!summaryValidation(value)[key], !summarySchema.safeParse(value).success);
    }
  }
});
test('legacy oversized draft is explained but never truncated by validation', () => {
  const draft = { ...valid, history: '旧'.repeat(10000) }, original = JSON.stringify(draft);
  assert.match(summaryValidation(draft).history!, /超过6000/); assert.equal(JSON.stringify(draft), original);
  assert.match(summaryValidation({ ...valid, reasoning: ' \n ' }).reasoning!, /至少2/);
});
test('save-only path is required when all learner text is incomplete, interrupted or unverifiable', () => {
  const base: Turn = { id: 'one', role: 'learner', text: '请问什么时候开始？', final: true, source: 'typed', at: '2026-10-23T00:00:00.000Z' };
  assert.equal(hasReliableLearnerTranscript([base]), true);
  for (const overrides of [{ role: 'patient' as const }, { final: false }, { interrupted: true }, { verification: 'paraphrase_unverified' as const }, { text: '  ' }])
    assert.equal(hasReliableLearnerTranscript([{ ...base, ...overrides }]), false);
  assert.equal(hasReliableLearnerTranscript([base, { ...base, text: '重复ID冲突' }]), false);
  assert.equal(hasReliableLearnerTranscript([{ ...base, final: false }, { ...base, id: 'two' }]), true);
});
