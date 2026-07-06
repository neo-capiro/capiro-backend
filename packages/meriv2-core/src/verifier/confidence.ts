/**
 * Calibrated confidence for Meri deliverables (P1-6).
 *
 * Maps the P0-6 verifier's unsupported-claim ratio to a graded confidence signal
 * (instead of just the boolean lowConfidence), so the UI can show an honest
 * high/medium/low badge and avoid false certainty. Pure so it unit-tests
 * standalone.
 *
 * SYNC NOTE: apps/api keeps an identical copy in
 * `apps/api/src/meri/meri-confidence.helpers.ts` (apps/api does not depend on
 * this package) — edit one, edit the other.
 */

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown';

export interface Confidence {
  level: ConfidenceLevel;
  label: string;
}

/** High <=5% unsupported, medium <=20%, low above; null/NaN => unknown. */
export function confidenceLevel(unsupportedRatio: number | null): Confidence {
  if (unsupportedRatio == null || Number.isNaN(unsupportedRatio)) {
    return { level: 'unknown', label: 'Unverified' };
  }
  if (unsupportedRatio <= 0.05) return { level: 'high', label: 'High confidence' };
  if (unsupportedRatio <= 0.2) return { level: 'medium', label: 'Medium confidence' };
  return { level: 'low', label: 'Low confidence — verify before use' };
}
