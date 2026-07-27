/**
 * District Nexus — shared response contracts (Rev 2 plan, WS-A Step A3).
 *
 * These are the API-side source of truth. The web app mirrors them in
 * `apps/web/src/pages/intelligence/district-nexus/district-nexus-api.ts` with a
 * "Mirrors apps/api/src/district-nexus/district-nexus.types.ts" docblock, per
 * the repo's dominant convention — `packages/shared` is reserved for constants
 * both sides genuinely need at runtime, not for type mirroring.
 *
 * ── The one rule that shapes every money field below ────────────────────────
 *
 * There is deliberately NO `totalAmount` anywhere in this file.
 *
 * Contracts, awarded grants, grant outlays and grant *opportunities* are
 * different kinds of number and summing them produces a figure that is wrong
 * in a way nobody can see. An opportunity's estimated funding is a forecast
 * that may never be awarded to anyone; an outlay is money already paid. A
 * single blended "total" invites exactly the false claim this feature exists
 * to avoid. Callers that want a headline number must choose which one and say
 * so in the label.
 */

import type {
  FederalMemberSummary,
  RepresentationResult,
} from '../clients/representation-resolver.service.js';

/** ISO-8601 timestamp. */
export type IsoTimestamp = string;

/**
 * Whole US dollars unless a field says otherwise. Nullable throughout: null
 * means "we have no figure", which is NOT the same as 0 ("we looked, it's
 * zero"). Rendering null as $0 is a data-quality bug, not a formatting choice.
 */
export type Money = number | null;

/** `<STATE>-<2-char district code>`, e.g. `TX-23`, `WY-00`. Matches BoundaryFeature.id. */
export type DistrictKey = string;

// ── Provenance, freshness, warnings ─────────────────────────────────────────

/**
 * When each contributing source last successfully synced, read from SyncRun
 * watermarks. Surfaced so the UI can say "contracts current to 3 Jul" rather
 * than implying everything is live.
 */
export interface SourceFreshness {
  /**
   * Stable rail identifier — the ingestion verb name, which is what the UI keys
   * and deep-links on. NOT necessarily the `sync_run.source` value: several jobs
   * record a different source string than their verb (e.g. the contract rail's
   * verb is `sync-federal-award` but it writes `usaspending_federal_award`).
   */
  source: string;
  /** Operator-readable rail name for the freshness strip. */
  label: string;
  lastSyncedAt: IsoTimestamp | null;
  /** True when the source has never completed a successful run. */
  neverSynced: boolean;
  /**
   * True when this rail's job records no SyncRun at all, so its freshness is
   * genuinely UNKNOWN rather than absent.
   *
   * This is not pedantry: `sync-census` populates census_district but writes no
   * SyncRun row, so reporting it as `neverSynced` would state "this never ran"
   * about a rail that demonstrably has. Unknown and never-run are different
   * facts and the UI must not render them the same way.
   */
  freshnessUnavailable?: boolean;
}

export type DataQualityWarningCode =
  /** Award geography is statewide ("90") or otherwise not district-resolvable. */
  | 'statewide_attribution'
  /** Geography came from recipient location, which is weaker than place of performance. */
  | 'recipient_location_fallback'
  /** Figures include entities matched by name rather than a verified identifier. */
  | 'inferred_entity_match'
  /** A contributing source is stale or has never synced. */
  | 'stale_source'
  /** Some money could not be attributed to any district — see unmapped* fields. */
  | 'unmapped_amount'
  /** Only grant opportunities back this, no awarded funding. */
  | 'opportunity_only';

export interface DataQualityWarning {
  code: DataQualityWarningCode;
  /** Operator-readable explanation. Shown in the UI, so no internal identifiers. */
  message: string;
  /** The district this warning is scoped to, when it is not global. */
  districtKey?: DistrictKey;
}

// ── Evidence and scoring ────────────────────────────────────────────────────

/**
 * Where a row's district attribution came from (Rev 2 plan §7-E4).
 *
 * Only `place_of_performance | recipient_location | facility | statewide |
 * unknown` are producible today — those are what `district-nexus.aggregate.ts`
 * actually computes from the ingested rails. `project_site`,
 * `employee_aggregate`, `supplier_location`, `partner_location` and
 * `multi_district` are in the type because the plan's contract names them, and
 * they are what the second-migration-wave `ClientDistrictNexusEvidence` table
 * (§6.3, deliberately deferred) will eventually populate — reserved, not wired.
 */
export type GeographyBasis =
  | 'place_of_performance'
  | 'recipient_location'
  | 'facility'
  | 'employee_aggregate'
  | 'supplier_location'
  | 'partner_location'
  | 'project_site'
  | 'statewide'
  | 'multi_district'
  | 'unknown';

/**
 * How independently a piece of evidence has been confirmed.
 *
 * Not the plan's `EvidenceStrength` (district-nexus-scoring.ts) — that governs
 * how many SCORE points a component earns. This governs what a human reading
 * one evidence row should believe about it. They are derived together from
 * `district-nexus.verification.ts` so they can no longer disagree (a
 * name-matched contract is `inferred` here AND earns half weight there), but
 * they remain two axes — a geographic fallback is not a trust judgement — and
 * must not be collapsed into one field.
 */
export type EvidenceVerificationStatus =
  /** A verified external identifier (UEI) or an authoritative government feed. */
  | 'source_verified'
  /** Client-asserted (e.g. a facility address), independently confirmed by geocoding. */
  | 'geocode_verified'
  /** Client-asserted, not independently confirmed. */
  | 'user_provided'
  /** Matched to the client by name similarity rather than a verified identifier. */
  | 'inferred';

/**
 * Which vintage of congressional-district geometry a row's reported code
 * reflects (plan §8.1). `'unknown'` when the source never recorded one —
 * `federal_award` has no vintage column at all, so every contract evidence row
 * is honestly `'unknown'` rather than assumed `'original'`.
 */
export type BoundaryVintage = 'original' | 'current' | 'unknown';

/**
 * One concrete, checkable fact behind a score. Every point a client sees must
 * trace back to one of these — the UI is never allowed to render a bare
 * "84/100" (plan §Workstream F).
 *
 * Scope: this backs the components that actually earn score credit today
 * (facilities, employees, contracts, awarded grants). Grant OPPORTUNITIES earn
 * zero credit by rule 3 (district-nexus-scoring.ts) — there is no "point" for
 * an opportunity to trace back to — so they are surfaced through the separate
 * `opportunities` field, not through this list.
 */
export interface NexusEvidence {
  /** Which scoring component this supports. */
  component: string;
  /** The originating table/system — 'federal_award', 'federal_assistance_award', 'client_facility'. */
  sourceType: string;
  label: string;
  /** Row identifier in the originating table, for drill-through. */
  sourceRecordId: string | null;
  /** When the originating ROW was last synced — a freshness fact about the record. */
  sourceUpdatedAt: IsoTimestamp | null;
  /** When the underlying FACT happened — an award's action date, a facility's geocode date. */
  observedAt: IsoTimestamp | null;
  geographyBasis: GeographyBasis;
  verificationStatus: EvidenceVerificationStatus;
  /** 0-1 when a real computed score exists; null rather than a fabricated number otherwise. */
  confidence: number | null;
  /**
   * Whether this fact may appear in client-facing external materials. Public
   * award/opportunity data is always true; client-supplied facts (facility
   * existence, employee counts) are false until an approval workflow exists —
   * see plan §8.5 and the deferred §6.3 evidence table.
   */
  externalUseApproved: boolean;
  boundaryVintage: BoundaryVintage;
  /** Present only for money-bearing evidence; see the no-totalAmount note above. */
  amount: Money;
}

/** Per-component contribution. `credit` is exact and unrounded — see scoring module. */
export interface NexusScoreBreakdown {
  component: string;
  label: string;
  /** The component's maximum possible contribution. */
  weight: number;
  /** Actual contribution: weight x strength multiplier. Exact, never rounded. */
  credit: number;
  /** Why the credit is below the weight, when it is. */
  rationale: string;
  evidenceCount: number;
}

// ── Money, kept unambiguous ─────────────────────────────────────────────────

/**
 * Awarded money, split by instrument. Every field independently nullable so a
 * client with contracts but no grants reads as null rather than 0.
 */
export interface AwardedFunding {
  contractObligations: Money;
  grantObligations: Money;
  /** Paid out, as distinct from obligated. Always <= grantObligations in practice. */
  grantOutlays: Money;
}

/**
 * Prospective money. Structurally separate from AwardedFunding because these
 * are forecasts — they must never be added to awarded figures, and they
 * contribute nothing to awarded-funding score weight.
 */
export interface OpportunityFunding {
  opportunityEstimatedFunding: Money;
  opportunityAwardCeiling: Money;
}

/** Ordered strongest-first. Mirrors grant-opportunity-relevance.ts. */
export type OpportunityEligibilityState = 'eligible' | 'ineligible' | 'needs_review' | 'unknown';

/**
 * One grant opportunity a client has been explicitly linked to.
 *
 * `status` and `isActive` are separate facts: `status` is Grants.gov's own value,
 * `isActive` is our computed reading of it AND the close date. A closed or
 * archived opportunity stays visible as history but must never be counted active.
 */
export interface ClientOpportunity {
  opportunityId: string;
  title: string;
  agency: string | null;
  /** Grants.gov value verbatim: posted | forecasted | closed | archived. */
  status: string | null;
  closeDate: IsoTimestamp | null;
  /** Close-date semantics when the date alone misleads ("continuous", "TBD"). */
  responseDateDesc: string | null;
  isActive: boolean;
  estimatedFunding: Money;
  awardCeiling: Money;
  /** 0-100, deterministic. Null when no client profile could be built. */
  relevanceScore: number | null;
  eligibilityState: OpportunityEligibilityState;
  /** Operator-readable justification for eligibilityState. Always populated. */
  eligibilityReason: string;
  /** The specific values that matched, never paraphrased. */
  matchedSignals: Array<{ signal: string; weight: number; matchedOn: string }>;
  /** The ClientGrantNexus district link, when a project site established one. */
  districtKey: DistrictKey | null;
}

/**
 * The client's opportunity pipeline, deliberately its OWN rail rather than part
 * of district award aggregation.
 *
 * Opportunities carry no reliable geography — Grants.gov publishes applicant
 * eligibility, not a place of performance — so folding them into districts meant
 * every one was silently dropped and every total came back null while the KPI
 * strip rendered `$0`. They live here instead, at the level they are actually
 * true at.
 *
 * Every field is nullable-or-counted so "no linked opportunities" and "linked
 * opportunities worth an unstated amount" stay distinguishable from "$0".
 */
export interface ClientOpportunitySummary {
  activeOpportunityCount: number;
  /** Closed or archived. History, never counted as active. */
  closedOpportunityCount: number;
  /** Summed estimated program funding across ACTIVE opportunities only. */
  totalEstimatedFunding: Money;
  /** Largest single active award ceiling — a max, never a sum. */
  maximumAwardCeiling: Money;
  /** Active opportunities, relevance-desc then close-date-asc. Capped. */
  topOpportunities: ClientOpportunity[];
}

/**
 * Money we know about but could not attribute to a district. Reported rather
 * than silently dropped: a district total that quietly excludes 40% of the
 * spend is a wrong answer presented confidently.
 */
export interface UnmappedFunding {
  unmappedContractAmount: Money;
  unmappedGrantAmount: Money;
}

// ── Responses ───────────────────────────────────────────────────────────────

/** One district's row in the firm-wide map aggregate. */
export interface DistrictNexusDistrictSummary {
  districtKey: DistrictKey;
  state: string;
  districtCode: string;
  /** 'C' current | 'F' future (enacted, not yet effective). */
  status: 'C' | 'F';
  name: string | null;
  awarded: AwardedFunding;
  opportunities: OpportunityFunding;
  /** Distinct clients with any nexus in this district. */
  clientCount: number;
  /** 0-100, rounded. Null when there is too little evidence to score honestly. */
  score: number | null;
  /**
   * Share of total scoring weight backed by determinate evidence, 0-100.
   *
   * Required, not optional: the map offers "coverage" as a choropleth metric and
   * the drawer renders a coverage pill, so a summary without it makes two of the
   * six colour-by options unbuildable. It is also the only way to read a null
   * `score` correctly — null at 12% coverage means "we don't know yet", which is
   * a different fact from a genuinely weak nexus.
   */
  coveragePercent: number;
  /**
   * Employees across this client's facilities in the district.
   *
   * Null means "no figure", which is NOT zero — a facility with an unreported
   * headcount must never render as 0 employees. `employeesUnreported` says
   * whether any contributing facility withheld a count, so the UI can show
   * "420+" rather than implying the number is complete.
   */
  employeeCount: number | null;
  employeesUnreported: boolean;
  warnings: DataQualityWarning[];
}

/** Firm-wide map payload. */
export interface DistrictNexusMapResponse {
  districts: DistrictNexusDistrictSummary[];
  unmapped: UnmappedFunding;
  freshness: SourceFreshness[];
  warnings: DataQualityWarning[];
  generatedAt: IsoTimestamp;
}

/** Everything behind one district, for the drawer. */
export interface DistrictNexusDistrictDetail extends DistrictNexusDistrictSummary {
  evidence: NexusEvidence[];
  breakdown: NexusScoreBreakdown[];
  freshness: SourceFreshness[];
}

/**
 * One facility and who represents it.
 *
 * Embedded in the client payload so the widget makes ONE request instead of
 * two (WS-E3 / WS-H1). `RepresentationResult` is a discriminated union — an
 * unresolved facility carries a reason rather than an empty member list, so
 * "we could not place this site" never renders as "nobody represents it".
 */
export interface FacilityRepresentation {
  facility: { id: string; name: string; city: string | null; state: string | null };
  representation: RepresentationResult;
}

/**
 * ACS demographics for a district (WS-E2).
 *
 * `dataYear` is carried, never assumed: the live census_district rows are the
 * 2022 ACS 5-year while the prototype mocks 2024, so the UI must render the
 * vintage it actually received rather than a hardcoded label.
 */
export interface DistrictDemographics {
  congress: number;
  dataYear: number;
  totalPopulation: number | null;
  medianHouseholdIncome: number | null;
  medianAge: number | null;
  percentBachelorPlus: number | null;
  percentPoverty: number | null;
  percentVeteran: number | null;
  percentUninsured: number | null;
  laborForceSize: number | null;
  unemploymentRate: number | null;
}

/** One client's presence in a single district. */
export interface DistrictClientSummary {
  clientId: string;
  clientName: string;
  awarded: AwardedFunding;
  facilityCount: number;
  employeeCount: number | null;
}

export interface DistrictFacilitySummary {
  id: string;
  name: string;
  city: string | null;
  clientId: string;
  clientName: string;
  employeeCount: number | null;
}

/**
 * One award row for the drawer's "top awards" list.
 *
 * `amount` is a single instrument's figure — a contract obligation OR a grant
 * obligation, never a blend. The list it belongs to says which.
 */
export interface TopAward {
  id: string;
  label: string;
  counterparty: string | null;
  amount: Money;
  awardedAt: IsoTimestamp | null;
  /** USAspending profile. Existing award rails link out rather than drill in. */
  externalUrl: string | null;
}

/** WS-E Step E2 — everything behind one district, for the drawer. */
export interface DistrictNexusDistrictDetailResponse extends DistrictNexusDistrictDetail {
  /**
   * Null when the district code cannot resolve a House seat at all (a sentinel
   * like '90'/'98'), as distinct from a resolvable district whose member simply
   * is not in the roster — that case is `{ house: null, senate: [...] }`.
   */
  representatives: {
    house: FederalMemberSummary | null;
    senate: FederalMemberSummary[];
  } | null;
  clients: DistrictClientSummary[];
  facilities: DistrictFacilitySummary[];
  /** Unscoped "all public activity in this district" — browsing, not evidence. */
  topContractAwards: TopAward[];
  topGrantAwards: TopAward[];
  /**
   * Awards tied to the SELECTED client's confirmed identifiers in this
   * district (audit F5). Empty (not absent) when no client filter is
   * applied — see `clientScoped`. `topContractAwards`/`topGrantAwards` above
   * are the UNSCOPED lists and must be labelled as such in the UI; these must
   * never silently fall back to them.
   */
  clientContractAwards: TopAward[];
  clientGrantAwards: TopAward[];
  /** True when a clientId narrowed this response. Drives the UI's copy. */
  clientScoped: boolean;
  demographics: DistrictDemographics | null;
  /** Whether a published boundary artifact covers this district. */
  boundaryAvailable: boolean;
  generatedAt: IsoTimestamp;
}

/**
 * Which identity rails are confirmed for this client (WS-H3).
 *
 * Required because the money fields cannot answer it. `contractObligations:
 * null` means EITHER "no confirmed contracting mapping" (actionable: go map
 * one) OR "mapped, and the client genuinely has no DoD prime contracts"
 * (nothing to do). Telling a user to map a contractor they already mapped is a
 * wrong answer, so the widget is given the fact instead of guessing at it.
 */
export interface ClientNexusLinkage {
  /** At least one confirmed `contracting` ClientIntelMapping row exists. */
  contractingLinked: boolean;
  /** `externalName` of each confirmed contracting mapping. */
  contractorNames: string[];
  /** At least one confirmed `assistance_recipient` ClientIntelMapping row exists. */
  assistanceLinked: boolean;
  /** `externalName` of each confirmed assistance_recipient mapping. */
  recipientNames: string[];
  /**
   * How many confirmed assistance mappings carry a UEI-shaped `externalId`.
   * Carried separately from `assistanceLinked` because a name-only assistance
   * mapping cannot drive the UEI rail at all — "mapped but unusable" is a
   * distinct, actionable state from "not mapped".
   */
  ueiConfirmedCount: number;
}

/**
 * The client's physical footprint, counted across ALL facilities — including
 * ones whose congressional district never resolved, which `districts[]`
 * necessarily omits. Without this the widget cannot distinguish "no facilities
 * on file" from "facilities on file, none geocoded".
 */
export interface ClientFacilityFootprint {
  facilityCount: number;
  /** Facilities with no district-resolvable state+code pair. */
  facilitiesWithoutDistrict: number;
  /**
   * Summed `employeeCount` across every facility. `null` means no facility
   * reported one — NOT zero employees.
   */
  employeeCount: number | null;
  /** Facilities that reported no headcount, so the UI can render "420+". */
  facilitiesMissingEmployeeCount: number;
}

/** The per-client view powering the profile widget (WS-H). */
export interface ClientDistrictNexusResponse {
  clientId: string;
  districts: DistrictNexusDistrictDetail[];
  /**
   * Server-side embed of RepresentationResolverService, so the widget can drop
   * its separate representation query. Resolved through the BATCHED resolver —
   * the per-facility path is four queries each, which is the fan-out this
   * service's docblock exists to prevent.
   */
  representativesByFacility: FacilityRepresentation[];
  /** WS-H3 — which identity rails are confirmed. */
  linkage: ClientNexusLinkage;
  /** WS-H2 — facility/employee counts across ALL facilities. */
  facilityFootprint: ClientFacilityFootprint;
  awarded: AwardedFunding;
  opportunities: OpportunityFunding;
  /**
   * The client's OWN opportunity pipeline (WS-F). Deliberately separate from
   * `opportunities` above, which is the district-derived (project-site-linked
   * only) figure folded through `foldDistricts` — see `ClientOpportunitySummary`.
   */
  opportunitySummary: ClientOpportunitySummary;
  unmapped: UnmappedFunding;
  /**
   * Overall client score, or null when coverage is too thin to claim one.
   *
   * This is a FOOTPRINT score: it pools evidence across every district the
   * client touches, so it answers "how well-evidenced is this client's district
   * footprint" and is NOT a claim about any single district. Per-district truth
   * is in `districts[]`. See `poolEvidence` in district-nexus.aggregate.ts.
   */
  score: number | null;
  /**
   * The client's strongest single district, or null when none scored above the
   * coverage floor. Kept as a fact because it is the useful headline for a firm
   * with one deep district and several incidental ones — but deliberately not
   * used AS the client score.
   */
  bestDistrictKey: DistrictKey | null;
  coveragePercent: number;
  breakdown: NexusScoreBreakdown[];
  /** Highest-credit components first, zero-credit excluded. Powers "why this score". */
  strongestDrivers: NexusScoreBreakdown[];
  freshness: SourceFreshness[];
  warnings: DataQualityWarning[];
  generatedAt: IsoTimestamp;
}
