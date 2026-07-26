/**
 * Deep-link target for a `redistricting` intelligence_change card (WS-D3).
 *
 * Lives in its own module rather than inside HomePage.tsx so it is unit
 * testable: importing HomePage pulls in `env.ts` transitively, which throws
 * without a runtime config / VITE_CLERK_PUBLISHABLE_KEY. Same reasoning and
 * shape as `pages/directory/district-kml.ts` next to its own page component.
 */

/**
 * `facilityDistrictCode` is the 2-char zero-padded code ('00' at-large) that
 * `apps/api/scripts/emit-redistricting-alerts.ts` derives via the shared
 * district-code util, and it is what `/directory/districts/:state/:districtNo`
 * expects. The sibling `districtNo` on the same payload is the BARE number
 * ('7', not '07') and must never be used here — it would 404.
 *
 * Returns the generic changes inbox when either field is missing, rather than
 * assembling a URL that cannot resolve.
 */
export function redistrictingHref(data: unknown): string {
  const d = data as { state?: unknown; facilityDistrictCode?: unknown } | null | undefined;
  const state = typeof d?.state === 'string' ? d.state : null;
  const code = typeof d?.facilityDistrictCode === 'string' ? d.facilityDistrictCode : null;
  if (!state || !code) return '/intelligence/changes';
  return `/directory/districts/${encodeURIComponent(state)}/${encodeURIComponent(code)}`;
}
