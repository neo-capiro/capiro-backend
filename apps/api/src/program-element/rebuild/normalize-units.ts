/**
 * Pure helpers for the value-based PE-mark unit normalizer.
 *
 * Context: program_element_year marks were stored in raw DOLLARS but the app
 * renders MILLIONS. The log-based rebuild (rebuild-years.ts) only repaired fields
 * that had per-field source-value log entries (request + committee marks); the
 * historical enacted/conference values were loaded without per-field logging and
 * stayed in dollars. This normalizer finishes the job on the canonical table
 * directly, keyed off MAGNITUDE rather than the log.
 *
 * Why a magnitude threshold is safe + non-destructive here: every value is either
 * (a) already millions — real marks top out around $1-2B = ~1500, seed fixtures
 * ~600, all well under the threshold — or (b) raw dollars, which for any real PE
 * mark is >= ~$1e7. Nothing legitimate sits near $100,000M ($100B), so any
 * |value| over the threshold is unambiguously dollars and is divided by 1e6.
 * Idempotent: once divided, values fall below the threshold and are never touched
 * again. Fixtures (already millions) are below the threshold, so left alone.
 */

/** Numeric mark columns on program_element_year (snake_case for raw SQL). */
export const PE_VALUE_COLUMNS = [
  'request',
  'hasc_mark',
  'sasc_mark',
  'hac_d_mark',
  'sac_d_mark',
  'conference',
  'ndaa_conference',
  'enacted',
  'reprogrammed',
  'executed',
] as const;
export type PeValueColumn = (typeof PE_VALUE_COLUMNS)[number];

/**
 * |value| above this is raw dollars (needs ÷1e6); at/below is already millions.
 * No single PE-year mark approaches $100,000M ($100B); real dollar marks are
 * >= ~$1e7. The gap makes the split unambiguous.
 */
export const DOLLARS_THRESHOLD = 100_000;

/** True when a stored value is in dollar-scale and must be scaled to millions. */
export function needsScaling(value: number | null | undefined): boolean {
  return (
    value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    Math.abs(value) > DOLLARS_THRESHOLD
  );
}

/** Dollars -> millions. */
export function toMillions(value: number): number {
  return value / 1_000_000;
}
