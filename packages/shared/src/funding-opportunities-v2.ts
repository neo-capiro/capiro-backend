export const OPPORTUNITY_SEARCH_MODES = ['matched', 'all'] as const;
export type OpportunitySearchMode = (typeof OPPORTUNITY_SEARCH_MODES)[number];

export const OPPORTUNITY_SOURCES_V2 = [
  'grants_gov',
  'sam_gov',
  'agency_forecast',
  'dibbs',
  'sbir_sttr',
  'ca_portal',
] as const;
export type OpportunitySourceV2 = (typeof OPPORTUNITY_SOURCES_V2)[number];

export const OPPORTUNITY_LIFECYCLES_V2 = ['active', 'forecast', 'closed', 'post_award'] as const;
export type OpportunityLifecycleV2 = (typeof OPPORTUNITY_LIFECYCLES_V2)[number];

export const OPPORTUNITY_TYPES_V2 = [
  'grant',
  'cooperative_agreement',
  'loan_assistance',
  'contract',
  'solicitation',
  'task_order_vehicle',
  'presolicitation',
  'sources_sought',
  'forecast',
  'award',
  'other',
] as const;
export type OpportunityTypeV2 = (typeof OPPORTUNITY_TYPES_V2)[number];

export const OPPORTUNITY_SORTS_V2 = [
  'deadline',
  'relevance',
  'title',
  'posted',
  'value',
  'agency',
  'updated',
] as const;
export type OpportunitySortV2 = (typeof OPPORTUNITY_SORTS_V2)[number];
export type OpportunitySortDirectionV2 = 'asc' | 'desc';
export const OPPORTUNITY_QUERY_MATCHES_V2 = ['keywords', 'phrase'] as const;
export type OpportunityQueryMatchV2 = (typeof OPPORTUNITY_QUERY_MATCHES_V2)[number];
export const MAX_OPPORTUNITY_KEYWORD_TERMS = 100;
export type SearchVisibilityV2 = 'private' | 'tenant';
export type OpportunityEligibilityV2 = 'eligible' | 'ineligible' | 'needs_review' | 'unknown';
export interface OpportunityClientCapabilityV2 {
  state: OpportunityEligibilityV2;
  allowed: boolean;
  reason: string;
}
export interface OpportunityProfileGapV2 {
  title: string;
  tag: string;
  tone: 'warn' | 'muted';
  body: string;
}
export interface OpportunityProfileGapsV2 {
  items: OpportunityProfileGapV2[];
  actualUnscoredCount: number | null;
  profileLink: string;
}
export type OpportunityPostedV2 =
  'last_7_days' | 'last_30_days' | 'last_90_days' | 'this_fiscal_year' | 'any';
export type OpportunityDeadlineWindowV2 = 'any' | '14d' | '30d' | '90d' | '180d';

export interface OpportunitySearchCriteriaV2 {
  schemaVersion: 2;
  mode: OpportunitySearchMode;
  clientId: string | null;
  query: string;
  /** Explicit new-search semantics. Omitted preserves legacy literal phrase matching. */
  queryMatch?: OpportunityQueryMatchV2;
  /** Independent search terms. An opportunity may match any one of these terms. */
  keywordTerms?: string[];
  sources: OpportunitySourceV2[];
  types: OpportunityTypeV2[];
  lifecycle: OpportunityLifecycleV2[];
  agencies: string[];
  sectors: string[];
  naicsCodes: string[];
  pscCodes: string[];
  setAsideCodes: string[];
  eligibility: OpportunityEligibilityV2[];
  posted: OpportunityPostedV2[];
  geography: string[];
  applicantTypes: string[];
  funding: string[];
  costShare: string[];
  methods: string[];
  disbursement: string[];
  grantPrerequisites: string[];
  codes: string[];
  deadlineWindow: OpportunityDeadlineWindowV2;
  deadlineFrom: string | null;
  deadlineTo: string | null;
  sort: OpportunitySortV2;
  direction: OpportunitySortDirectionV2;
  page: number;
  pageSize: number;
}

export interface OpportunityCriteriaWarning {
  key: string;
  reason: 'unsupported' | 'retired' | 'invalid';
}

export interface NormalizedOpportunitySearchCriteria {
  criteria: OpportunitySearchCriteriaV2;
  warnings: OpportunityCriteriaWarning[];
  unsupported: Record<string, unknown>;
}

export interface OpportunitySearchRecordV2 {
  id: string;
  source: OpportunitySourceV2;
  sourceRecordId: string;
  title: string;
  agency: string | null;
  sourceUrl: string | null;
  type: OpportunityTypeV2;
  lifecycle: OpportunityLifecycleV2;
  postedDate: string | null;
  deadline: string | null;
  closeOrArchiveDate: string | null;
  isPursuable: boolean;
  summary: string | null;
  naicsCodes: string[];
  pscCodes: string[];
  setAside: string | null;
  applicantTypes: string[];
  geography: string[];
  value: number | null;
  valueBasis: 'source_backed' | 'not_stated_by_source';
  sourceFacts: { provenance: string; [key: string]: unknown };
  relevanceScore: number | null;
  matchedSignals: Array<{
    signal: string;
    strength: 'strong' | 'moderate' | 'weak';
    matchedOn: string;
  }>;
  eligibility: { state: OpportunityEligibilityV2; reason: string } | null;
  clientId: string | null;
  /** Client-specific live capability; independent of display mode/ranking suppression. */
  clientCapability?: OpportunityClientCapabilityV2 | null;
  /** Bounded tenant/client workflow and bookmark decoration, when requested. */
  decoration?: import('./funding-opportunities-v2-workflow.js').OpportunityRecordDecorationV2;
}

export interface OpportunitySourceFreshnessV2 {
  source: OpportunitySourceV2;
  state:
    | 'current'
    | 'degraded'
    | 'stale'
    | 'never_synced'
    | 'initial_partial'
    | 'error_cached'
    | 'unavailable'
    | 'not_enabled'
    | 'unknown';
  recordCount: number | null;
  activeRecordCount: number | null;
  lastSyncedAt: string | null;
  /** Most recent attempt, including partial/error runs. */
  latestAttemptAt?: string | null;
  /** Most recent clean complete success, independent of the latest attempt. */
  lastSuccessAt?: string | null;
}

/** Stable response for the shell/source-health read; it is not narrowed by search criteria. */
export interface OpportunitySourceHealthResponseV2 {
  sources: OpportunitySourceFreshnessV2[];
  generatedAt: string;
}

export interface OpportunitySearchResponseV2 {
  criteria: OpportunitySearchCriteriaV2;
  opportunities: OpportunitySearchRecordV2[];
  page: number;
  pageSize: number;
  total: number | null;
  totalIsCapped: boolean;
  /** True only when every queried enabled source reports current catalog health. */
  catalogComplete: boolean;
  counts: {
    grants: number | null;
    contracts: number | null;
    active: number | null;
    closed: number | null;
  };
  mode: OpportunitySearchMode;
  clientId: string | null;
  freshness: OpportunitySourceFreshnessV2[];
  provenance: Array<{
    source: OpportunitySourceV2;
    queried: boolean;
    returned: number;
    count: number | null;
    capped: boolean;
  }>;
  emptyReason: string | null;
  /** Present only for matched searches with an authorized selected client. */
  profileGaps: OpportunityProfileGapsV2 | null;
  generatedAt: string;
}

export interface SavedSearchSummaryV2 {
  id: string;
  name: string;
  description: string | null;
  visibility: SearchVisibilityV2;
  clientId: string | null;
  criteria: OpportunitySearchCriteriaV2;
  warnings: OpportunityCriteriaWarning[];
  archivedAt: string | null;
  createdByUserId: string;
  updatedAt: string;
}

const DEFAULT_CRITERIA: OpportunitySearchCriteriaV2 = {
  schemaVersion: 2,
  mode: 'all',
  clientId: null,
  query: '',
  sources: [],
  types: [],
  lifecycle: ['active'],
  agencies: [],
  sectors: [],
  naicsCodes: [],
  pscCodes: [],
  setAsideCodes: [],
  eligibility: [],
  posted: [],
  geography: [],
  applicantTypes: [],
  funding: [],
  costShare: [],
  methods: [],
  disbursement: [],
  grantPrerequisites: [],
  codes: [],
  deadlineWindow: 'any',
  deadlineFrom: null,
  deadlineTo: null,
  sort: 'deadline',
  direction: 'asc',
  page: 1,
  pageSize: 20,
};

const SUPPORTED_KEYS = new Set([
  'schemaVersion',
  'mode',
  'clientId',
  'query',
  'queryMatch',
  'keywordTerms',
  'sources',
  'types',
  'lifecycle',
  'agencies',
  'sectors',
  'naicsCodes',
  'pscCodes',
  'setAsideCodes',
  'eligibility',
  'posted',
  'geography',
  'applicantTypes',
  'funding',
  'costShare',
  'methods',
  'disbursement',
  'grantPrerequisites',
  'codes',
  'deadlineFrom',
  'deadlineWindow',
  'deadlineTo',
  'sort',
  'direction',
  'page',
  'pageSize',
]);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}
function list(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map(text).filter(Boolean))];
}
function enumList<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  const allowedSet = new Set(allowed);
  return list(value).filter((item): item is T => allowedSet.has(item as T));
}

function enumListWithWarnings<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
  warnings: OpportunityCriteriaWarning[],
): T[] {
  const raw = list(value);
  const allowedSet = new Set(allowed);
  for (const item of raw) {
    if (!allowedSet.has(item as T)) warnings.push({ key: `${key}:${item}`, reason: 'invalid' });
  }
  return raw.filter((item): item is T => allowedSet.has(item as T));
}
function codeList(value: unknown): string[] {
  return [...new Set(list(value).map((item) => item.toUpperCase()))];
}
function keywordTerms(value: unknown, warnings: OpportunityCriteriaWarning[]): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 120) {
      warnings.push({ key: 'keywordTerms', reason: 'invalid' });
      continue;
    }
    const term = text(raw);
    const key = term.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      terms.push(term);
    }
  }
  if (terms.length > MAX_OPPORTUNITY_KEYWORD_TERMS) {
    warnings.push({ key: 'keywordTerms', reason: 'invalid' });
    return terms.slice(0, MAX_OPPORTUNITY_KEYWORD_TERMS);
  }
  return terms;
}
function isoOrNull(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function normalizeOpportunitySearchCriteria(
  input: unknown,
): NormalizedOpportunitySearchCriteria {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const warnings: OpportunityCriteriaWarning[] = [];
  const unsupported: Record<string, unknown> = {};
  const storedSchemaVersion = raw.schemaVersion;
  if (
    typeof storedSchemaVersion === 'number' &&
    Number.isFinite(storedSchemaVersion) &&
    storedSchemaVersion > 2
  ) {
    warnings.push({ key: 'schemaVersion', reason: 'unsupported' });
    unsupported.schemaVersion = storedSchemaVersion;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!SUPPORTED_KEYS.has(key) && value !== undefined) {
      warnings.push({ key, reason: 'unsupported' });
      unsupported[key] = value;
    }
  }
  const mode = OPPORTUNITY_SEARCH_MODES.includes(raw.mode as OpportunitySearchMode)
    ? (raw.mode as OpportunitySearchMode)
    : DEFAULT_CRITERIA.mode;
  const queryMatch = OPPORTUNITY_QUERY_MATCHES_V2.includes(
    raw.queryMatch as OpportunityQueryMatchV2,
  )
    ? (raw.queryMatch as OpportunityQueryMatchV2)
    : undefined;
  const lifecycleProvided = raw.lifecycle !== undefined;
  const lifecycle = enumListWithWarnings(
    raw.lifecycle,
    OPPORTUNITY_LIFECYCLES_V2,
    'lifecycle',
    warnings,
  );
  const sort = OPPORTUNITY_SORTS_V2.includes(raw.sort as OpportunitySortV2)
    ? (raw.sort as OpportunitySortV2)
    : DEFAULT_CRITERIA.sort;
  const deadlineWindow = ['any', '14d', '30d', '90d', '180d'].includes(String(raw.deadlineWindow))
    ? (String(raw.deadlineWindow) as OpportunityDeadlineWindowV2)
    : DEFAULT_CRITERIA.deadlineWindow;
  const direction: OpportunitySortDirectionV2 = raw.direction === 'desc' ? 'desc' : 'asc';
  const page = Math.min(Math.max(Number(raw.page) || 1, 1), 10_000);
  const pageSize = Math.min(Math.max(Number(raw.pageSize) || 20, 1), 100);
  const client = text(raw.clientId);
  const criteria: OpportunitySearchCriteriaV2 = {
    schemaVersion: 2,
    mode,
    clientId: client || null,
    query: text(raw.query),
    ...(queryMatch ? { queryMatch } : {}),
    keywordTerms: keywordTerms(raw.keywordTerms, warnings),
    sources: enumListWithWarnings(raw.sources, OPPORTUNITY_SOURCES_V2, 'sources', warnings),
    types: enumListWithWarnings(raw.types, OPPORTUNITY_TYPES_V2, 'types', warnings),
    lifecycle: lifecycleProvided ? lifecycle : DEFAULT_CRITERIA.lifecycle,
    agencies: list(raw.agencies),
    sectors: list(raw.sectors),
    naicsCodes: codeList(raw.naicsCodes),
    pscCodes: codeList(raw.pscCodes),
    setAsideCodes: codeList(raw.setAsideCodes),
    eligibility: enumListWithWarnings(
      raw.eligibility,
      ['eligible', 'ineligible', 'needs_review', 'unknown'] as const,
      'eligibility',
      warnings,
    ),
    posted: enumListWithWarnings(
      raw.posted,
      ['last_7_days', 'last_30_days', 'last_90_days', 'this_fiscal_year', 'any'] as const,
      'posted',
      warnings,
    ),
    geography: list(raw.geography),
    applicantTypes: list(raw.applicantTypes),
    funding: list(raw.funding),
    costShare: list(raw.costShare),
    methods: list(raw.methods),
    disbursement: list(raw.disbursement),
    grantPrerequisites: list(raw.grantPrerequisites),
    codes: codeList(raw.codes),
    deadlineWindow,
    deadlineFrom: isoOrNull(raw.deadlineFrom),
    deadlineTo: isoOrNull(raw.deadlineTo),
    sort,
    direction,
    page,
    pageSize,
  };
  if (raw.mode !== undefined && mode !== raw.mode)
    warnings.push({ key: 'mode', reason: 'invalid' });
  if (raw.queryMatch !== undefined && queryMatch === undefined)
    warnings.push({ key: 'queryMatch', reason: 'invalid' });
  if (queryMatch && criteria.query.length > 512) warnings.push({ key: 'query', reason: 'invalid' });
  if (
    queryMatch === 'keywords' &&
    new Set(
      (criteria.query.match(/"([^"]*)"|(\S+)/g) ?? [])
        .map((term) => term.replace(/^"|"$/g, '').trim().toLowerCase())
        .filter(Boolean),
    ).size > 20
  )
    warnings.push({ key: 'query', reason: 'invalid' });
  if (
    lifecycleProvided &&
    lifecycle.length === 0 &&
    Array.isArray(raw.lifecycle) &&
    raw.lifecycle.length > 0
  )
    warnings.push({ key: 'lifecycle', reason: 'invalid' });
  if (raw.sort !== undefined && sort !== raw.sort)
    warnings.push({ key: 'sort', reason: 'invalid' });
  if (raw.deadlineWindow !== undefined && deadlineWindow !== raw.deadlineWindow)
    warnings.push({ key: 'deadlineWindow', reason: 'invalid' });
  if (raw.deadlineFrom != null && criteria.deadlineFrom == null)
    warnings.push({ key: 'deadlineFrom', reason: 'invalid' });
  if (raw.deadlineTo != null && criteria.deadlineTo == null)
    warnings.push({ key: 'deadlineTo', reason: 'invalid' });
  return { criteria, warnings, unsupported };
}
