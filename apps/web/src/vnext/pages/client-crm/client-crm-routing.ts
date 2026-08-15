/**
 * Client CRM vNext route state (Figma `1244:4222` §2).
 *
 * The client profile has never had a `/clients/:id` route — it renders inside
 * `ClientWorkspacePage` at `/clients?clientId=<id>` (see that file's comment at
 * the `linkedId` read). Every "deep link" in the contract is therefore a query
 * parameter, and this module is the single place that reads and writes them.
 *
 * Contract:
 *   tab=overview | relationships | work | intelligence | files
 *   tab=relationships  view=organization | government | history
 *   tab=intelligence   view=overview | legislative | regulatory | funding
 *                           | footprint | district
 *   tab=capabilities   preserved capability-management surface (§13)
 *
 * Legacy values keep resolving, and are rewritten to their canonical form so
 * the URL always describes the view that is actually on screen.
 */

export const CRM_TABS = ['overview', 'capabilities', 'relationships', 'work', 'intelligence', 'files'] as const;
export type CrmTab = (typeof CRM_TABS)[number];

/** `capabilities` IS a primary tab in the Portfolio prototype (§5.3, §16). */
export type CrmSurface = CrmTab;

export const RELATIONSHIP_VIEWS = ['organization', 'government', 'history'] as const;
export type RelationshipView = (typeof RELATIONSHIP_VIEWS)[number];

export const INTELLIGENCE_VIEWS = [
  'overview',
  'legislative',
  'regulatory',
  'funding',
  'footprint',
  'district',
] as const;
export type IntelligenceView = (typeof INTELLIGENCE_VIEWS)[number];

export type CrmView = RelationshipView | IntelligenceView;

export interface CrmRoute {
  tab: CrmSurface;
  /** Secondary view; `null` for tabs that have no second level. */
  view: CrmView | null;
  /**
   * True when the incoming URL used a legacy `tab` value (or an out-of-range
   * `view`) and the canonical form differs. The page rewrites the URL with
   * `replace: true` so Back does not bounce through the legacy spelling.
   */
  didNormalize: boolean;
}

export const DEFAULT_RELATIONSHIP_VIEW: RelationshipView = 'organization';
export const DEFAULT_INTELLIGENCE_VIEW: IntelligenceView = 'overview';

/**
 * Legacy `?tab=` values → canonical destination. From the contract verbatim;
 * `capabilities` is deliberately absent because it maps to itself.
 */
const LEGACY_TABS: Record<string, { tab: CrmSurface; view: CrmView | null }> = {
  activity: { tab: 'relationships', view: 'history' },
  people: { tab: 'relationships', view: 'organization' },
  targets: { tab: 'relationships', view: 'government' },
  facilities: { tab: 'intelligence', view: 'district' },
  documents: { tab: 'files', view: null },
  tracker: { tab: 'intelligence', view: 'legislative' },
  radar: { tab: 'intelligence', view: 'legislative' },
  legiwatch: { tab: 'intelligence', view: 'legislative' },
};

/** The secondary views a given tab accepts, and the one it defaults to. */
function viewsFor(tab: CrmSurface): { allowed: readonly string[]; fallback: CrmView } | null {
  if (tab === 'relationships') {
    return { allowed: RELATIONSHIP_VIEWS, fallback: DEFAULT_RELATIONSHIP_VIEW };
  }
  if (tab === 'intelligence') {
    return { allowed: INTELLIGENCE_VIEWS, fallback: DEFAULT_INTELLIGENCE_VIEW };
  }
  return null;
}

function isCanonicalTab(value: string): value is CrmSurface {
  return value === 'capabilities' || (CRM_TABS as readonly string[]).includes(value);
}

/**
 * Resolve `?tab=`/`?view=` into the view actually rendered.
 *
 * Never throws and never returns an unrenderable combination: unknown values
 * fall back to Overview rather than to a blank surface, because a stale
 * bookmark landing on an error page is worse than landing on the client.
 */
export function resolveCrmRoute(params: URLSearchParams | null | undefined): CrmRoute {
  const rawTab = params?.get('tab')?.trim().toLowerCase() ?? '';
  const rawView = params?.get('view')?.trim().toLowerCase() ?? '';

  const legacy = LEGACY_TABS[rawTab];
  if (legacy) {
    // A legacy tab owns its destination outright — `?tab=targets&view=history`
    // is not a thing anyone meant, so the mapping wins over a stray `view`.
    return { tab: legacy.tab, view: legacy.view, didNormalize: true };
  }

  if (!isCanonicalTab(rawTab)) {
    // Absent or unrecognised. Absent is the ordinary case (`/clients?clientId=…`)
    // and must not be reported as a normalization, or every plain client open
    // would push a redundant history entry.
    return { tab: 'overview', view: null, didNormalize: rawTab !== '' };
  }

  const views = viewsFor(rawTab);
  if (!views) {
    // Tab takes no secondary view; a leftover `view=` is dropped from the URL.
    return { tab: rawTab, view: null, didNormalize: rawView !== '' };
  }

  if (views.allowed.includes(rawView)) {
    return { tab: rawTab, view: rawView as CrmView, didNormalize: false };
  }
  return { tab: rawTab, view: views.fallback, didNormalize: true };
}

/**
 * Canonical query parameters for a route, applied onto the current ones so
 * `clientId` and any unrelated parameter survive tab changes.
 */
export function applyCrmRoute(current: URLSearchParams, route: { tab: CrmSurface; view?: CrmView | null }): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set('tab', route.tab);

  const views = viewsFor(route.tab);
  if (!views) {
    next.delete('view');
    return next;
  }
  const view = route.view && views.allowed.includes(route.view) ? route.view : views.fallback;
  next.set('view', view);
  return next;
}

/** Default secondary view when a tab is entered without one. */
export function defaultViewFor(tab: CrmSurface): CrmView | null {
  return viewsFor(tab)?.fallback ?? null;
}

export const CRM_TAB_LABELS: Array<{ key: CrmTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'capabilities', label: 'Capabilities' },
  { key: 'relationships', label: 'Relationships' },
  { key: 'work', label: 'Work' },
  { key: 'intelligence', label: 'Intelligence' },
  { key: 'files', label: 'Files' },
];

export const RELATIONSHIP_VIEW_LABELS: Array<{ key: RelationshipView; label: string }> = [
  { key: 'organization', label: 'Organization' },
  { key: 'government', label: 'Government relationships' },
  { key: 'history', label: 'Relationship history' },
];

export const INTELLIGENCE_VIEW_LABELS: Array<{ key: IntelligenceView; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'legislative', label: 'Legislative' },
  { key: 'regulatory', label: 'Regulatory' },
  { key: 'funding', label: 'Funding & Budget' },
  { key: 'footprint', label: 'Federal Footprint' },
  { key: 'district', label: 'District Nexus' },
];
