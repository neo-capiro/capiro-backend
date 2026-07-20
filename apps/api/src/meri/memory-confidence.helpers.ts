/**
 * Phase 4 — confidence WRITE gate (pure, no I/O). The recall-side confidence
 * weighting that Phase 4 originally shipped was superseded by the unified
 * similarity+recency+confidence fusion in memory-scoring.helpers.ts (Phase 5),
 * so only the write gate lives here now.
 */

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
