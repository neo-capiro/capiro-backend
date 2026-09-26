/**
 * Business Development Phase 2 — normalized source-evidence envelope.
 *
 * Every factual card the dossier renders carries this envelope so a reader can
 * always answer: WHERE did this fact come from (sourceFamily / originalSourceName
 * / recordId / locator), HOW STRONGLY it is tied to the company
 * (relationshipStrength), WHEN it happened vs. when the source spoke
 * (eventDate / effectiveDate / fiscalYear / sourceUpdatedAt / fetchedAt), and
 * HOW FAR the query actually got (scopeChecked / status).
 *
 * Relationship-strength rules (task contract, mirrored from Phase 1 identity
 * discipline and vendor-reference rail exclusivity):
 *   direct       — joined on an exact supported identifier (UEI/CAGE from the
 *                  canonical EntityIdentifier set, verified against the record).
 *   conditional  — exact normalized legal-name equality only, no identifier
 *                  anchor (or a name-only LDA filing). Truthful but unverified.
 *   thematic     — contextual relevance (issuing-office opportunities, partial
 *                  name contains) that is NOT evidence about the company itself.
 *   unresolved   — the identity is ambiguous; the fact cannot be attributed.
 *
 * Stage vocabulary (never collapsed): requested, authorized/enacted, obligated,
 * awarded, ceiling, forecast — only when the source supports the distinction;
 * null otherwise. A forecast is never rendered as an award.
 */

export const EVIDENCE_SOURCE_FAMILIES = [
  'capiro_canonical_identity',
  'capiro_prospect_state',
  'usaspending_contract',
  'usaspending_assistance',
  'sam_entity',
  'sam_opportunity',
  'tango_vehicle',
  'lda_filing',
  'pdl_company',
  'pdl_people',
] as const;
export type EvidenceSourceFamily = (typeof EVIDENCE_SOURCE_FAMILIES)[number];

export const EVIDENCE_RELATIONSHIP_STRENGTHS = [
  'direct',
  'conditional',
  'thematic',
  'unresolved',
] as const;
export type EvidenceRelationshipStrength = (typeof EVIDENCE_RELATIONSHIP_STRENGTHS)[number];

export const EVIDENCE_STATUSES = [
  'available',
  'empty_in_queried_scope',
  'ambiguous',
  'stale',
  'partial',
  'error',
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/**
 * Source-lifecycle stage a record supports. `forecast` (not yet requested),
 * `requested` (solicitation posted / bid), `authorized` (enacted appropriation),
 * `obligated`, `awarded` (signed/obligated contract or assistance award),
 * `ceiling` (vehicle/IDV ceiling, not an obligation). Null when the source does
 * not distinguish.
 */
export type EvidenceStage =
  | 'requested'
  | 'authorized'
  | 'obligated'
  | 'awarded'
  | 'ceiling'
  | 'forecast';

/** The normalized envelope every factual evidence item must carry. */
export interface EvidenceItem {
  /** Which Capiro rail / provider family the fact came from. */
  sourceFamily: EvidenceSourceFamily;
  /** Stable id of the underlying record in that family (award_unique_id, filing_uuid, notice_id, canonical entity id…). */
  recordId: string | null;
  /** Human-usable locator (deep link or unambiguous reference) when known. */
  locator: string | null;
  /** The original source's own name, e.g. 'USAspending', 'Senate LDA', 'SAM.gov'. */
  originalSourceName: string | null;
  /** The original source's own id for the record (PIID/FAIN, noticeId, filingUuid…). */
  originalSourceId: string | null;
  /** What kind of claim this card makes. */
  claimType:
    | 'identity'
    | 'government_exposure'
    | 'relevant_signal'
    | 'footprint'
    | 'lobbying'
    | 'people';
  relationshipStrength: EvidenceRelationshipStrength;
  /** Date the underlying event happened (award action, filing posted), when known. */
  eventDate: string | null;
  /** Date the fact became effective, when distinct from eventDate. */
  effectiveDate: string | null;
  /** Fiscal year the record reports, when the source states one. */
  fiscalYear: number | null;
  /** Lifecycle stage when the source supports the distinction (see EvidenceStage). */
  stage: EvidenceStage | null;
  /** When the source record was last updated by the source, when known. */
  sourceUpdatedAt: string | null;
  /** When Capiro fetched/synced this record. */
  fetchedAt: string | null;
  /** What was actually queried (e.g. 'recipient_uei=UEI123' or 'exact_name="Acme"'), so emptiness is auditable. */
  scopeChecked: string | null;
  status: EvidenceStatus;
  /** Concise human-readable finding ('Acme received a $12M DoD contract, FY2025'). */
  title: string;
  /** Structured, section-specific detail payload. */
  detail: Record<string, unknown>;
}

/** Per-section state so a provider failure never blanks other sections. */
export const DOSSIER_SECTION_KINDS = [
  'identity',
  'government_exposure',
  'relevant_signals',
  'footprint',
  'lobbying',
  'people',
] as const;
export type DossierSectionKind = (typeof DOSSIER_SECTION_KINDS)[number];

export interface DossierSectionState {
  section: DossierSectionKind;
  status: EvidenceStatus;
  /** Plain-English coverage/failure explanation (user-profile rule: no raw internal ids). */
  statusText: string;
}

export type DossierSectionDetail = Record<string, unknown>;

export interface DossierSection<T = DossierSectionDetail> {
  section: DossierSectionKind;
  status: EvidenceStatus;
  statusText: string;
  evidence: EvidenceItem[];
  /** Section-specific payload (e.g. identity candidates, exposure totals). */
  detail: T;
}

/** Sentinel for a disabled-by-flag provider: rendered, never fetched. */
export const PROVIDER_DISABLED_STATUS_TEXT = {
  sam: 'SAM.gov lookups are turned off for your firm’s account; Capiro-owned records still shown.',
  lda:
    'Lobbying disclosure lookups are turned off for your firm’s account; no lobbying claims are shown.',
  pdl: 'People-enrichment is not available yet; this section will stay empty until it is enabled.',
} as const;
