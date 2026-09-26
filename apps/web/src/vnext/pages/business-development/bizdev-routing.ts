/**
 * Business Development Phase 1 — URL state for the Portfolio sub-view.
 *
 * The Portfolio index lives at `/clients` on a query-string route (see
 * portfolio-routing.ts): no `/clients/:id` exists and `?clientId=<id>` opens
 * the client profile. Business Development is a second VIEW of the same
 * index URL:
 *
 *   /clients?view=business-development            pipeline, default filters
 *   /clients?view=business-development&bdStage=qualified&bdOwner=<uuid>…
 *   /clients?view=business-development&bdProspect=<uuid>   detail drawer
 *
 * Every filter and the selected prospect live in the URL so reload, Back,
 * Forward and shared links all restore the exact pipeline the user saw.
 * `?clientId=` keeps its profile meaning and takes precedence over views;
 * `q`, `status`, `sort`, `layout` (the Clients-view params) are left
 * untouched so switching views and back never loses the other side's state.
 */

export const BIZDEV_VIEW = 'business-development';

/** Exact default stages returned by the backend DTO contract. */
export const BIZDEV_STAGES = [
  'researching',
  'qualified',
  'outreach',
  'meeting',
  'proposal',
  'won',
  'lost',
  'parked',
] as const;
export type BizDevStage = (typeof BIZDEV_STAGES)[number];

export const BIZDEV_STAGE_LABELS: Record<BizDevStage, string> = {
  researching: 'Researching',
  qualified: 'Qualified',
  outreach: 'Outreach',
  meeting: 'Meeting',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
  parked: 'Parked',
};

export const BIZDEV_STATUSES = ['active', 'dismissed', 'all'] as const;
export type BizDevStatus = (typeof BIZDEV_STATUSES)[number];

export const BIZDEV_STATUS_LABELS: Record<BizDevStatus, string> = {
  active: 'Active',
  dismissed: 'Dismissed',
  all: 'All',
};

/**
 * v5 in-page views. `bdView` is the canonical URL param; the legacy
 * `bdDiscover=open` URL keeps resolving to the Discover view (below), so
 * every existing shared link still restores exactly what it did before.
 */
export const BIZDEV_VIEWS = ['pipeline', 'discover', 'watchlist'] as const;
export type BizDevView = (typeof BIZDEV_VIEWS)[number];

export const BIZDEV_VIEW_LABELS: Record<BizDevView, string> = {
  pipeline: 'Pipeline',
  discover: 'Discover',
  watchlist: 'Watchlist',
};

/** Conflict/exclusion filter tri-state: '' any · 'excl' excluded · 'none' not excluded. */
export const BIZDEV_CONFLICT_FILTERS = ['', 'excl', 'none'] as const;
export type BizDevConflictFilter = (typeof BIZDEV_CONFLICT_FILTERS)[number];

/**
 * Sort controls (v5 prototype): 'newest first' uses createdAt, 'due date'
 * uses nextActionDueAt. There is no priority field in the API, so no
 * priority sort exists — the prototype's third option is deliberately absent.
 */
export const BIZDEV_SORTS = ['newest', 'due'] as const;
export type BizDevSort = (typeof BIZDEV_SORTS)[number];

export const BIZDEV_SORT_LABELS: Record<BizDevSort, string> = {
  newest: 'Sort: newest first',
  due: 'Sort: due date',
};

/** Linked-client filter tri-state: '' any · 'yes' already a client · 'no' not yet. */
export const BIZDEV_CLIENT_FILTERS = ['', 'yes', 'no'] as const;
export type BizDevClientFilter = (typeof BIZDEV_CLIENT_FILTERS)[number];

export interface BizDevRoute {
  stage: BizDevStage | '';
  ownerId: string;
  status: BizDevStatus;
  conflict: BizDevConflictFilter;
  linkedClient: BizDevClientFilter;
  q: string;
  prospectId: string;
  /** In-page view (v5): 'pipeline' (default) | 'discover' | 'watchlist'. */
  view: BizDevView;
  /** Overdue-only derived toggle (client-side from nextActionDueAt). */
  overdueOnly: boolean;
  /** Sort (v5): 'newest' (createdAt desc, default) | 'due' (due date asc, nulls last). */
  sort: BizDevSort;
  // ── Phase 2 (discover/dossier) ────────────────────────────────────────
  /** Legacy param ('open' = discover view); kept writable for compatibility. */
  discover: 'open' | '';
  /** Submitted discover search text (2..200 chars; only sent on explicit submit). */
  discoverQuery: string;
  /** Submitted discover service filter (case-insensitive exact match of this firm's saved prospect.serviceHypothesis; '' = All services). */
  discoverService: string;
  /** Submitted discover exclusions review mode: true = include firm-excluded candidates for review. */
  discoverIncludeExcluded: boolean;
  /** Stable numeric offset for discover paging (0..500). */
  discoverOffset: number;
  /** Dossier subject: canonical entity id (company dossier) when set. */
  dossierEntityId: string;
  /** Dossier subject: prospect id (prospect dossier) when set. */
  dossierProspectId: string;
  /** Selected dossier section ('' = all/none selected). */
  dossierSection: BizDevDossierSection | '';
}

const DEFAULTS: BizDevRoute = {
  stage: '',
  ownerId: '',
  status: 'active',
  conflict: '',
  linkedClient: '',
  q: '',
  prospectId: '',
  view: 'pipeline',
  overdueOnly: false,
  sort: 'newest',
  discover: '',
  discoverQuery: '',
  discoverService: '',
  discoverIncludeExcluded: false,
  discoverOffset: 0,
  dossierEntityId: '',
  dossierProspectId: '',
  dossierSection: '',
};

/** Exact dossier section kinds from the backend DTO contract. */
export const BIZDEV_DOSSIER_SECTIONS = [
  'identity',
  'government_exposure',
  'relevant_signals',
  'footprint',
  'lobbying',
  'people',
] as const;
export type BizDevDossierSection = (typeof BIZDEV_DOSSIER_SECTIONS)[number];

export const BIZDEV_DOSSIER_SECTION_LABELS: Record<BizDevDossierSection, string> = {
  identity: 'Identity',
  government_exposure: 'Government exposure',
  relevant_signals: 'Relevant signals',
  footprint: 'Footprint',
  lobbying: 'Lobbying',
  people: 'People',
};

/** Discover page size options (backend caps limit at 25). */
export const BIZDEV_DISCOVER_LIMIT_OPTIONS = [10, 20, 25] as const;
export const BIZDEV_DISCOVER_LIMIT_DEFAULT = 20;

function oneOf<T extends string>(raw: string | null, allowed: readonly T[]): T | '' {
  const value = raw?.trim() ?? '';
  return (allowed as readonly string[]).includes(value) ? (value as T) : '';
}

/** Clamp a numeric URL param into [min, max]; NaN → fallback. */
function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** True when the Portfolio index URL selects the Business Development view. */
export function isBizDevView(params: URLSearchParams | null | undefined): boolean {
  return params?.get('view') === BIZDEV_VIEW;
}

/** Resolve the bd* params into pipeline state. Never throws; invalid → default. */
export function resolveBizDevRoute(params: URLSearchParams | null | undefined): BizDevRoute {
  if (!params) return DEFAULTS;
  const stage = oneOf(params.get('bdStage'), BIZDEV_STAGES);
  const status = oneOf(params.get('bdStatus'), BIZDEV_STATUSES) || DEFAULTS.status;
  const conflict = oneOf(params.get('bdConflict'), BIZDEV_CONFLICT_FILTERS);
  const linkedClient = oneOf(params.get('bdClient'), BIZDEV_CLIENT_FILTERS);
  const ownerId = params.get('bdOwner')?.trim() ?? '';
  const q = (params.get('bdQ') ?? '').trim();
  const prospectId = params.get('bdProspect')?.trim() ?? '';
  const discover = params.get('bdDiscover') === 'open' ? 'open' : '';
  const discoverQuery = (params.get('bdDq') ?? '').trim().slice(0, 200);
  const discoverService = (params.get('bdDService') ?? '').trim().slice(0, 200);
  const discoverIncludeExcluded = params.get('bdDExcluded') === '1';
  const discoverOffset = clampInt(params.get('bdOffset'), 0, 500, 0);
  const dossierEntityId = params.get('bdDossier')?.trim() ?? '';
  const dossierProspectId = params.get('bdDossierProspect')?.trim() ?? '';
  const dossierSection = oneOf(params.get('bdSection'), BIZDEV_DOSSIER_SECTIONS);
  // v5 view: bdView is canonical; bdDiscover=open (legacy) maps to Discover.
  const viewParam = oneOf(params.get('bdView'), BIZDEV_VIEWS);
  const view: BizDevView = viewParam || (discover === 'open' ? 'discover' : 'pipeline');
  const overdueOnly = params.get('bdOverdue') === '1';
  const sort: BizDevSort = oneOf(params.get('bdSort'), BIZDEV_SORTS) || DEFAULTS.sort;
  return {
    stage,
    ownerId,
    status,
    conflict,
    linkedClient,
    q,
    prospectId,
    view,
    overdueOnly,
    sort,
    discover,
    discoverQuery,
    discoverService,
    discoverIncludeExcluded,
    discoverOffset,
    dossierEntityId,
    dossierProspectId,
    dossierSection,
  };
}

/** Canonical query params for the route, preserving unrelated params. */
export function applyBizDevRoute(
  current: URLSearchParams,
  route: Partial<BizDevRoute>,
): URLSearchParams {
  const next = new URLSearchParams(current);
  const set = (key: string, value: string) => {
    if (value) next.set(key, value);
    else next.delete(key);
  };
  if (route.stage !== undefined) set('bdStage', route.stage);
  if (route.ownerId !== undefined) set('bdOwner', route.ownerId);
  if (route.status !== undefined) {
    if (route.status === DEFAULTS.status) next.delete('bdStatus');
    else next.set('bdStatus', route.status);
  }
  if (route.conflict !== undefined) set('bdConflict', route.conflict);
  if (route.linkedClient !== undefined) set('bdClient', route.linkedClient);
  if (route.q !== undefined) set('bdQ', route.q);
  if (route.prospectId !== undefined) set('bdProspect', route.prospectId);
  if (route.view !== undefined) {
    if (route.view === 'pipeline') next.delete('bdView');
    else next.set('bdView', route.view);
  }
  if (route.overdueOnly !== undefined) {
    if (route.overdueOnly) next.set('bdOverdue', '1');
    else next.delete('bdOverdue');
  }
  if (route.sort !== undefined) {
    if (route.sort === DEFAULTS.sort) next.delete('bdSort');
    else next.set('bdSort', route.sort);
  }
  if (route.discover !== undefined) {
    if (route.discover === 'open') next.set('bdDiscover', 'open');
    else next.delete('bdDiscover');
  }
  if (route.discoverQuery !== undefined) set('bdDq', route.discoverQuery);
  if (route.discoverService !== undefined) set('bdDService', route.discoverService);
  if (route.discoverIncludeExcluded !== undefined) {
    if (route.discoverIncludeExcluded) next.set('bdDExcluded', '1');
    else next.delete('bdDExcluded');
  }
  if (route.discoverOffset !== undefined) {
    if (route.discoverOffset > 0) next.set('bdOffset', String(route.discoverOffset));
    else next.delete('bdOffset');
  }
  if (route.dossierEntityId !== undefined) set('bdDossier', route.dossierEntityId);
  if (route.dossierProspectId !== undefined) set('bdDossierProspect', route.dossierProspectId);
  if (route.dossierSection !== undefined) set('bdSection', route.dossierSection);
  return next;
}

/** The list-endpoint query object for a resolved route. */
export function bizDevListQuery(route: BizDevRoute): {
  status: BizDevStatus;
  stage?: BizDevStage;
  ownerId?: string;
  conflictExcluded?: boolean;
  linkedClient?: boolean;
  search?: string;
} {
  const query: ReturnType<typeof bizDevListQuery> = { status: route.status };
  if (route.stage) query.stage = route.stage;
  if (route.ownerId) query.ownerId = route.ownerId;
  if (route.conflict === 'excl') query.conflictExcluded = true;
  if (route.conflict === 'none') query.conflictExcluded = false;
  if (route.linkedClient === 'yes') query.linkedClient = true;
  if (route.linkedClient === 'no') query.linkedClient = false;
  if (route.q) query.search = route.q;
  return query;
}

/** True when any non-default filter is applied (drives "clear filters"). */
export function hasBizDevFilters(route: BizDevRoute): boolean {
  return Boolean(
    route.stage ||
      route.ownerId ||
      route.status !== 'active' ||
      route.conflict ||
      route.linkedClient ||
      route.q ||
      route.overdueOnly,
  );
}

/**
 * Prototype-order comparator. 'newest' sorts by createdAt descending; 'due'
 * sorts by nextActionDueAt ascending with null/invalid dates last. Ties break
 * deterministically on createdAt then id so ordering never flickers.
 */
export function compareBizDevProspectsForSort(
  a: { id: string; createdAt: string; nextActionDueAt: string | null },
  b: { id: string; createdAt: string; nextActionDueAt: string | null },
  sort: BizDevSort,
): number {
  if (sort === 'due') {
    const aDue = a.nextActionDueAt ? Date.parse(a.nextActionDueAt) : NaN;
    const bDue = b.nextActionDueAt ? Date.parse(b.nextActionDueAt) : NaN;
    const aNull = !Number.isFinite(aDue);
    const bNull = !Number.isFinite(bDue);
    if (aNull !== bNull) return aNull ? 1 : -1;
    if (!aNull && aDue !== bDue) return aDue - bDue;
  }
  const aCreated = Date.parse(a.createdAt) || 0;
  const bCreated = Date.parse(b.createdAt) || 0;
  if (aCreated !== bCreated) return bCreated - aCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Derived overdue check: a prospect with a next-action due date in the past
 * is overdue. Purely computed from the already-loaded nextActionDueAt value —
 * there is no priority or overdue field in the API.
 */
export function isBizDevOverdue(nextActionDueAt: string | null | undefined, now = Date.now()): boolean {
  if (!nextActionDueAt) return false;
  const due = new Date(nextActionDueAt).getTime();
  return Number.isFinite(due) && due < now;
}

/**
 * The bounded candidate-search query object for a resolved route.
 *
 * agency/issue/geography are deliberately absent: the backend reports them
 * as unsupported filters (coverage.unsupportedFilters) and the UI must never
 * present them as working filters. q is only ever non-empty after an explicit
 * submit (min 2 chars); offset is the stable numeric page anchor (0..500).
 */
export function bizDevDiscoverQuery(route: BizDevRoute): {
  q: string;
  service?: string;
  /** Strictly '0' | '1' as serialized to the backend; default '0'. */
  includeExcluded: '0' | '1';
  limit: number;
  offset: number;
} {
  return {
    q: route.discoverQuery,
    ...(route.discoverService ? { service: route.discoverService } : {}),
    includeExcluded: route.discoverIncludeExcluded ? '1' : '0',
    limit: BIZDEV_DISCOVER_LIMIT_DEFAULT,
    offset: route.discoverOffset,
  };
}
