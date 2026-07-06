/**
 * Pure helpers for the grounding/verifier gate (P0-6).
 *
 * After Meri produces a deliverable (briefing / memo / doc edit), a cheap
 * second model pass extracts the document's factual claims and marks each
 * supported/unsupported against the retrieved sources. These helpers parse
 * that model output and summarize it into a confidence verdict. Pure (no I/O)
 * so they unit-test standalone; the model call lives in the calling service.
 *
 * SYNC NOTE: apps/api keeps an identical copy in
 * `apps/api/src/meri/meri-verifier.helpers.ts` (apps/api does not depend on
 * this package) — edit one, edit the other.
 */

export interface VerifiedClaim {
  claim: string;
  supported: boolean;
  /** Citation marker numbers ([N]) the claim relies on; empty for unsupported. */
  sourceIds: number[];
}

export interface VerificationResult {
  claims: VerifiedClaim[];
  totalCount: number;
  unsupportedCount: number;
  /** unsupportedCount / totalCount, 0 when there are no claims. */
  unsupportedRatio: number;
  /** True when the unsupported ratio exceeds the threshold. */
  lowConfidence: boolean;
}

/** Fraction of claims (above this share unsupported => "low confidence"). */
export const DEFAULT_UNSUPPORTED_THRESHOLD = 0.2;

function toNumberIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const v of value) {
    const n =
      typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[^\d]/g, '')) : NaN;
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Parse the verifier model's JSON into claims. Tolerant of code fences and
 * surrounding prose: extracts the first {...} block and reads `claims[]`.
 * Returns [] when nothing parseable is found.
 */
export function parseVerifierClaims(text: string): VerifiedClaim[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: { claims?: unknown };
  try {
    parsed = JSON.parse(match[0]) as { claims?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.claims)) return [];
  const out: VerifiedClaim[] = [];
  for (const raw of parsed.claims) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.claim !== 'string' || !c.claim.trim()) continue;
    out.push({
      claim: c.claim.trim(),
      supported: c.supported === true,
      sourceIds: toNumberIds(c.sourceIds),
    });
  }
  return out;
}

/**
 * Summarize claims into a verification verdict. `lowConfidence` is true when
 * the unsupported share strictly exceeds `threshold`. An empty claim set is
 * treated as confident (nothing to flag).
 */
export function summarizeVerification(
  claims: VerifiedClaim[],
  threshold = DEFAULT_UNSUPPORTED_THRESHOLD,
): VerificationResult {
  const totalCount = claims.length;
  const unsupportedCount = claims.filter((c) => !c.supported).length;
  const unsupportedRatio = totalCount === 0 ? 0 : unsupportedCount / totalCount;
  return {
    claims,
    totalCount,
    unsupportedCount,
    unsupportedRatio,
    lowConfidence: unsupportedRatio > threshold,
  };
}
