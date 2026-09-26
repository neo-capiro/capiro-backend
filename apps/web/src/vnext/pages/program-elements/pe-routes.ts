/**
 * Program Elements vNext route contract (PROGRAM-ELEMENTS-HANDOFF §4, extended
 * by the Phase 3 native rebuild).
 *
 * The module ships in the vNext surface (os.capiro.ai) but preserves the
 * canonical URLs exactly — destination and tab are URL (query) state, never
 * component state, so deep links, shared filters and browser back/forward
 * behave identically to the canonical app.
 *
 * Route shape:
 *   /program-elements                                  Workspace (Explore default destination)
 *   /program-elements?dest=movement|congressional|actions|portfolio
 *   /program-elements/mark-up-monitor                  Mark-up monitor (native, Phase 3)
 *   /program-elements/contacts                         Contact review queue (native, Phase 3)
 *   /program-elements/research                         Defense research (native, Phase 5)
 *   /program-elements/:peCode                          Line profile (Overview default tab)
 *   /program-elements/:peCode?tab=funding|legislative|structure|sources
 *
 * `reconciliation` is a reserved static segment that is NOT claimed — there is
 * no canonical page at /program-elements/reconciliation (the reconciliation
 * queue lives at /admin/program-element/reconciliation), so the segment falls
 * through to the canonical tree exactly as before.
 */

/** Workspace destinations, in the order the destination bar renders them. */
export const PE_DESTINATIONS = [
  'explore',
  'movement',
  'congressional',
  'actions',
  'portfolio',
] as const;
export type PeDestination = (typeof PE_DESTINATIONS)[number];

/** Line-profile tabs, in the order the profile tab strip renders them. */
export const PE_PROFILE_TABS = [
  'overview',
  'funding',
  'legislative',
  'structure',
  'sources',
] as const;
export type PeProfileTab = (typeof PE_PROFILE_TABS)[number];

export const PE_WORKSPACE_ROUTE = '/program-elements';

/**
 * Static PE segments claimed by the vNext module as of Phase 3 (native
 * rebuilds of the canonical mark-up monitor and contact review queue).
 */
export const PE_CLAIMED_STATIC_SEGMENTS = ['mark-up-monitor', 'contacts', 'research'] as const;
export type PeStaticSegment = (typeof PE_CLAIMED_STATIC_SEGMENTS)[number];

/**
 * Static PE segments that must never parse as a :peCode line profile. The
 * claimed ones above render native pages; `reconciliation` stays unclaimed
 * (see the header comment).
 */
const PE_STATIC_SEGMENTS = new Set([
  'mark-up-monitor',
  'contacts',
  'reconciliation',
  'research',
  'compare',
  'coverage',
]);

/**
 * Canonical PE and budget-line identifiers currently exposed by the dossier
 * route are uppercase alpha-numeric codes. Requiring a digit prevents future
 * static words from being swallowed by the dynamic matcher.
 */
const PE_PROFILE_ID = /^(?=[A-Z0-9]{8,10}$)(?=.*\d)[A-Z0-9]+$/;

/** Normalize a raw `?dest=` value to a destination, defaulting to Explore. */
export function resolvePeDestination(raw: string | null | undefined): PeDestination {
  return (PE_DESTINATIONS as readonly string[]).includes(raw ?? '')
    ? (raw as PeDestination)
    : 'explore';
}

/** Normalize a raw `?tab=` value to a profile tab, defaulting to Overview. */
export function resolvePeProfileTab(raw: string | null | undefined): PeProfileTab {
  return (PE_PROFILE_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as PeProfileTab)
    : 'overview';
}

/**
 * Match a claimed static segment (mark-up monitor / contacts), or null when
 * the path is neither. Exact one-segment match only — deeper paths fall
 * through to canonical, same as before Phase 3.
 */
export function matchPeStaticPath(pathname: string): PeStaticSegment | null {
  for (const segment of PE_CLAIMED_STATIC_SEGMENTS) {
    if (pathname === `${PE_WORKSPACE_ROUTE}/${segment}`) return segment;
  }
  return null;
}

/**
 * Extract the PE code from a profile pathname, or null when the path is not a
 * claimable line profile. Returns null for the workspace root and for the
 * static segments above so those resolve to their own branches (or, for
 * `reconciliation`, fall through to canonical).
 */
export function matchPeProfilePath(pathname: string): string | null {
  if (!pathname.startsWith(`${PE_WORKSPACE_ROUTE}/`)) return null;
  const rest = pathname.slice(PE_WORKSPACE_ROUTE.length + 1);
  if (!rest || rest.includes('/')) return null;

  let segment: string;
  try {
    segment = decodeURIComponent(rest);
  } catch {
    return null;
  }

  if (segment.includes('/') || PE_STATIC_SEGMENTS.has(segment) || !PE_PROFILE_ID.test(segment)) {
    return null;
  }
  return segment;
}

/**
 * Guard used by `VNextRouter` to decide whether the vNext Program Elements
 * module claims this path. Claims the workspace root, the two native static
 * segments and line profiles; `reconciliation` falls through to canonical.
 */
export function isVNextProgramElementsPath(pathname: string): boolean {
  if (pathname === PE_WORKSPACE_ROUTE) return true;
  if (matchPeStaticPath(pathname) !== null) return true;
  return matchPeProfilePath(pathname) !== null;
}
