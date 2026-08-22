import type { QualityTelemetryEditMetrics } from '@capiro/meriv2-core';

/**
 * Above this combined length, a full Levenshtein computation (O(n*m)) risks
 * meaningfully slowing down the request it runs inside — the Phase 27E
 * handoff's guidance (§26) is to keep expensive calculations bounded or
 * async rather than block a user-facing action. Draft emails and CRM
 * findings are comfortably under this; a long Workspace document may not
 * be, and callers for that surface should route through an async job
 * instead of calling this helper inline (not yet built in this phase).
 */
const MAX_LEVENSHTEIN_LENGTH = 20_000;

/**
 * Computes a safe, numeric-only edit-burden proxy between two text bodies.
 * The bodies themselves are the caller's parameters and are NEVER returned
 * or logged by this function — only the resulting numbers. Returns null
 * (never a fabricated 0) when either input exceeds the bounded-cost cap, so
 * a caller can honestly omit the metric rather than skew it.
 */
export function computeEditMetrics(
  previousText: string,
  nextText: string,
): Pick<QualityTelemetryEditMetrics, 'percentChanged' | 'normalizedEditDistance'> | null {
  if (previousText.length > MAX_LEVENSHTEIN_LENGTH || nextText.length > MAX_LEVENSHTEIN_LENGTH) {
    return null;
  }
  const distance = levenshteinDistance(previousText, nextText);
  const denominator = Math.max(previousText.length, nextText.length, 1);
  return {
    normalizedEditDistance: distance / denominator,
    percentChanged: Math.round((distance / denominator) * 10000) / 100,
  };
}

/** Standard single-row dynamic-programming Levenshtein distance. */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          currentRow[j - 1]! + 1, // insertion
          previousRow[j]! + 1, // deletion
          previousRow[j - 1]! + cost, // substitution
        ),
      );
    }
    previousRow = currentRow;
  }
  return previousRow[b.length]!;
}
