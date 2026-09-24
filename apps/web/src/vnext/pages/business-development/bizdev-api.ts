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
  candidates: (tenantId: string, query: { q: string; limit: number; offset: number }) =>
    ['business-development', tenantId, 'candidates', query] as const,
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
}

/** Exact candidate-search response: { results, coverage } — no cursor. */
export interface BizDevCandidateSearchResult {
  results: BizDevCandidate[];
  coverage: {
    agencyFilterApplied: boolean;
    issueFilterApplied: boolean;
    geographyFilterApplied: boolean;
    unsupportedFilters: string[];
    more: boolean;
    offset: number;
    limit: number;
  };
}

/** GET /api/business-development/search/candidates (q 2..200, limit 1..25, offset 0..500). */
export function searchBizDevCandidates(
  api: AxiosInstance,
  query: { q: string; limit: number; offset: number },
) {
  return api
    .get<BizDevCandidateSearchResult>('/api/business-development/search/candidates', {
      params: query,
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
