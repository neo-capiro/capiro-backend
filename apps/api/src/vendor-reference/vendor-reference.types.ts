/**
 * Vendor Reference Pull — the data contract behind "Appendix A: Company
 * Reference Data" of an amendment strategy (template:
 * apps/api-strategy/src/context/templates/15_vendor_reference_pull.md).
 *
 * Every row carries a verification status that is PART OF THE RECORD:
 *
 *   confirmed    — the row came straight from a live or ingested PRIMARY record
 *                  (a SAM.gov entity, a Senate LDA filing, a USAspending /
 *                  Tango award record, a Capiro directory member row) joined
 *                  on an exact identifier or an exact legal-name equality that
 *                  is itself anchored to a UEI.
 *   unverified   — derived by name matching WITHOUT a UEI anchor, or supplied
 *                  by the caller rather than a record Capiro holds.
 *   not_sourced  — Capiro has no source for the fact; it must be entered and
 *                  cited by hand. (Litigation / adverse history is ALWAYS this.)
 *   placeholder  — a slot Capiro cannot fill from data and that a human must
 *                  complete (e.g. the relationship to a client Capiro found to
 *                  be a different legal entity).
 */

export const VERIFICATION_STATUSES = ['confirmed', 'unverified', 'not_sourced', 'placeholder'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Template sections, in the template's order. The renderer walks this list. */
export const DOSSIER_SECTIONS = [
  'company_identity',
  'federal_market_credentials',
  'federal_contracting_history',
  'federal_lobbying_representation',
  'congressional_delegation',
  'litigation_adverse_history',
] as const;
export type DossierSection = (typeof DOSSIER_SECTIONS)[number];

export interface VendorReferenceRow {
  section: DossierSection;
  /** The template's row label (item tables) or a one-line row label (list tables). */
  item: string;
  finding: string;
  source: string;
  verification: VerificationStatus;
  /** YYYY-MM-DD the underlying record was last observed/synced, when known. */
  asOf?: string;
  /** Section-specific structured columns (see the *Detail interfaces below). */
  detail?: Record<string, unknown>;
}

/** Columns of the "Federal contracting history" table. */
export interface ContractingDetail {
  agency: string | null;
  /** IDIQ / BPA / Contract / Grant / vehicle type as the provider labels it. */
  type: string | null;
  value: number | null;
  awardDate: string | null;
  /** Present only when evidence-accuracy enforcement is active. */
  awardDateSemantics?: 'latest_action' | 'base_award_signed';
  periodOfPerformance: string | null;
  matchBasis: 'exact_uei' | 'exact_name';
  recordId: string;
}

/** Columns of the "Federal lobbying representation" table. */
export interface LobbyingDetail {
  registrant: string;
  clientOfRecord: string;
  period: string;
  income: number | null;
  issueCodes: string[];
  filingType: string;
  filingUuid: string;
  matchBasis: 'exact_legal_name' | 'exact_input_name' | 'name_contains';
}

/** Columns of the "Congressional delegation for the facility" table. */
export interface DelegationDetail {
  bioguideId: string;
  member: string;
  chamber: 'House' | 'Senate';
  stateDistrict: string;
  committee: string | null;
  committeeSystemCode: string | null;
  role: string;
  districtBasis: DistrictBasis;
}

export type DistrictBasis =
  | 'caller_supplied'
  | 'census_geocode'
  | 'sam_physical_address'
  | 'state_only_caller_supplied'
  | 'state_only_sam_physical_address';

/**
 * How the target company was pinned down. The strategist MUST see this: a
 * dossier assembled around an exact UEI and one assembled around a name that
 * happened to match are different documents.
 *
 *   uei_input       — caller supplied the UEI; every join keys on it.
 *   cage_input      — caller supplied a CAGE; SAM resolved it to one UEI.
 *   sam_exact_name  — no identifier supplied; SAM returned exactly ONE active
 *                     registration whose legal name (or DBA) equals the input
 *                     name after normalization (optionally narrowed by state).
 *   name_only       — no identifier could be established (SAM found nothing,
 *                     found several distinct entities, or was unavailable).
 *                     Everything downstream is name-derived → unverified.
 */
export type IdentityBasis = 'uei_input' | 'cage_input' | 'sam_exact_name' | 'name_only';

export interface IdentityCandidate {
  uei: string;
  legalBusinessName: string;
  state: string | null;
  registrationStatus: string | null;
}

export interface VendorIdentity {
  inputName: string;
  /** SAM legal business name when a SAM record anchors the identity. */
  matchedName: string | null;
  uei: string | null;
  cageCode: string | null;
  basis: IdentityBasis;
  /** True only when a SAM entity record was actually retrieved for `uei`. */
  samVerified: boolean;
  /** True when SAM returned more than one distinct UEI for the name. */
  ambiguous: boolean;
  /** Distinct SAM candidates when ambiguous (so the strategist can pick one and re-pull with `uei`). */
  candidates: IdentityCandidate[];
  /** Names used for exact-name joins (input name, SAM legal name, SAM DBA). */
  nameVariants: string[];
  explanation: string;
}

export interface VendorReferenceInput {
  name: string;
  uei?: string;
  cage?: string;
  state?: string;
  district?: string;
  facilityAddress?: string;
  clientId?: string;
  strategyId?: string;
}

export interface VendorReferenceDossier {
  /** ISO-8601 timestamp of generation. */
  generatedAt: string;
  /** YYYY-MM-DD, the frontmatter `as_of`. */
  asOf: string;
  input: VendorReferenceInput;
  identity: VendorIdentity;
  rows: VendorReferenceRow[];
  /** Provider failures and degraded paths. Never empty when a rail failed. */
  warnings: string[];
  /** Deterministic staff Q&A notes rendered under "Handling notes for staff Q&A". */
  handlingNotes: string[];
}

/**
 * HARD RULE: Capiro has no source for litigation or adverse history. This row
 * is emitted verbatim on every pull, is never populated, and is never inferred.
 */
export const LITIGATION_ITEM = 'Civil litigation, settlements, suspensions, debarments';
export const LITIGATION_FINDING = 'Not sourced; enter and cite independently';
export const LITIGATION_SOURCE = 'Manual only';

export function litigationRow(): VendorReferenceRow {
  return {
    section: 'litigation_adverse_history',
    item: LITIGATION_ITEM,
    finding: LITIGATION_FINDING,
    source: LITIGATION_SOURCE,
    verification: 'not_sourced',
  };
}

/** Standard finding text for a `not_sourced` row outside the litigation section. */
export const NOT_SOURCED_FINDING = 'Not sourced; enter and cite independently';
