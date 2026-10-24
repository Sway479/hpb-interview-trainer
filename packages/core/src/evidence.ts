import type { Turn } from './types.ts';

export interface EvidenceReference { turnId: string; quote: string }
export type EvidenceIssue = 'duplicate_turn_id' | 'empty_quote' | 'missing_turn' | 'incomplete_turn'
  | 'interrupted_turn' | 'unverified_turn' | 'quote_mismatch';
export interface EvidenceResolution { turn?: Turn; reliable: boolean; canNavigate: boolean; issue?: EvidenceIssue }

export function isReliableTurn(turn: Turn): boolean {
  return turn.final && !turn.interrupted && turn.verification !== 'paraphrase_unverified' && !!turn.text.trim();
}

/** Resolve only unique turn IDs. A reference proves its source, not the validity of a rating. */
export function createEvidenceResolver(turns: readonly Turn[]) {
  const byId = new Map<string, Turn>(), duplicates = new Set<string>();
  for (const turn of turns) {
    if (byId.has(turn.id)) duplicates.add(turn.id);
    byId.set(turn.id, turn);
  }
  const uniqueTurn = (turnId: string): Turn | undefined => duplicates.has(turnId) ? undefined : byId.get(turnId);
  const resolve = (reference: EvidenceReference): EvidenceResolution => {
    if (duplicates.has(reference.turnId)) return { reliable: false, canNavigate: false, issue: 'duplicate_turn_id' };
    const turn = uniqueTurn(reference.turnId);
    if (!reference.quote.trim()) return { turn, reliable: false, canNavigate: false, issue: 'empty_quote' };
    if (!turn) return { reliable: false, canNavigate: false, issue: 'missing_turn' };
    // A uniquely identified but unreliable source can still be opened for manual review.
    const unresolved = (issue: EvidenceIssue): EvidenceResolution => ({ turn, reliable: false, canNavigate: true, issue });
    if (!turn.final || !turn.text.trim()) return unresolved('incomplete_turn');
    if (turn.interrupted) return unresolved('interrupted_turn');
    if (turn.verification === 'paraphrase_unverified') return unresolved('unverified_turn');
    if (!turn.text.includes(reference.quote)) return unresolved('quote_mismatch');
    return { turn, reliable: true, canNavigate: true };
  };
  return { resolve, uniqueTurn, isDuplicate: (turnId: string) => duplicates.has(turnId) };
}
