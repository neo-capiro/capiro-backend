/**
 * Funding Opportunities — the API-side response contract, and the source of
 * truth for it.
 *
 * The web app mirrors this file in
 * `apps/web/src/pages/intelligence/opportunities/funding-opportunities-api.ts`
 * with a "Mirrors …" docblock, per the repo's dominant convention (see
 * district-nexus.types.ts's note): `packages/shared` is reserved for constants
 * both sides genuinely need at RUNTIME, not for type mirroring.
 *
 * ── The three rules that shape every field below ────────────────────────────
 *
 * 1. THERE IS NO GENERIC `totalAmount`, AND NO BLENDED TOTAL ANYWHERE.
 *    A grant's estimated program funding, a grant's award ceiling, and a
 *    contract's estimated value are different kinds of number. Summing them
 *    produces a figure that is wrong in a way nobody can see. Worse, none of
 *    them is money the client will receive — they are forecasts about a
 *    competition that has not happened. Callers that want a headline number
 *    must pick one and say in the label which one it is.
 *
 * 2. NULL MEANS "WE HAVE NO FIGURE". IT IS NOT ZERO.
 *    SAM.gov's opportunity search publishes no estimated value for an open
 *    solicitation (see `estimatedContractValue`), and a forecasted grant
 *    routinely has no ceiling yet. Rendering either as `$0` states a fact the
 *    source never stated. The UI renders `—` or `Not stated`.
 *
 * 3. RELEVANCE IS NOT ELIGIBILITY.
 *    `relevanceScore` says "this looks like your kind of work". `eligibility`
 *    says "you are, or are not, permitted to apply". An opportunity can be a
 *    perfect thematic match the client is legally barred from. They are
 *    computed independently and reported separately, and eligibility always
 *    carries a human-readable reason.
 */

import type {
  MachineRecommendation,
  RecommendationConfidence,
  RecommendationReasonCode,
} from './opportunity-recommendation.js';

// ── Source and kind vocabularies ────────────────────────────────────────────

/**
 * The sources a USER-FACING read can be asked for today.
 *
 * Deliberately NOT the same list as {@link PLANNED_OPPORTUNITY_SOURCES}. This one
 * gates the API: every DTO, filter and route validates against it, so widening it
 * makes a source requestable. P13 widens the DATABASE's source vocabulary without
 * widening this, which is what "the schema can hold a forecast row, and no code
 * path can produce or serve one" means in practice.
 */
export const OPPORTUNITY_SOURCES = ['grants_gov', 'sam_gov'] as const;
export type OpportunitySource = (typeof OPPORTUNITY_SOURCES)[number];

/**
 * A bounded internal vocabulary, normalized from each source's own taxonomy.
 * Bounded on purpose: SAM.gov's `type` field is free-ish text that has carried
 * at least a dozen spellings, and a UI that switches on the raw value silently
 * mislabels anything new. `other` is the honest bucket for a value we have not
 * taught the normalizer, and it renders as the verbatim source string alongside.
 */
export const OPPORTUNITY_KINDS = [
  'grant',
  'cooperative_agreement',
  'sources_sought',
  'presolicitation',
  'solicitation',
  'combined_synopsis_solicitation',
  'special_notice',
  'amendment',
  'award_notice',
  'other',
] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

/**
 * Kinds that are NOT a live pursuit, whatever their dates say. An award notice
 * announces a competition somebody else already won; a special notice is
 * information, not a solicitation you can respond to. Excluded from the default
 * active view and from the "active" KPI counts — showing them as pursuable is
 * the specific false claim this list exists to prevent.
 */
export const NON_PURSUABLE_KINDS: ReadonlySet<OpportunityKind> = new Set<OpportunityKind>([
  'award_notice',
  'special_notice',
]);

// ── Workflow ────────────────────────────────────────────────────────────────

export const OPPORTUNITY_WORKFLOW_STATUSES = [
  'suggested',
  'saved',
  'pursuing',
  'dismissed',
  'won',
  'lost',
  'expired',
] as const;
export type OpportunityWorkflowStatus = (typeof OPPORTUNITY_WORKFLOW_STATUSES)[number];

/**
 * Statuses that represent a HUMAN DECISION. The deterministic producer may never
 * overwrite one of these, never reassign their owner, and never delete their
 * notes or facility link — re-running a nightly job is not a reason to forget
 * that somebody dismissed an opportunity or is actively bidding it.
 *
 * `suggested` is absent deliberately: that is the producer's own output, and
 * re-scoring it is the producer's job. `expired` is absent because it is a
 * mechanical consequence of the source closing, not a decision.
 */
export const HUMAN_DECISION_STATUSES: ReadonlySet<OpportunityWorkflowStatus> =
  new Set<OpportunityWorkflowStatus>(['saved', 'pursuing', 'dismissed', 'won', 'lost']);

/**
 * Sort priority for the workflow rail — lower sorts first. What a team is
 * actively doing outranks what a machine suggested, regardless of score.
 */
export const WORKFLOW_SORT_PRIORITY: Readonly<Record<OpportunityWorkflowStatus, number>> =
  Object.freeze({
    pursuing: 0,
    saved: 1,
    suggested: 2,
    won: 3,
    lost: 4,
    expired: 5,
    dismissed: 6,
  });

// ── Human decision ──────────────────────────────────────────────────────────

/**
 * What the TEAM decided. Deliberately NOT the same list as
 * `OPPORTUNITY_WORKFLOW_STATUSES`.
 *
 * `monitor` and `pass` have no workflow equivalent, and `suggested` / `expired`
 * are machine states nobody decides. Reusing the workflow vocabulary here is what
 * makes "we chose not to bid this" indistinguishable from "the source closed" —
 * and only one of those is a decision somebody can be asked about later.
 */
export const HUMAN_DECISIONS = ['pursue', 'monitor', 'pass'] as const;
export type HumanDecision = (typeof HUMAN_DECISIONS)[number];

/**
 * The persisted decision and its next action.
 *
 * Separate from both the machine recommendation (recomputed on read, never
 * stored) and the workflow status (where a pursuit is). All three can legitimately
 * disagree, and that disagreement is signal.
 */
export interface OpportunityDecision {
  decision: HumanDecision;
  reason: string | null;
  decidedAt: IsoTimestamp;
  decidedByUserId: string;
  nextAction: string | null;
  nextActionDueAt: IsoTimestamp | null;
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export const ELIGIBILITY_STATES = ['eligible', 'ineligible', 'needs_review', 'unknown'] as const;
export type EligibilityState = (typeof ELIGIBILITY_STATES)[number];

// ── Money and freshness primitives ──────────────────────────────────────────

/**
 * Whole US dollars. Null means "we hold no figure", which is NOT 0. Same
 * convention, and the same reason, as district-nexus.types.ts's `Money`.
 */
export type Money = number | null;

/** ISO-8601 timestamp. */
export type IsoTimestamp = string;

/** `<STATE>-<2-char district code>`, e.g. `TX-23`. Matches DistrictKey. */
export type DistrictKey = string;

/**
 * Health of one Grants.gov detail-enrichment dependency.
 *
 * Reported separately from the catalog sync because they fail INDEPENDENTLY and
 * the difference matters to a reader. `sync-grants` populates ten fields from
 * search2; everything a user actually decides on — eligibility text, award
 * ceiling, cost sharing, the amendment counters — comes from the per-opportunity
 * detail fetch. A green catalog rail with a dead enricher is a page full of
 * grants with no terms on them, which reads as "this grant has no award ceiling"
 * rather than "we have not fetched it".
 */
export interface GrantEnrichmentHealth {
  /** Last enrichment run of any outcome. */
  lastAttemptAt: IsoTimestamp | null;
  /** Last enrichment run that succeeded. */
  lastSuccessAt: IsoTimestamp | null;
  /** True when the most recent attempt failed or reported errors. */
  degraded: boolean | null;
  /** Catalog records that HAVE been detail-enriched. Null = unavailable. */
  detailedRecordCount: number | null;
  /** ACTIVE records still awaiting a detail fetch. Null = unavailable. */
  activeAwaitingEnrichment: number | null;
}

/**
 * When the source rail behind an opportunity last synced, and how it went.
 * Surfaced so a stale rail reads as "contract notices current to 3 Jul", never as
 * "there are no contract opportunities".
 *
 * ── Why a failed run is reported alongside the last success ──────────────────
 *
 * This used to select `DISTINCT ON (source) … WHERE status IN
 * ('success','success_with_errors')`, which means a rail that has been FAILING
 * every night for a week reported the last time it worked and nothing else. The
 * page then said "current to 3 Jul" with no indication that every attempt since
 * had died — the most dangerous possible reading, because it looks healthy.
 *
 * So the latest ATTEMPT is reported independently of the latest SUCCESS, and both
 * are present at once. `lastRunStatus` is the attempt's status, and it being
 * 'error' while `lastSuccessAt` holds a date is exactly the state the old query
 * could not express.
 */
export interface OpportunitySourceFreshness {
  source: OpportunitySource;
  /** The ingestion verb, which is what the runbook and the UI key on. */
  verb: string;
  label: string;
  /**
   * Last SUCCESSFUL sync. Kept under the original name because the UI's "current
   * to …" line means exactly this and nothing else.
   */
  lastSyncedAt: IsoTimestamp | null;
  /** Latest run of ANY outcome, including a failure. */
  lastAttemptAt: IsoTimestamp | null;
  /** The latest attempt's status verbatim ('success' | 'success_with_errors' | 'error' | 'running'). */
  lastRunStatus: string | null;
  /** The latest attempt's error count. */
  lastRunErrorCount: number | null;
  /** Latest run that FAILED outright. Null when the rail has never failed. */
  lastFailureAt: IsoTimestamp | null;
  /** Whole hours since the last success. Null when it has never succeeded. */
  hoursSinceLastSuccess: number | null;
  /** True when the rail has NEVER completed a successful run. */
  neverSynced: boolean;
  /** True when the LATEST ATTEMPT failed or reported errors. */
  lastRunDegraded: boolean | null;
  /** True when catalog counts could not be read. */
  countsUnavailable: boolean;
  /** Count of source records currently in the catalog, active or not. Null = unavailable. */
  recordCount: number | null;
  /** Count of ACTIVE, pursuable source records. Null = unavailable. */
  activeRecordCount: number | null;
  /** Grants.gov only: the detail-enrichment dependency this rail's data depends on. */
  enrichment: GrantEnrichmentHealth | null;
}

// ── Matching explanation ────────────────────────────────────────────────────

/**
 * One reason an opportunity surfaced. `matchedOn` is the verbatim value that
 * matched — never a paraphrase, because the point of the field is that an
 * operator can go check it.
 */
export interface OpportunityMatchedSignal {
  signal: string;
  /** Signal strength band, so the UI can say WHY a weak match is weak. */
  strength: 'strong' | 'moderate' | 'weak';
  weight: number;
  matchedOn: string;
}

/**
 * A client-profile field whose absence is currently costing this client matches.
 * The honest alternative to an empty list with no explanation.
 */
export interface MissingProfileField {
  /** Machine key, e.g. 'naicsCodes'. */
  field: string;
  label: string;
  /** What populating it would unlock, in one sentence. */
  impact: string;
  /** Where the user goes to fix it. */
  href: string | null;
}

// ── The opportunity itself ──────────────────────────────────────────────────

/**
 * Money on an opportunity, kept source-shaped rather than flattened.
 *
 * Grants and contracts do not share a money model: a NOFO publishes a program
 * total plus a per-award floor/ceiling, while a SAM notice publishes, for an
 * open solicitation, nothing at all. Two separate optional blocks make that
 * asymmetry visible in the type instead of hiding it behind one nullable number.
 */
export interface GrantFunding {
  /** Total the PROGRAM expects to award across all recipients. Not this client's. */
  estimatedProgramFunding: Money;
  /** Smallest individual award the notice will make. */
  awardFloor: Money;
  /**
   * Largest individual award the notice will make. A CEILING, not a forecast of
   * what this client would receive — the distinction the UI label must carry.
   */
  awardCeiling: Money;
  expectedAwardCount: number | null;
  /** True when the notice states cost sharing / matching is required. */
  costSharingRequired: boolean | null;
}

export interface ContractValue {
  /**
   * ALWAYS NULL today, and that is a fact about the source, not a TODO.
   *
   * SAM.gov's opportunities/v2 search payload carries no estimated value for a
   * sources-sought, presolicitation, solicitation or combined-synopsis notice.
   * The only dollar figure it ever carries is `award.amount` on an AWARD notice
   * — money already obligated to somebody else, which is not this opportunity's
   * value and must never be shown as one. `basis` records which of those two
   * situations produced the null so the UI can say "Not stated" honestly.
   */
  estimatedValue: Money;
  basis: 'not_stated_by_source' | 'source_backed';
}

/**
 * One opportunity as the API returns it. Fields are null when the SOURCE did not
 * state them, never zero-filled and never inferred from a sibling record.
 */
export interface FundingOpportunity {
  /**
   * Stable composite id, `<source>:<sourceRecordId>`. Composite because the two
   * catalogs have different key spaces (Grants.gov ids are text, SAM notice rows
   * are uuids) and a bare id could collide or be routed to the wrong rail.
   */
  id: string;
  source: OpportunitySource;
  /** The source's own record id — a Grants.gov opportunity id, or a SAM row uuid. */
  sourceRecordId: string;
  /** Human-facing source identifier: opportunity number, or SAM notice id. */
  sourceReference: string | null;
  sourceUrl: string | null;

  kind: OpportunityKind;
  /** The source's verbatim type string, shown when `kind` is 'other'. */
  kindRaw: string | null;
  /**
   * SAM's `baseType` — what the notice STARTED as. Present so an amended
   * solicitation cannot be read as an original one.
   */
  baseKind: OpportunityKind | null;

  title: string;
  agency: string | null;
  subAgency: string | null;
  office: string | null;

  /** The source's own lifecycle word ('posted', 'forecasted', 'closed', 'archived'). */
  status: string | null;
  postedDate: IsoTimestamp | null;
  /** Deadline to respond. Null when the notice states none. */
  responseDeadline: IsoTimestamp | null;
  /**
   * Free text qualifying the deadline ("continuous", "TBD", an explicit ET
   * cutoff). Never parsed into `responseDeadline` — a date alone would be a lie
   * for a rolling application window.
   */
  responseDeadlineNote: string | null;
  /** Grants: close date. SAM: archive date. */
  closeOrArchiveDate: IsoTimestamp | null;
  /** Derived from the source's own flag or its dates — never guessed. */
  isActive: boolean;
  /** False for kinds that are informational rather than pursuable. */
  isPursuable: boolean;

  summary: string | null;
  /**
   * True when `summary` holds a URL rather than prose. SAM's search payload
   * returns EITHER inline text or a link to its description endpoint, and
   * rendering the link as the synopsis looks like corrupt data.
   */
  summaryIsLink: boolean;

  naicsCodes: string[];
  pscCodes: string[];
  setAside: string | null;
  setAsideCode: string | null;
  /** Grants.gov "Eligible Applicants" LABEL strings. Empty = notice did not say. */
  eligibleApplicantTypes: string[];
  /** Assistance Listing / CFDA numbers. */
  assistanceListings: string[];
  fundingInstrument: string | null;
  category: string | null;

  /** Present only for `grants_gov`. */
  grantFunding: GrantFunding | null;
  /** Present only for `sam_gov`. */
  contractValue: ContractValue | null;

  /** Source-stated place of performance, when the notice carries one. */
  placeOfPerformance: {
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
  } | null;
  /**
   * Set ONLY when the source states a place of performance we can resolve, or a
   * human explicitly linked a project site. Never inferred from the client's own
   * footprint — that is how a future opportunity would fabricate district nexus.
   */
  districtKey: DistrictKey | null;
  districtBasis: 'source_place_of_performance' | 'linked_project_site' | null;

  relevanceScore: number;
  eligibility: { state: EligibilityState; reason: string };
  matchedSignals: OpportunityMatchedSignal[];

  /**
   * What to DO with this, and why. Deterministic — see
   * `opportunity-recommendation.ts`. Additive in P06 and NOT persisted: it is
   * recomputed from the same source facts on every read, so it cannot go stale
   * against a profile that has since changed.
   *
   * A fourth concept alongside relevance, eligibility and workflow status, not a
   * replacement for any of them. Null only on the unscoped catalog read, where
   * there is no client to recommend anything relative to.
   */
  recommendation: OpportunityRecommendationView | null;
  missingProfileFields: MissingProfileField[];

  /** When the source record itself was last refreshed by ingestion. */
  sourceUpdatedAt: IsoTimestamp | null;

  /** Null when no workflow row exists yet — the common case for a suggestion. */
  workflow: OpportunityWorkflow | null;

  /**
   * The team's persisted decision, or null when nobody has decided yet.
   *
   * Null is the honest state for every producer-created suggestion. It is NOT the
   * same as `pass`: "nobody has looked at this" and "we looked and declined" are
   * different facts, and a default would erase the difference for the whole corpus.
   */
  decision: OpportunityDecision | null;

  /** The client this scoring is relative to. Null on the unscoped catalog read. */
  clientId: string | null;
}

/**
 * The read-model of a recommendation. Mirrors
 * `OpportunityRecommendationResult`; kept as its own interface so the response
 * contract does not import the rule engine's internal types.
 */
export interface OpportunityRecommendationView {
  machineRecommendation: MachineRecommendation;
  /** Evidence quality. NEVER a probability of winning. */
  recommendationConfidence: RecommendationConfidence;
  primaryReason: string;
  /** The strongest reason not to act, or null when there is none worth naming. */
  primaryRisk: string | null;
  recommendedNextAction: string;
  reasonCodes: RecommendationReasonCode[];
}

export interface OpportunityWorkflow {
  id: string;
  status: OpportunityWorkflowStatus;
  owner: { userId: string; name: string | null; email: string | null } | null;
  facility: { id: string; name: string; state: string | null; districtKey: DistrictKey | null } | null;
  notes: string | null;
  dismissedReason: string | null;
  outcomeNote: string | null;
  /** True when a human, not the producer, created this row. */
  userCreated: boolean;
  /** Set when the producer judged its own suggestion no longer relevant. */
  staleAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

// ── List responses ──────────────────────────────────────────────────────────

/**
 * Why a list came back empty. `null` when it did not.
 *
 * A failed request is NOT one of these values — a request that failed returns a
 * non-2xx and the UI renders an error. Collapsing "the call broke" into "no
 * results" is the single most misleading thing this endpoint could do, so the
 * two are structurally different outcomes.
 */
export type EmptyReason =
  | 'no_source_records'
  | 'source_never_synced'
  | 'client_profile_too_thin'
  | 'no_match_above_threshold'
  | 'no_saved_opportunities'
  | 'no_results_for_filters';

export interface FundingOpportunityCounts {
  /** Active, pursuable Grants.gov opportunities above threshold. */
  activeGrants: number;
  /** Active, pursuable SAM.gov contract opportunities above threshold. */
  activeContracts: number;
  saved: number;
  pursuing: number;
  dismissed: number;
  /** Deadlines falling within the next 30 days across both rails. */
  deadlinesIn30Days: number;
}

export interface FundingOpportunityListResponse {
  opportunities: FundingOpportunity[];
  /** Total matching the filters BEFORE pagination, capped at the scan bound. */
  total: number;
  /** True when `total` hit the scan bound and there may be more. */
  totalIsCapped: boolean;
  page: number;
  pageSize: number;
  counts: FundingOpportunityCounts;
  freshness: OpportunitySourceFreshness[];
  /** Populated only when `opportunities` is empty. */
  emptyReason: EmptyReason | null;
  /** Operator-readable expansion of `emptyReason`. */
  emptyExplanation: string | null;
  missingProfileFields: MissingProfileField[];
  generatedAt: IsoTimestamp;
}

/**
 * The persistent client-profile card. Always renders, even at zero matches —
 * hiding it makes "we found nothing" indistinguishable from "this feature does
 * not exist for you".
 */
export interface ClientFundingOpportunitySummary {
  clientId: string;
  counts: FundingOpportunityCounts;
  nextDeadline: {
    opportunityId: string;
    title: string;
    source: OpportunitySource;
    responseDeadline: IsoTimestamp;
  } | null;
  topGrants: FundingOpportunity[];
  topContracts: FundingOpportunity[];
  missingProfileFields: MissingProfileField[];
  freshness: OpportunitySourceFreshness[];
  emptyReason: EmptyReason | null;
  emptyExplanation: string | null;
  generatedAt: IsoTimestamp;
}
