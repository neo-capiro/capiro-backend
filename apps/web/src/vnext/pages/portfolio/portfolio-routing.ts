/**
 * Portfolio index route state (PORTFOLIO-HANDOFF §6, §7.1).
 *
 * The Portfolio index is the all-clients surface. Its URL state is a query
 * string so browser Back/Forward, refresh and shared links all restore the
 * exact list the user was looking at:
 *
 *   /portfolio                          index, defaults
 *   /portfolio?q=…&status=…&sort=…&layout=…
 *   /portfolio?modal=import-lda         Import-with-LDA review overlay
 *
 * Client routes stay at the canonical `/clients?clientId=<id>` — see
 * `client-crm-routing.ts`. This module owns only the index-level params.
 */

export const PORTFOLIO_STATUSES = ['all', 'active', 'at-risk', 'prospect'] as const;
export type PortfolioStatus = (typeof PORTFOLIO_STATUSES)[number];

export const PORTFOLIO_SORTS = ['attention', 'readiness', 'name'] as const;
export type PortfolioSort = (typeof PORTFOLIO_SORTS)[number];

export const PORTFOLIO_LAYOUTS = ['list', 'cards'] as const;
export type PortfolioLayout = (typeof PORTFOLIO_LAYOUTS)[number];

export interface PortfolioRoute {
  q: string;
  status: PortfolioStatus;
  sort: PortfolioSort;
  layout: PortfolioLayout;
  /** True when any param was absent/invalid and had to be normalised. */
  didNormalize: boolean;
}

const DEFAULTS: PortfolioRoute = {
  q: '',
  status: 'all',
  sort: 'attention',
  layout: 'list',
  didNormalize: false,
};

function isStatus(v: string): v is PortfolioStatus {
  return (PORTFOLIO_STATUSES as readonly string[]).includes(v);
}
function isSort(v: string): v is PortfolioSort {
  return (PORTFOLIO_SORTS as readonly string[]).includes(v);
}
function isLayout(v: string): v is PortfolioLayout {
  return (PORTFOLIO_LAYOUTS as readonly string[]).includes(v);
}

/** Resolve `?q/status/sort/layout` into the rendered list state. Never throws. */
export function resolvePortfolioRoute(params: URLSearchParams | null | undefined): PortfolioRoute {
  if (!params) return DEFAULTS;
  const q = (params.get('q') ?? '').trim();
  const rawStatus = params.get('status')?.trim().toLowerCase() ?? '';
  const rawSort = params.get('sort')?.trim().toLowerCase() ?? '';
  const rawLayout = params.get('layout')?.trim().toLowerCase() ?? '';

  const status = isStatus(rawStatus) ? rawStatus : DEFAULTS.status;
  const sort = isSort(rawSort) ? rawSort : DEFAULTS.sort;
  const layout = isLayout(rawLayout) ? rawLayout : DEFAULTS.layout;

  const didNormalize =
    (rawStatus !== '' && rawStatus !== status) ||
    (rawSort !== '' && rawSort !== sort) ||
    (rawLayout !== '' && rawLayout !== layout);

  return { q, status, sort, layout, didNormalize };
}

/** Canonical query params for a route, preserving unrelated params. */
export function applyPortfolioRoute(
  current: URLSearchParams,
  route: Partial<Omit<PortfolioRoute, 'didNormalize'>>,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (route.q !== undefined) {
    if (route.q.trim()) next.set('q', route.q.trim());
    else next.delete('q');
  }
  if (route.status !== undefined) {
    if (route.status === DEFAULTS.status) next.delete('status');
    else next.set('status', route.status);
  }
  if (route.sort !== undefined) {
    if (route.sort === DEFAULTS.sort) next.delete('sort');
    else next.set('sort', route.sort);
  }
  if (route.layout !== undefined) {
    if (route.layout === DEFAULTS.layout) next.delete('layout');
    else next.set('layout', route.layout);
  }
  return next;
}

export const PORTFOLIO_STATUS_LABELS: Array<{ key: PortfolioStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'at-risk', label: 'At risk' },
  { key: 'prospect', label: 'Prospect' },
];

export const PORTFOLIO_SORT_LABELS: Array<{ key: PortfolioSort; label: string }> = [
  { key: 'attention', label: 'Attention' },
  { key: 'readiness', label: 'Readiness' },
  { key: 'name', label: 'Name' },
];
