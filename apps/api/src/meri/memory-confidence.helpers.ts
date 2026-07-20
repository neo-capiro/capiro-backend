/**
 * Phase 4 — confidence-weighted recall fusion (pure, no I/O; unit-testable in
 * isolation from MeriService, mirroring memory-recall-source.helpers.ts).
 *
 * Recall today ranks purely by embedding similarity. Confidence lets an
 * uncertain-but-similar memory be demoted below a confident-but-slightly-less-
 * similar one — WITHOUT ever fabricating a boost: the fused score is
 * `similarity × factor` with factor ∈ (0,1], so fusion can only ever LOWER a
 * row's score, never raise it above its raw similarity.
 *
 * NEUTRAL PRIOR: a NULL/unscored confidence (legacy rows, explicit human saves)
 * yields factor 1 — such rows are never demoted. weight<=0 disables fusion
 * entirely (factor≡1), making the whole path a byte-identical no-op — the DARK
 * default (MEMORY_CONFIDENCE_WEIGHT=0).
 */

/** A scored recall row; confidence may be absent/null (unscored). */
export interface ConfidenceScored {
  score: number;
  confidence?: number | null;
}

/**
 * Dampened confidence multiplier: `1 - w + w·c`, a convex blend between 1
 * (ignore confidence) and c (fully trust it). Returns 1 (neutral) when the
 * weight is non-positive/non-finite or the confidence is null/non-finite.
 * c is clamped to [0,1] defensively (the DB CHECK already enforces the range).
 */
export function confidenceFactor(confidence: number | null | undefined, weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) return 1;
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) return 1;
  const c = Math.min(1, Math.max(0, confidence));
  const w = Math.min(1, Math.max(0, weight));
  return 1 - w + w * c;
}

/**
 * Fuse a similarity score with a confidence factor. Monotonic in similarity;
 * result is always <= similarity (confidence only demotes uncertain rows).
 */
export function fuseConfidenceScore(
  similarity: number,
  confidence: number | null | undefined,
  weight: number,
): number {
  return similarity * confidenceFactor(confidence, weight);
}

/**
 * Re-rank scored rows by their confidence-fused score, returning rows whose
 * `.score` has been REPLACED by the fused value (so a downstream relevance
 * floor keys off the fused score, consistent with the accuracy-first intent).
 *
 * weight<=0 ⇒ strict identity: the input array is returned unchanged (same
 * order, same objects) — the DARK-parity guarantee. Otherwise a STABLE sort
 * descending preserves the incoming vector `ORDER BY` as the tie-break.
 */
export function rerankByConfidence<T extends ConfidenceScored>(rows: T[], weight: number): T[] {
  if (!Number.isFinite(weight) || weight <= 0) return rows;
  return rows
    .map((r, i) => ({ r, i, fused: fuseConfidenceScore(r.score, r.confidence, weight) }))
    .sort((a, b) => (b.fused - a.fused) || (a.i - b.i))
    .map(({ r, fused }) => ({ ...r, score: fused }));
}

/** Default write-confidence floor — preserves auto-learn's historical 0.7 gate. */
export const DEFAULT_MIN_WRITE_CONFIDENCE = 0.7;

/**
 * Write-path gate for a MODEL-extracted memory: a numeric confidence must meet
 * the floor. A non-finite/absent confidence FAILS (conservative — an unscored
 * machine guess is not auto-committed). Uses a small tolerance so a float that
 * round-trips as 0.6999999999 at the floor 0.7 is not spuriously rejected.
 */
export function passesWriteConfidenceGate(
  confidence: number | null | undefined,
  minConfidence: number = DEFAULT_MIN_WRITE_CONFIDENCE,
): boolean {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) return false;
  const floor = Number.isFinite(minConfidence) ? minConfidence : DEFAULT_MIN_WRITE_CONFIDENCE;
  return confidence >= floor - 1e-9;
}
