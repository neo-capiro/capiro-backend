/**
 * LearningSignal candidate vs. existing memory — Phase 27C conflict
 * lifecycle contract.
 *
 * Pure, dependency-free (no I/O, no Prisma, no embedding calls) — same
 * discipline as `./contract.ts` and `./candidate-contract.ts`. This module
 * only answers "given a similarity score and a text-equality check, what
 * relationship (if any) does a new candidate have to an existing item?" —
 * the actual embedding + SQL search lives in
 * `apps/api/src/learning/learning-signal-memory-conflict.service.ts`, which
 * calls into this for the decision.
 *
 * Phase 27B's disclosed gap ("no stable key yet links a candidate to a
 * committed memory_items row, and real matching needs the semantic
 * capability the handoff permits deferring") is closed here: this is that
 * semantic capability, scoped narrowly to detection or classification, never
 * promotion. Executing a supersession (flipping an active item's governed
 * status, setting `supersedesId`) stays out of scope — that is 27D
 * governance-integration work, once a human has reviewed what this module
 * only ever proposes as a pending candidate's `contradictsMemoryItemId` /
 * `conflictStatus`.
 */

/**
 * Cosine-similarity bands, calibrated against `context_embeddings`'
 * 1024-dim Titan vectors — the same embedding space the existing
 * `search_memory` recall tool already searches (apps/api/src/meri/
 * meri-tools.service.ts's `searchMemory`), not a new one. Deliberately
 * high: general recall relevance (MEMORY_PROJECTION_MIN_SCORE = 0.4,
 * apps/api/src/config/config.schema.ts) tolerates loosely-related results
 * on purpose; near-duplicate/contradiction detection must not, or every
 * vaguely-similar memory would get flagged.
 */
export const MEMORY_CONFLICT_SIMILARITY_THRESHOLDS = {
  /** At/above this cosine score, treat the match as "the same fact" — a
   *  duplicate if the text is equal, a probable contradiction if not. */
  CONTRADICTION_MIN: 0.9,
  /** Below CONTRADICTION_MIN but at/above this, the match is worth a
   *  human's attention but not confident enough to assert a specific
   *  relationship — "flag for review rather than auto-merging" (handoff). */
  REVIEW_MIN: 0.78,
} as const;

export const MEMORY_CONFLICT_MATCH_KINDS = [
  'duplicate',
  'probable_contradiction',
  'possible_related',
  'unrelated',
] as const;
export type MemoryConflictMatchKind = (typeof MEMORY_CONFLICT_MATCH_KINDS)[number];

export interface MemoryConflictMatchInput {
  /** Cosine similarity in [-1, 1] (in practice [0, 1] for these vectors). */
  readonly score: number;
  /** Whether the candidate's fact text and the matched item's fact text
   *  are equal after normalization — see {@link normalizeFactText}. */
  readonly textsEqual: boolean;
}

/**
 * First-match-wins classification, same style as `evaluateMemoryCandidate`
 * and `classifyLearningSignalEligibility`. Never returns a relationship
 * more confident than the thresholds justify — "safe handling when
 * confidence is insufficient: flag for review rather than auto-merging"
 * means `possible_related` exists precisely so a mid-confidence match is
 * never silently promoted to `probable_contradiction`.
 */
export function classifyMemoryConflictMatch(input: MemoryConflictMatchInput): MemoryConflictMatchKind {
  if (input.score >= MEMORY_CONFLICT_SIMILARITY_THRESHOLDS.CONTRADICTION_MIN) {
    return input.textsEqual ? 'duplicate' : 'probable_contradiction';
  }
  if (input.score >= MEMORY_CONFLICT_SIMILARITY_THRESHOLDS.REVIEW_MIN) {
    return 'possible_related';
  }
  return 'unrelated';
}

/**
 * NFKC + case-fold + whitespace-collapse, mirroring the existing exact-text
 * equality check `normalizeMemoryVersionText` (apps/api/src/memory/
 * memory-version.helpers.ts) uses for the human-driven correction/
 * contradiction flow — reusing the SAME notion of "equal text" rather than
 * inventing a second one, so a fact this module calls "duplicate" would
 * also be called "duplicate" by that flow if a human took the same two
 * strings there.
 */
export function normalizeFactText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A best-match result already carries everything a reviewer needs, capped
 * to fit `learning_signal_candidate_outcome.reason` (240 chars) — this
 * module never assumes an unbounded audit field exists.
 */
export function describeMemoryConflictMatch(
  kind: MemoryConflictMatchKind,
  targetLabel: string,
  score: number,
): string {
  const pct = Math.round(score * 100) / 100;
  switch (kind) {
    case 'duplicate':
      return `Corroborates existing ${targetLabel} (cosine=${pct}) — no new candidate needed.`;
    case 'probable_contradiction':
      return `Probable contradiction with ${targetLabel} (cosine=${pct}); flagged for review, not auto-applied.`;
    case 'possible_related':
      return `Possibly related to ${targetLabel} (cosine=${pct}); confidence insufficient to assert a relationship, flagged for review.`;
    case 'unrelated':
      return `No related memory found (best score ${pct} below review threshold).`;
  }
}
