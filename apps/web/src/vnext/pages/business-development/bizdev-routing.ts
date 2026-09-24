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

/** Conflict/exclusion filter tri-state: '' any · 'excl' excluded · 'none' not excluded. */
export const BIZDEV_CONFLICT_FILTERS = ['', 'excl', 'none'] as const;
export type BizDevConflictFilter = (typeof BIZDEV_CONFLICT_FILTERS)[number];

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
  // ── Phase 2 (discover/dossier) ────────────────────────────────────────
  /** 'open' shows the Discover panel; '' (default) keeps the pipeline only. */
  discover: 'open' | '';
  /** Submitted discover search text (2..200 chars; only sent on explicit submit). */
  discoverQuery: string;
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
  discover: '',
  discoverQuery: '',
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
  const discoverOffset = clampInt(params.get('bdOffset'), 0, 500, 0);
  const dossierEntityId = params.get('bdDossier')?.trim() ?? '';
  const dossierProspectId = params.get('bdDossierProspect')?.trim() ?? '';
  const dossierSection = oneOf(params.get('bdSection'), BIZDEV_DOSSIER_SECTIONS);
  return {
    stage,
    ownerId,
    status,
    conflict,
    linkedClient,
    q,
    prospectId,
    discover,
    discoverQuery,
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
  if (route.discover !== undefined) {
    if (route.discover === 'open') next.set('bdDiscover', 'open');
    else next.delete('bdDiscover');
  }
  if (route.discoverQuery !== undefined) set('bdDq', route.discoverQuery);
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
      route.q,
  );
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
  limit: number;
  offset: number;
} {
  return {
    q: route.discoverQuery,
    limit: BIZDEV_DISCOVER_LIMIT_DEFAULT,
    offset: route.discoverOffset,
  };
}
