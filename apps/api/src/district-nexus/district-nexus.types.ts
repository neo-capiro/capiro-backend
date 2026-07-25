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
 * One concrete, checkable fact behind a score. Every point a client sees must
 * trace back to one of these — the UI is never allowed to render a bare
 * "84/100" (plan §Workstream F).
 */
export interface NexusEvidence {
  /** Which scoring component this supports. */
  component: string;
  /** e.g. 'facility', 'federal_award', 'federal_assistance_award', 'client_person'. */
  kind: string;
  label: string;
  /** Identifier in the originating table, for drill-through. */
  sourceId: string | null;
  sourceSystem: string | null;
  /** Present only for money-bearing evidence; see the no-totalAmount note above. */
  amount: Money;
  observedAt: IsoTimestamp | null;
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

/** The per-client view powering the profile widget (WS-H). */
export interface ClientDistrictNexusResponse {
  clientId: string;
  districts: DistrictNexusDistrictDetail[];
  awarded: AwardedFunding;
  opportunities: OpportunityFunding;
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
