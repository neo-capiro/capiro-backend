/**
 * Program Elements vNext route contract (PROGRAM-ELEMENTS-HANDOFF §4).
 *
 * The module ships in the vNext surface (os.capiro.ai) but preserves the
 * canonical URLs exactly — destination and tab are URL (query) state, never
 * component state, so deep links, shared filters and browser back/forward
 * behave identically to the canonical app.
 *
 * Route shape (handoff §4):
 *   /program-elements                                  Explore (default destination)
 *   /program-elements?dest=movement|congressional|actions|portfolio
 *   /program-elements/:peCode                          Line profile (Overview default tab)
 *   /program-elements/:peCode?tab=funding|legislative|structure|sources
 *
 * Static segments (`mark-up-monitor`, `contacts`) and the legacy finder params
 * are NOT claimed here — they fall through to the canonical page so existing
 * surfaces keep working while the vNext module owns only the workspace shell
 * and the line profile.
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
 * Static PE segments that the vNext module must NOT claim. These are distinct
 * canonical surfaces (mark-up monitor, contact candidates) that share the
 * `/program-elements/` prefix; claiming them would shadow working pages.
 */
const PE_STATIC_SEGMENTS = new Set(['mark-up-monitor', 'contacts', 'reconciliation']);

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
 * Extract the PE code from a profile pathname, or null when the path is not a
 * claimable line profile. Returns null for the workspace root and for the
 * static segments above so those fall through to canonical.
 */
export function matchPeProfilePath(pathname: string): string | null {
  if (!pathname.startsWith(`${PE_WORKSPACE_ROUTE}/`)) return null;
  const rest = pathname.slice(PE_WORKSPACE_ROUTE.length + 1);
  const segment = rest.split('/')[0] ?? '';
  if (!segment || PE_STATIC_SEGMENTS.has(segment)) return null;
  return decodeURIComponent(segment);
}

/**
 * Guard used by `VNextRouter` to decide whether the vNext Program Elements
 * module claims this path. Claims the workspace root and line profiles only;
 * static segments fall through to the canonical page.
 */
export function isVNextProgramElementsPath(pathname: string): boolean {
  if (pathname === PE_WORKSPACE_ROUTE) return true;
  return matchPeProfilePath(pathname) !== null;
}
