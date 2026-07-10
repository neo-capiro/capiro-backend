/**
 * Shared district-code normalization (Phase 1 M1.3 / W2.2). Dependency-free so
 * both the representation resolver (join-time comparison) and the facility
 * geocode discrepancy check (data-quality comparison) use ONE definition of
 * "same district" instead of two copies that can silently diverge (G3).
 */

/**
 * Strip cosmetic variation ("HD-3", "003", " 3 ") down to a bare digit
 * string for comparison against a facility's geocoded BASENAME-style code.
 * `state_legislator.district` is populated verbatim from OpenStates
 * (`currentRole?.district?.toString()`) whose exact per-state format is not
 * guaranteed — never assume exact string equality (PD2).
 */
export function normalizeDistrictCode(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = raw
    .trim()
    .replace(/^\D+/, '')
    .replace(/^0+(?=\d)/, '');
  return digits || null;
}
