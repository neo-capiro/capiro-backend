/**
 * Business Development Phase 1 — typed API functions over the actual
 * uncommitted contract in apps/api/src/business-development (controller +
 * DTOs are the source of truth; nothing here guesses an endpoint shape).
 *
 * All data is tenant-scoped server-side; nothing is ever written to
 * localStorage. Query keys embed the full filter/detail identity so views
 * can never share stale cross-filter data.
 */
import type { AxiosInstance } from 'axios';
import type { BizDevStage } from './bizdev-routing.js';

// ── shapes ─────────────────────────────────────────────────────────────

export interface BizDevCanonicalRef {
  id: string;
  canonicalName: string;
  normalizedName: string;
  entityType: string;
}

export interface BizDevLinkedClientRef {
  id: string;
  name: string;
  status: string;
}

/** GET /api/business-development/prospects row (service prospectSelect). */
export interface BizDevProspect {
  id: string;
  tenantId: string;
  canonicalEntityId: string | null;
  displayName: string;
  domain: string | null;
  website: string | null;
  description: string | null;
  serviceHypothesis: string | null;
  geography: string | null;
  ownerUserId: string | null;
  stage: BizDevStage;
  status: 'active' | 'dismissed';
  dismissedAt: string | null;
  conflictExcluded: boolean;
  /** Sensitive, firm-private. Never in a URL, label, or shared cache. */
  conflictReason: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  linkedClientId: string | null;
  convertedAt: string | null;
  watchRequested: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  canonicalEntity: BizDevCanonicalRef | null;
  linkedClient: BizDevLinkedClientRef | null;
}

export interface BizDevListResult {
  prospects: BizDevProspect[];
  counts: {
    visible: number;
    total: number;
    active: number;
    dismissed: number;
    byStage: Record<string, number>;
  };
}

export interface BizDevActivity {
  id: string;
  tenantId: string;
  prospectId: string;
  actorUserId: string | null;
  kind: string;
  body: string;
  beforeJsonb: unknown;
  afterJsonb: unknown;
  createdAt: string;
}

export interface BizDevMemberOption {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

export interface BizDevCanonicalOrganization {
  id: string;
  canonicalName: string;
  normalizedName: string;
  identityScope: string;
  tenantId: string | null;
}

export interface BizDevClientCandidate {
  id: string;
  name: string;
  canonicalEntityId: string | null;
}

export interface BizDevPreferences {
  id: string;
  tenantId: string;
  practiceServiceAreas: string[];
  agenciesIssues: string[];
  geographies: string[];
}

export interface BizDevConvertResult {
  prospect: BizDevProspect;
  client: { id: string; name: string };
  created: boolean;
}

export type BizDevResolveIdentityResult =
  | { outcome: 'resolved'; prospect: BizDevProspect }
  | {
      outcome: 'duplicate';
      duplicate: {
        prospectId: string;
        status: 'active' | 'dismissed';
        displayName: string;
        linkedClientId: string | null;
      };
    };

export interface BizDevDuplicateHint {
  id: string;
  displayName: string;
  domain: string | null;
  website: string | null;
  canonicalEntityId: string | null;
  stage: string;
  status: 'active' | 'dismissed';
  linkedClientId: string | null;
  ownerUserId: string | null;
  updatedAt: string;
}

// ── list / detail ──────────────────────────────────────────────────────

export function listBizDevProspects(
  api: AxiosInstance,
  query: {
    status?: 'active' | 'dismissed' | 'all';
    stage?: BizDevStage;
    ownerId?: string;
    conflictExcluded?: boolean;
    linkedClient?: boolean;
    search?: string;
  },
) {
  return api
    .get<BizDevListResult>('/api/business-development/prospects', { params: query })
    .then((r) => r.data);
}

export function getBizDevProspect(api: AxiosInstance, id: string) {
  return api.get<BizDevProspect>(`/api/business-development/prospects/${id}`).then((r) => r.data);
}

export function getBizDevHistory(api: AxiosInstance, id: string) {
  return api
    .get<BizDevActivity[]>(`/api/business-development/prospects/${id}/history`)
    .then((r) => r.data);
}

export function getBizDevDuplicateHints(api: AxiosInstance, id: string) {
  return api
    .get<{ hints: BizDevDuplicateHint[] }>(
      `/api/business-development/prospects/${id}/duplicate-hints`,
    )
    .then((r) => r.data);
}

// ── mutations ──────────────────────────────────────────────────────────

export interface BizDevCreateInput {
  canonicalEntityId?: string;
  displayName: string;
  domain?: string;
  website?: string;
  description?: string;
  serviceHypothesis?: string;
  geography?: string;
  ownerUserId?: string;
  stage?: BizDevStage;
}

export function createBizDevProspect(api: AxiosInstance, input: BizDevCreateInput) {
  return api.post<BizDevProspect>('/api/business-development/prospects', input).then((r) => r.data);
}

export function previewBizDevDuplicateHints(
  api: AxiosInstance,
  input: {
    displayName: string;
    domain?: string;
    website?: string;
    canonicalEntityId?: string;
  },
) {
  return api
    .post<{ hints: BizDevDuplicateHint[] }>('/api/business-development/duplicate-hints', input)
    .then((response) => response.data);
}

export interface BizDevUpdateInput {
  displayName?: string;
  domain?: string;
  website?: string;
  description?: string;
  serviceHypothesis?: string;
  geography?: string;
  ownerUserId?: string | null;
  stage?: BizDevStage;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  watchRequested?: boolean;
}

export function updateBizDevProspect(api: AxiosInstance, id: string, input: BizDevUpdateInput) {
  return api
    .patch<BizDevProspect>(`/api/business-development/prospects/${id}`, input)
    .then((r) => r.data);
}

export function addBizDevNote(api: AxiosInstance, id: string, body: string) {
  return api
    .post<BizDevActivity[]>(`/api/business-development/prospects/${id}/notes`, { body })
    .then((r) => r.data);
}

export function dismissBizDevProspect(api: AxiosInstance, id: string, reason?: string) {
  return api
    .post<BizDevProspect>(`/api/business-development/prospects/${id}/dismiss`, {
      ...(reason ? { reason } : {}),
    })
    .then((r) => r.data);
}

export function restoreBizDevProspect(api: AxiosInstance, id: string) {
  return api
    .post<BizDevProspect>(`/api/business-development/prospects/${id}/restore`)
    .then((r) => r.data);
}

export function updateBizDevConflict(
  api: AxiosInstance,
  id: string,
  input: { conflictExcluded: boolean; conflictReason?: string },
) {
  return api
    .put<BizDevProspect>(`/api/business-development/prospects/${id}/conflict`, input)
    .then((r) => r.data);
}

export function resolveBizDevIdentity(api: AxiosInstance, id: string, canonicalEntityId: string) {
  return api
    .post<BizDevResolveIdentityResult>(`/api/business-development/prospects/${id}/identity`, {
      canonicalEntityId,
    })
    .then((r) => r.data);
}

export function convertBizDevProspect(
  api: AxiosInstance,
  id: string,
  input: { existingClientId?: string; clientWebsite?: string; clientDescription?: string } = {},
) {
  return api
    .post<BizDevConvertResult>(`/api/business-development/prospects/${id}/convert`, input)
    .then((r) => r.data);
}

// ── options / search / preferences ─────────────────────────────────────

export function getBizDevMemberOptions(api: AxiosInstance) {
  return api
    .get<{ members: BizDevMemberOption[] }>('/api/business-development/member-options')
    .then((r) => r.data.members);
}

export function searchBizDevCanonicalOrganizations(api: AxiosInstance, q: string) {
  return api
    .get<{ results: BizDevCanonicalOrganization[] }>(
      '/api/business-development/search/canonical-organizations',
      { params: { q } },
    )
    .then((r) => r.data.results);
}

export function searchBizDevClients(api: AxiosInstance, q: string) {
  return api
    .get<{ results: BizDevClientCandidate[] }>('/api/business-development/search/clients', {
      params: { q },
    })
    .then((r) => r.data.results);
}

export function getBizDevPreferences(api: AxiosInstance) {
  return api
    .get<BizDevPreferences | null>('/api/business-development/preferences')
    .then((r) => r.data);
}

export function saveBizDevPreferences(
  api: AxiosInstance,
  input: { practiceServiceAreas: string[]; agenciesIssues: string[]; geographies: string[] },
) {
  return api
    .put<BizDevPreferences>('/api/business-development/preferences', input)
    .then((r) => r.data);
}

// ── Phase 5 — prospect watch & alerts (feature-gated contract) ─────────
//
// These functions freeze the expected Phase 5 endpoint contracts. The
// backend ships them behind its own feature flag; the web layer only calls
// them when the Phase 5 feature flag is enabled, and every response is read
// through resilient/optional shapes so a partially rolled-out backend or an
// older cached build never crashes the drawer. This UI performs NO provider
// ingestion, fetching or external polling of its own — the backend's watch
// pipeline is the only source of checks and alerts.

/** Watch lifecycle statuses (exact API enum; unknown values render honestly). */
export type BizDevWatchStatus = 'active' | 'paused' | 'ended';

/** Per-source health reported by GET .../watch (`sources` list). */
export type BizDevWatchSourceHealth = 'pending' | 'healthy' | 'partial' | 'error' | 'stale' | 'paused';

export interface BizDevWatchSource {
  source: string;
  health: BizDevWatchSourceHealth;
  /** ISO timestamp of the last completed check; null until one completes. */
  lastCheckedAt: string | null;
  /** Server-provided, human-readable explanation for non-healthy states. */
  detail: string | null;
}

/** GET /api/business-development/prospects/:prospectId/watch response. */
export interface BizDevProspectWatch {
  /** null = no watch exists yet for this prospect. */
  watch: {
    status: BizDevWatchStatus;
    categories: string[];
    ownerUserId: string | null;
    mutedUntil: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  sources: BizDevWatchSource[];
  /** ISO timestamp of the last fully completed check cycle, if any. */
  lastCompletedCheckAt: string | null;
}

export interface BizDevActivateWatchInput {
  categories?: string[];
  ownerUserId?: string;
}

export interface BizDevUpdateWatchInput {
  status?: BizDevWatchStatus;
  mutedUntil?: string | null;
  categories?: string[];
  ownerUserId?: string;
}

/** POST .../watch — activates an existing watch or creates one. */
export function activateBizDevWatch(api: AxiosInstance, prospectId: string, input: BizDevActivateWatchInput = {}) {
  return api
    .post<BizDevProspectWatch>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/watch`,
      input,
    )
    .then((r) => r.data);
}

/** PATCH .../watch — pause/resume/end, mute, categories or owner. */
export function updateBizDevWatch(api: AxiosInstance, prospectId: string, input: BizDevUpdateWatchInput) {
  return api
    .patch<BizDevProspectWatch>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/watch`,
      input,
    )
    .then((r) => r.data);
}

export function getBizDevProspectWatch(api: AxiosInstance, prospectId: string) {
  return api
    .get<BizDevProspectWatch>(`/api/business-development/prospects/${encodeURIComponent(prospectId)}/watch`)
    .then((r) => r.data);
}

/** One alert row (resilient: optional fields stay absent-safe in the UI). */
export interface BizDevProspectAlert {
  id: string;
  prospectId: string;
  title: string;
  summary: string | null;
  /** Materiality in words; never implied by color alone. */
  materiality: string | null;
  /** Raw materiality enum, kept internal; the text above is what users read. */
  materialityLevel: string | null;
  company: string | null;
  /** Canonical source identity: which watched source family produced it. */
  sourceFamily: string | null;
  /** Watch/source category the alert belongs to (canonical name: category). */
  category: string | null;
  /** When the underlying event happened / takes effect (canonical: eventAt/effectiveAt). */
  eventAt: string | null;
  effectiveAt: string | null;
  /** When the source published it / when Capiro first observed it (canonical: publishedAt/firstObservedAt). */
  publishedAt: string | null;
  firstObservedAt: string | null;
  /** Exact deep link to the original source record (canonical: sourceLocator). */
  sourceLocator: string | null;
  /**
   * Implication/inference text. Rendered explicitly under an 'Inference'
   * label when present — the UI never presents it as a direct source fact.
   */
  implication: string | null;
  readAt: string | null;
  dismissedAt: string | null;
}

export function getBizDevProspectAlerts(api: AxiosInstance, prospectId: string, limit = 25, cursor?: string) {
  return api
    .get<{ items: BizDevProspectAlert[]; nextCursor?: string | null }>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/alerts`,
      { params: { limit, ...(cursor ? { cursor } : {}) } },
    )
    .then((r) => r.data);
}

export function markBizDevAlertRead(api: AxiosInstance, prospectId: string, alertId: string) {
  return api
    .post(`/api/business-development/prospects/${encodeURIComponent(prospectId)}/alerts/${encodeURIComponent(alertId)}/read`)
    .then((r) => r.data);
}

export function dismissBizDevAlert(api: AxiosInstance, prospectId: string, alertId: string) {
  return api
    .post(`/api/business-development/prospects/${encodeURIComponent(prospectId)}/alerts/${encodeURIComponent(alertId)}/dismiss`)
    .then((r) => r.data);
}

/**
 * Human label for a per-source health value. Deliberately distinguishes
 * error/stale/paused states so a failed or timed-out check is never rendered
 * as if the source simply had nothing new.
 */
export const BIZDEV_SOURCE_HEALTH_LABELS: Record<BizDevWatchSourceHealth, string> = {
  pending: 'Waiting for its first check',
  healthy: 'Checked and healthy',
  partial: 'Partial — some data could not be checked',
  error: 'Error — the last check failed',
  stale: 'Unavailable — this source is deferred or needs review',
  paused: 'Paused — checks are not running for this source',
};

// ── Phase 5 query keys ────────────────────────────────────────────────

export const bizdevWatchKeys = {
  watch: (tenantId: string, prospectId: string) =>
    ['business-development', tenantId, 'prospect', prospectId, 'watch'] as const,
  alerts: (tenantId: string, prospectId: string) =>
    ['business-development', tenantId, 'prospect', prospectId, 'alerts'] as const,
};

// ── query keys (full identity: no cross-view staleness) ────────────────

export const bizdevKeys = {
  all: (tenantId: string) => ['business-development', tenantId] as const,
  lists: (tenantId: string, filter: Record<string, unknown>) =>
    ['business-development', tenantId, 'prospects', filter] as const,
  detail: (tenantId: string, id: string) =>
    ['business-development', tenantId, 'prospect', id] as const,
  history: (tenantId: string, id: string) =>
    ['business-development', tenantId, 'prospect', id, 'history'] as const,
  duplicateHints: (tenantId: string, id: string) =>
    ['business-development', tenantId, 'prospect', id, 'duplicate-hints'] as const,
  members: (tenantId: string) => ['business-development', tenantId, 'member-options'] as const,
  preferences: (tenantId: string) => ['business-development', tenantId, 'preferences'] as const,
  /** Phase 2 candidate search — keyed by tenant + full search identity. */
  candidates: (
    tenantId: string,
    query: { q: string; service?: string; includeExcluded?: '0' | '1'; limit: number; offset: number },
  ) =>
    ['business-development', tenantId, 'candidates', { ...query, includeExcluded: query.includeExcluded ?? '0' }] as const,
  /** Phase 2 company dossier header (section=identity). */
  companyDossierIdentity: (tenantId: string, canonicalEntityId: string) =>
    ['business-development', tenantId, 'dossier', 'company', canonicalEntityId, 'identity'] as const,
  /** Phase 2 company dossier single section. */
  companyDossierSection: (
    tenantId: string,
    canonicalEntityId: string,
    section: BizDevDossierSectionKind,
  ) =>
    [
      'business-development',
      tenantId,
      'dossier',
      'company',
      canonicalEntityId,
      'section',
      section,
    ] as const,
  /** Phase 2 prospect dossier header (section=identity). */
  prospectDossierIdentity: (tenantId: string, prospectId: string) =>
    ['business-development', tenantId, 'dossier', 'prospect', prospectId, 'identity'] as const,
  /** Phase 2 prospect dossier single section. */
  prospectDossierSection: (tenantId: string, prospectId: string, section: BizDevDossierSectionKind) =>
    [
      'business-development',
      tenantId,
      'dossier',
      'prospect',
      prospectId,
      'section',
      section,
    ] as const,
  brief: (tenantId: string, prospectId: string) =>
    ['business-development', tenantId, 'prospect', prospectId, 'brief'] as const,
  briefVersions: (tenantId: string, prospectId: string) =>
    ['business-development', tenantId, 'prospect', prospectId, 'brief', 'versions'] as const,
};

// ── Phase 2 — candidate search + dossier (exact backend contract) ───────

/** Section kinds mirror the backend DOSSIER_SECTION_KINDS exactly. */
export const BIZDEV_DOSSIER_SECTION_KINDS = [
  'identity',
  'government_exposure',
  'relevant_signals',
  'footprint',
  'lobbying',
  'people',
] as const;
export type BizDevDossierSectionKind = (typeof BIZDEV_DOSSIER_SECTION_KINDS)[number];

export type BizDevEvidenceSourceFamily =
  | 'capiro_canonical_identity'
  | 'capiro_prospect_state'
  | 'usaspending_contract'
  | 'usaspending_assistance'
  | 'sam_entity'
  | 'sam_opportunity'
  | 'tango_vehicle'
  | 'lda_filing'
  | 'pdl_company'
  | 'pdl_people';

export type BizDevEvidenceRelationshipStrength = 'direct' | 'conditional' | 'thematic' | 'unresolved';

export type BizDevEvidenceStatus =
  | 'available'
  | 'empty_in_queried_scope'
  | 'ambiguous'
  | 'stale'
  | 'partial'
  | 'error';

export type BizDevEvidenceStage =
  | 'requested'
  | 'authorized'
  | 'obligated'
  | 'awarded'
  | 'ceiling'
  | 'forecast';

/** Human labels for honest section/evidence status rendering. */
export const BIZDEV_EVIDENCE_STATUS_LABELS: Record<BizDevEvidenceStatus, string> = {
  available: 'Available',
  empty_in_queried_scope: 'No records in the scope checked',
  ambiguous: 'Ambiguous — identity not confirmed',
  stale: 'Possibly out of date',
  partial: 'Partial — some sources could not be confirmed',
  error: 'Could not be checked',
};

/** Direct vs potential relevance labels (never collapsed). */
export const BIZDEV_RELATIONSHIP_LABELS: Record<BizDevEvidenceRelationshipStrength, string> = {
  direct: 'Direct — matched on an exact identifier',
  conditional: 'Potential — exact name match, not identifier-verified',
  thematic: 'Potential — contextual, not evidence about this company',
  unresolved: 'Unresolved — identity ambiguous',
};

/**
 * Normalized source-evidence envelope (mirrors backend EvidenceItem).
 * `detail` is a structured, section-specific payload — never render it as a
 * raw object; the source inspector shows selected key/value rows.
 */
export interface BizDevEvidenceItem {
  sourceFamily: BizDevEvidenceSourceFamily;
  recordId: string | null;
  locator: string | null;
  originalSourceName: string | null;
  originalSourceId: string | null;
  claimType: string;
  relationshipStrength: BizDevEvidenceRelationshipStrength;
  eventDate: string | null;
  effectiveDate: string | null;
  fiscalYear: number | null;
  stage: BizDevEvidenceStage | null;
  sourceUpdatedAt: string | null;
  fetchedAt: string | null;
  scopeChecked: string | null;
  status: BizDevEvidenceStatus;
  title: string;
  detail: Record<string, unknown>;
}

export interface BizDevDossierSectionState {
  section: BizDevDossierSectionKind;
  status: BizDevEvidenceStatus;
  statusText: string;
}

export interface BizDevDossierSection {
  section: BizDevDossierSectionKind;
  status: BizDevEvidenceStatus;
  statusText: string;
  evidence: BizDevEvidenceItem[];
  detail: Record<string, unknown>;
}

/**
 * Phase 3 — narrow optional Jev projection contract carried in section
 * `detail`. The server (apps/api bizdev-jev.service) only ever emits these
 * stable enum-like values under `jevSuggestion`, with
 * `jevSuggestionRequiresReview: true`. The browser recognizes EXACTLY these
 * values and treats anything unknown/malformed as absent — no inference, no
 * fallback guessing. Absent fields = exact Phase 2 rendering.
 */
export type BizDevJevSuggestion =
  | 'identity_review_required'
  | 'possible_fit'
  | 'direct_fit'
  | 'not_evaluated';

const BIZDEV_JEV_SUGGESTIONS: readonly BizDevJevSuggestion[] = [
  'identity_review_required',
  'possible_fit',
  'direct_fit',
  'not_evaluated',
];

/**
 * Read the optional Phase 3 projection from a section detail object.
 * Whitelist-strict: unknown, malformed or missing values all resolve to
 * null (rendered as if the field never existed). Never reads any other
 * Jev-related key; raw internal detail keys stay invisible to the UI.
 */
export function readBizDevJevSuggestion(
  detail: Record<string, unknown> | null | undefined,
): BizDevJevSuggestion | null {
  const value = detail?.jevSuggestion;
  return typeof value === 'string' &&
    (BIZDEV_JEV_SUGGESTIONS as readonly string[]).includes(value)
    ? (value as BizDevJevSuggestion)
    : null;
}

/** Exact dossier response envelope (finalizeDossier shape). */
export interface BizDevDossier {
  canonicalEntityId: string | null;
  canonicalName: string | null;
  identityScope: 'global_public' | 'tenant_private' | null;
  identityBasis: 'exact_uei' | 'exact_name' | 'unresolved_prospect';
  generatedAt: string;
  sections: Partial<Record<BizDevDossierSectionKind, BizDevDossierSection>>;
  sectionStates: BizDevDossierSectionState[];
  prospect: { id: string; displayName: string } | null;
}

/** Structured, source-backed reason to inspect a candidate (or null). */
export interface BizDevWhyInspectReason {
  title: string;
  eventDate: string | null;
  sourceFamily: 'usaspending_contract';
  originalSourceName: string;
  recordId: string;
  locator: string;
  fetchedAt: string | null;
  relationshipStrength: 'direct';
  status: 'available';
  /** All fields describe the same award identified by recordId, not the aggregate. */
  latestAward?: {
    obligatedAmountUsd: string | null;
    description: string | null;
    awardingAgency: string | null;
    recipientName: string | null;
    recipientState: string | null;
  };
}

/**
 * Candidate row (searchCandidates). Deliberately carries NO conflictReason
 * or note bodies: markers are safe booleans only.
 */
export interface BizDevCandidate {
  canonicalEntityId: string;
  canonicalName: string;
  identityScope: 'global_public' | 'tenant_private';
  identifiers: Array<{ type: string; value: string }>;
  whyInspect: BizDevWhyInspectReason | null;
  markerCoverage: 'complete' | 'partial';
  marker: {
    prospectActive: boolean;
    prospectDismissed: boolean;
    client: boolean;
    excluded: boolean;
  };
  clientWithoutProspect: boolean;
  prospectId?: string;
  linkedClientId?: string | null;
  stage?: string | null;
  /** Saved, same-tenant judgment; never a source fact or an inferred service fit. */
  serviceHypothesis?: string | null;
  evidenceCoverage?: 'available' | 'empty_in_queried_scope' | 'identity_unresolved' | 'error';
}

/** Exact candidate-search response: { results, coverage } — no cursor. */
export interface BizDevCandidateSearchResult {
  results: BizDevCandidate[];
  coverage: {
    agencyFilterApplied: boolean;
    issueFilterApplied: boolean;
    geographyFilterApplied: boolean;
    /**
     * Service-hypothesis exact filter (optional: absent on a backend without
     * the filter slice — read optional, never guess).
     */
    serviceFilterApplied?: boolean;
    /** Firm-exclusion filter mode (optional for partial rollout). */
    exclusionsApplied?: boolean;
    unsupportedFilters: string[];
    more: boolean;
    offset: number;
    limit: number;
  };
}

/** GET /api/business-development/search/candidates (q 2..200, limit 1..25, offset 0..500). */
export function searchBizDevCandidates(
  api: AxiosInstance,
  query: { q: string; service?: string; includeExcluded?: '0' | '1'; limit: number; offset: number },
) {
  return api
    .get<BizDevCandidateSearchResult>('/api/business-development/search/candidates', {
      params: { ...query, includeExcluded: query.includeExcluded ?? '0' },
    })
    .then((r) => r.data);
}

/** GET /api/business-development/dossier/companies/:canonicalEntityId (optional ?section=). */
export function getBizDevCompanyDossier(
  api: AxiosInstance,
  canonicalEntityId: string,
  section?: BizDevDossierSectionKind,
) {
  return api
    .get<BizDevDossier>(
      `/api/business-development/dossier/companies/${encodeURIComponent(canonicalEntityId)}`,
      { params: section ? { section } : {} },
    )
    .then((r) => r.data);
}

/** GET /api/business-development/prospects/:prospectId/dossier (optional ?section=). */
export function getBizDevProspectDossier(
  api: AxiosInstance,
  prospectId: string,
  section?: BizDevDossierSectionKind,
) {
  return api
    .get<BizDevDossier>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/dossier`,
      { params: section ? { section } : {} },
    )
    .then((r) => r.data);
}

// ── Phase 4 — editable, versioned prospect briefs ─────────────────────

export const BIZDEV_BRIEF_SECTION_KEYS = [
  'companyAndFirmImplication',
  'verifiedEvidence',
  'judgment',
  'practicalAction',
  'missingInformation',
] as const;
export type BizDevBriefSectionKey = (typeof BIZDEV_BRIEF_SECTION_KEYS)[number];

export interface BizDevBriefSectionContent {
  text: string;
  provenance: 'generated' | 'edited';
  citationIndexes: number[];
}

export type BizDevBriefSections = Record<BizDevBriefSectionKey, BizDevBriefSectionContent>;

export interface BizDevBriefCitation {
  sourceFamily: string;
  recordId: string;
  locator: string | null;
  originalSourceName: string | null;
  originalSourceId: string | null;
  eventDate: string | null;
  sourceUpdatedAt: string | null;
  retrievedAt: string | null;
  title: string;
  relationshipStrength: string;
  stage: string | null;
}

export interface BizDevBriefSourceSnapshot {
  generatedAt: string;
  identityBasis: string;
  canonicalEntityId: string | null;
  canonicalName: string | null;
  evidence: BizDevEvidenceItem[];
}

export interface BizDevBriefVersionSummary {
  id: string;
  versionNumber: number;
  createdAt: string;
  createdByUserId: string | null;
  sectionsHash: string;
  citationCount: number;
}

export interface BizDevBriefVersionDetail extends BizDevBriefVersionSummary {
  sections: BizDevBriefSections;
  citations: BizDevBriefCitation[];
  sourceSnapshot: BizDevBriefSourceSnapshot;
  snapshotHash: string;
}

export interface BizDevBriefSummary {
  id: string;
  tenantId: string;
  prospectId: string;
  title: string;
  status: 'draft' | 'archived';
  currentVersionNumber: number | null;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
}

export interface BizDevCurrentBriefResult {
  brief: BizDevBriefSummary | null;
  currentVersion: BizDevBriefVersionDetail | null;
}

export interface BizDevBriefWriteResult {
  brief: BizDevBriefSummary;
  version: BizDevBriefVersionDetail;
  created: boolean;
}

export interface BizDevBriefRefreshProposal {
  baseVersionNumber: number;
  proposed: BizDevBriefSections;
  diff: Array<{
    section: BizDevBriefSectionKey;
    changed: boolean;
    baseText: string;
    proposedText: string;
  }>;
  sourceSnapshot: BizDevBriefSourceSnapshot;
  snapshotHash: string;
}

export type BizDevBriefCitationResolution =
  | {
      resolvable: true;
      citation: BizDevBriefCitation;
      sourceSnapshotEvidence: BizDevEvidenceItem | null;
      currentDossierEvidence: BizDevEvidenceItem | null;
    }
  | {
      resolvable: false;
      limitation: 'citation_index_out_of_range' | 'brief_not_found' | 'source_changed';
      message: string;
      citation: BizDevBriefCitation | null;
    };

export function getBizDevCurrentBrief(api: AxiosInstance, prospectId: string) {
  return api
    .get<BizDevCurrentBriefResult>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/brief`,
    )
    .then((response) => response.data);
}

export function createBizDevBrief(
  api: AxiosInstance,
  prospectId: string,
  input: { idempotencyKey: string; title?: string },
) {
  return api
    .post<BizDevBriefWriteResult>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/brief/versions`,
      input,
    )
    .then((response) => response.data);
}

export function saveBizDevBrief(
  api: AxiosInstance,
  prospectId: string,
  input: {
    idempotencyKey: string;
    expectedVersionNumber: number;
    sections: BizDevBriefSections;
    title?: string;
  },
) {
  return api
    .put<BizDevBriefWriteResult>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/brief/versions`,
      input,
    )
    .then((response) => response.data);
}

export function getBizDevBriefRefreshProposal(api: AxiosInstance, prospectId: string) {
  return api
    .get<BizDevBriefRefreshProposal>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/brief/refresh-proposal`,
    )
    .then((response) => response.data);
}

export function acceptBizDevBriefRefresh(
  api: AxiosInstance,
  prospectId: string,
  input: {
    idempotencyKey: string;
    expectedVersionNumber: number;
    keepUserEdits: boolean;
  },
) {
  return api
    .post<BizDevBriefWriteResult>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/brief/refresh-accept`,
      input,
    )
    .then((response) => response.data);
}

export function listBizDevBriefVersions(api: AxiosInstance, prospectId: string) {
  return api
    .get<{ brief: BizDevBriefSummary; versions: BizDevBriefVersionSummary[] }>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/brief/versions`,
    )
    .then((response) => response.data);
}

export function getBizDevBriefVersion(
  api: AxiosInstance,
  prospectId: string,
  versionNumber: number,
) {
  return api
    .get<BizDevBriefVersionDetail>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/brief/versions/${versionNumber}`,
    )
    .then((response) => response.data);
}

export function resolveBizDevBriefCitation(
  api: AxiosInstance,
  prospectId: string,
  citationIndex: number,
) {
  return api
    .get<BizDevBriefCitationResolution>(
      `/api/business-development/prospects/${encodeURIComponent(prospectId)}/brief/citations`,
      { params: { index: citationIndex } },
    )
    .then((response) => response.data);
}

export function newBizDevIdempotencyKey(operation: string): string {
  return `bizdev-brief:${operation}:${crypto.randomUUID()}`;
}

/** Human API-error text; Nest ValidationPipe arrays joined, never raw ids. */
export function bizdevErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown; code?: string } } }).response
      ?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
