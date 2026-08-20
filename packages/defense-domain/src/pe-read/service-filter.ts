/**
 * Service-filter normalization for budget-line queries.
 *
 * Hoisted verbatim from `apps/api/src/program-element/service-filter.ts`. The
 * canonical `program_element.service` vocabulary is ARMY / NAVY / AF / SF / USMC /
 * DW / DARPA, but clients have historically sent display-style values
 * (AIR_FORCE, SPACE_FORCE, DOD) which silently matched nothing for every branch
 * except Army/Navy. Normalize ANY reasonable alias to the canonical code; unknown
 * values pass through unchanged so future additions are never blocked here.
 *
 * defense-api's previous list implementation applied the raw query value, so
 * `?service=AIR_FORCE` returned an empty page where apps/api returns the Air
 * Force lines. This is a behavioural difference, not a cosmetic one.
 */
const SERVICE_ALIASES: Record<string, string> = {
  ARMY: 'ARMY',
  USA: 'ARMY',
  NAVY: 'NAVY',
  USN: 'NAVY',
  AF: 'AF',
  USAF: 'AF',
  AIR_FORCE: 'AF',
  'AIR FORCE': 'AF',
  AIRFORCE: 'AF',
  SF: 'SF',
  USSF: 'SF',
  SPACE_FORCE: 'SF',
  'SPACE FORCE': 'SF',
  SPACEFORCE: 'SF',
  USMC: 'USMC',
  MARINES: 'USMC',
  MARINE_CORPS: 'USMC',
  'MARINE CORPS': 'USMC',
  DW: 'DW',
  DOD: 'DW',
  DOW: 'DW',
  OSD: 'DW',
  DEFENSE_WIDE: 'DW',
  'DEFENSE WIDE': 'DW',
  'DEFENSE-WIDE': 'DW',
  DARPA: 'DARPA',
};

/** Normalize a client-supplied service filter to the canonical stored code. */
export function normalizeServiceFilter(raw: string | null | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  return SERVICE_ALIASES[v.toUpperCase()] ?? v;
}
