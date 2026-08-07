/**
 * Mirrors apps/api/src/funding-opportunities/funding-opportunities.types.ts.
 *
 * Hand-mirrored per the repo's dominant convention (see
 * district-nexus-api.ts's own note): `packages/shared` is reserved for constants
 * both sides genuinely need at RUNTIME, not for type mirroring.
 *
 * The three rules the API side enforces, restated because the UI is where they
 * become visible or get broken:
 *
 *   1. NO blended dollar total. Grants and contracts are counted separately and
 *      labelled separately.
 *   2. NULL money renders as `—` or `Not stated`, never `$0`.
 *   3. Relevance and eligibility are shown as two different things.
 */

export type OpportunitySource = 'grants_gov' | 'sam_gov';

export type OpportunityKind =
  | 'grant'
  | 'cooperative_agreement'
  | 'sources_sought'
  | 'presolicitation'
  | 'solicitation'
  | 'combined_synopsis_solicitation'
  | 'special_notice'
  | 'amendment'
  | 'award_notice'
  | 'other';

export type OpportunityWorkflowStatus =
  | 'suggested'
  | 'saved'
  | 'pursuing'
  | 'dismissed'
  | 'won'
  | 'lost'
  | 'expired';

export type EligibilityState = 'eligible' | 'ineligible' | 'needs_review' | 'unknown';

export type Money = number | null;

/** Grants.gov detail-enrichment dependency health. Null for SAM, which has none. */
export interface GrantEnrichmentHealth {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  degraded: boolean | null;
  detailedRecordCount: number | null;
  activeAwaitingEnrichment: number | null;
}

export interface OpportunitySourceFreshness {
  source: OpportunitySource;
  verb: string;
  label: string;
  /** Last SUCCESSFUL sync — what "current to …" means. */
  lastSyncedAt: string | null;
  /** Latest run of ANY outcome, including a failure. */
  lastAttemptAt: string | null;
  lastRunStatus: string | null;
  lastRunErrorCount: number | null;
  lastFailureAt: string | null;
  hoursSinceLastSuccess: number | null;
  neverSynced: boolean;
  /** Keyed on the LATEST ATTEMPT, so last night's failure degrades the rail. */
  lastRunDegraded: boolean | null;
  countsUnavailable: boolean;
  recordCount: number | null;
  activeRecordCount: number | null;
  enrichment: GrantEnrichmentHealth | null;
}

export interface OpportunityMatchedSignal {
  signal: string;
  strength: 'strong' | 'moderate' | 'weak';
  weight: number;
  matchedOn: string;
}

export interface MissingProfileField {
  field: string;
  label: string;
  impact: string;
  href: string | null;
}

export interface GrantFunding {
  estimatedProgramFunding: Money;
  awardFloor: Money;
  awardCeiling: Money;
  expectedAwardCount: number | null;
  costSharingRequired: boolean | null;
}

export interface ContractValue {
  estimatedValue: Money;
  basis: 'not_stated_by_source' | 'source_backed';
}

export const MACHINE_RECOMMENDATIONS = ['pursue', 'monitor', 'pass', 'needs_review'] as const;
export type MachineRecommendation = (typeof MACHINE_RECOMMENDATIONS)[number];

export const RECOMMENDATION_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type RecommendationConfidence = (typeof RECOMMENDATION_CONFIDENCES)[number];

/** Mirrors OpportunityRecommendationView in apps/api. */
export interface OpportunityRecommendationView {
  machineRecommendation: MachineRecommendation;
  /**
   * EVIDENCE QUALITY, not a probability of winning. A high-confidence `pass` is a
   * confident recommendation NOT to bid — rendering this as a win rate would be
   * the most misleading thing the UI could do with it.
   */
  recommendationConfidence: RecommendationConfidence;
  primaryReason: string;
  primaryRisk: string | null;
  recommendedNextAction: string;
  reasonCodes: string[];
}

/** Mirrors ACQUISITION_POSITION_STATES in apps/api's acquisition-position.ts. */
export const ACQUISITION_POSITION_STATES = [
  'direct_prime_access',
  'related_entity_access',
  'known_teaming_route',
  'vehicle_not_identified',
  'no_direct_access_evidence',
  'unknown',
] as const;
export type AcquisitionPositionState = (typeof ACQUISITION_POSITION_STATES)[number];

export type AcquisitionRelationship = 'self' | 'parent' | 'teaming';

export interface AcquisitionVehicleEvidence {
  tangoVehicleId: string;
  vehicleName: string | null;
  vehicleType: string | null;
  relationship: AcquisitionRelationship;
  recipientUei: string;
  orderCount: number | null;
  idvObligations: number | null;
  idvContractsValue: number | null;
  lastDateToOrder: string | null;
  expired: boolean | null;
  lastSyncedAt: string;
}

/**
 * Mirrors AcquisitionPosition in apps/api. A credible PATH to an acquisition
 * — never legal eligibility (`eligibility`) and never a probability of
 * winning (`recommendation.recommendationConfidence`). See
 * AcquisitionPositionPanel.tsx's own doc for the UI-copy rules this powers.
 */
export interface AcquisitionPosition {
  state: AcquisitionPositionState;
  evidence: AcquisitionVehicleEvidence[];
  summary: string;
  recommendedRoute: string;
  source: 'tango';
  freshness: { lastSyncedAt: string | null; neverSynced: boolean };
}

export const HUMAN_DECISIONS = ['pursue', 'monitor', 'pass'] as const;
export type HumanDecision = (typeof HUMAN_DECISIONS)[number];

/**
 * Mirrors OpportunityDecision in apps/api.
 *
 * Deliberately NOT the same vocabulary as OpportunityWorkflowStatus: `monitor` and
 * `pass` have no workflow equivalent, and `suggested`/`expired` are machine states
 * nobody decides.
 */
export interface OpportunityDecision {
  decision: HumanDecision;
  reason: string | null;
  decidedAt: string;
  decidedByUserId: string;
  nextAction: string | null;
  nextActionDueAt: string | null;
}

export interface OpportunityWorkflow {
  id: string;
  status: OpportunityWorkflowStatus;
  owner: { userId: string; name: string | null; email: string | null } | null;
  facility: { id: string; name: string; state: string | null; districtKey: string | null } | null;
  notes: string | null;
  dismissedReason: string | null;
  outcomeNote: string | null;
  userCreated: boolean;
  staleAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FundingOpportunity {
  id: string;
  source: OpportunitySource;
  sourceRecordId: string;
  sourceReference: string | null;
  sourceUrl: string | null;
  kind: OpportunityKind;
  kindRaw: string | null;
  baseKind: OpportunityKind | null;
  title: string;
  agency: string | null;
  subAgency: string | null;
  office: string | null;
  status: string | null;
  postedDate: string | null;
  responseDeadline: string | null;
  responseDeadlineNote: string | null;
  closeOrArchiveDate: string | null;
  isActive: boolean;
  isPursuable: boolean;
  summary: string | null;
  summaryIsLink: boolean;
  naicsCodes: string[];
  pscCodes: string[];
  setAside: string | null;
  setAsideCode: string | null;
  eligibleApplicantTypes: string[];
  assistanceListings: string[];
  fundingInstrument: string | null;
  category: string | null;
  grantFunding: GrantFunding | null;
  contractValue: ContractValue | null;
  placeOfPerformance: {
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
  } | null;
  districtKey: string | null;
  districtBasis: 'source_place_of_performance' | 'linked_project_site' | null;
  relevanceScore: number;
  eligibility: { state: EligibilityState; reason: string };
  matchedSignals: OpportunityMatchedSignal[];
  /**
   * What to do with this, and why. Null on the unscoped catalog read, where there
   * is no client to recommend anything relative to.
   *
   * P06 adds the field; P09 renders it. Nothing in the UI reads it yet, and that
   * is deliberate — an additive API field deploys before the web that consumes it.
   */
  recommendation: OpportunityRecommendationView | null;
  /**
   * Null when there is no client, the source is `grants_gov` (no contract
   * vehicle concept), or `funding_opportunities_vehicle_fit` is off for this
   * tenant — in which case every other field is byte-for-byte what P22
   * returned.
   */
  acquisitionPosition: AcquisitionPosition | null;
  /**
   * The team's persisted DECISION, or null when nobody has decided yet.
   *
   * Null is NOT the same as `pass`: "nobody has looked at this" and "we looked and
   * declined" are different facts, which is why the column has no default.
   *
   * Separate from `workflow.status` (where a pursuit is) and from
   * `recommendation` (recomputed on read). All three can legitimately disagree.
   */
  decision: OpportunityDecision | null;
  missingProfileFields: MissingProfileField[];
  sourceUpdatedAt: string | null;
  workflow: OpportunityWorkflow | null;
  clientId: string | null;
}

export type EmptyReason =
  | 'no_source_records'
  | 'source_never_synced'
  | 'client_profile_too_thin'
  | 'no_match_above_threshold'
  | 'no_saved_opportunities'
  | 'no_results_for_filters';

export interface FundingOpportunityCounts {
  activeGrants: number;
  activeContracts: number;
  saved: number;
  pursuing: number;
  dismissed: number;
  deadlinesIn30Days: number;
}

export interface FundingOpportunityListResponse {
  opportunities: FundingOpportunity[];
  total: number;
  totalIsCapped: boolean;
  page: number;
  pageSize: number;
  counts: FundingOpportunityCounts;
  freshness: OpportunitySourceFreshness[];
  emptyReason: EmptyReason | null;
  emptyExplanation: string | null;
  missingProfileFields: MissingProfileField[];
  generatedAt: string;
}

export interface ClientFundingOpportunitySummary {
  clientId: string;
  counts: FundingOpportunityCounts;
  nextDeadline: {
    opportunityId: string;
    title: string;
    source: OpportunitySource;
    responseDeadline: string;
  } | null;
  topGrants: FundingOpportunity[];
  topContracts: FundingOpportunity[];
  missingProfileFields: MissingProfileField[];
  freshness: OpportunitySourceFreshness[];
  emptyReason: EmptyReason | null;
  emptyExplanation: string | null;
  generatedAt: string;
}

// ── The cross-client triage inbox ───────────────────────────────────────────

/**
 * Mirrors INBOX_FILTERS in apps/api's funding-opportunity-inbox.service.ts.
 *
 * ORDER IS THE TAB ORDER. `needs_review` is first because it is the API default
 * and the question the surface exists to answer; `passed` is last because it is
 * history.
 */
export const INBOX_FILTERS = [
  'needs_review',
  'pursuing',
  'deadlines',
  'recently_changed',
  'monitoring',
  'passed',
] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export const INBOX_FILTER_LABELS: Record<InboxFilter, string> = {
  needs_review: 'Needs review',
  pursuing: 'Pursuing',
  deadlines: 'Deadlines',
  recently_changed: 'Recently changed',
  monitoring: 'Monitoring',
  passed: 'Passed',
};

/**
 * What each queue actually contains, for the empty state and the tab tooltip.
 *
 * Written as facts about the DATA rather than instructions, because an empty
 * queue's job is to say what would have to be true for a row to appear here.
 */
export const INBOX_FILTER_DESCRIPTIONS: Record<InboxFilter, string> = {
  needs_review: 'Machine suggestions nobody has decided on yet, whose source is still open.',
  pursuing: 'Opportunities somebody decided to pursue, or whose workflow is already pursuing.',
  deadlines: 'Dated, still-open opportunities nobody has passed on.',
  recently_changed: 'Everything the sources or the team touched most recently, passes excluded.',
  monitoring: 'Opportunities a human decided to watch rather than bid.',
  passed: 'Opportunities the team declined. Kept, because a decision is a durable fact.',
};

/**
 * Mirrors INBOX_SOURCES in apps/api's funding-opportunity-inbox.service.ts.
 *
 * DELIBERATELY WIDER than {@link OpportunitySource}, which is the catalog's
 * vocabulary. `agency_forecast` rows can appear in the inbox and can be filtered
 * to, but a forecast is never servable as a `FundingOpportunity` — it has no
 * response deadline, no eligibility determination and no money, and a
 * `FundingOpportunity` shape with holes where those three go reads as "closed",
 * "not eligible" and "$0".
 */
export const INBOX_SOURCES = ['grants_gov', 'sam_gov', 'agency_forecast'] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

export const FORECAST_SOURCE = 'agency_forecast' as const;

export function isForecastRow(row: { source: string }): boolean {
  return row.source === FORECAST_SOURCE;
}

/**
 * Mirrors InboxForecastFacts in apps/api.
 *
 * Every field is verbatim from the provider. Null means the agency stated
 * nothing — never zero, never "no", and never a closed competition.
 */
export interface InboxForecastFacts {
  /**
   * `YYYY-MM-DD`. The agency's own rough estimate of when it expects to award,
   * and NEVER a response deadline — there is nothing to respond to yet.
   *
   * A date-only string on purpose (the column is a Postgres DATE): parsing it
   * with `new Date()` and formatting in local time is what shifts a stated March
   * award into February for every reader west of Greenwich. Use
   * {@link formatSourceDate}.
   */
  anticipatedAwardDate: string | null;
  /**
   * ALWAYS NULL. This provider resource carries no anticipated-solicitation date
   * at all, so the UI says "not provided by the source" rather than omitting a
   * field the reader was told to expect.
   */
  anticipatedSolicitationDate: null;
  /** Free text, e.g. "Q3 FY27". Not a date. */
  estimatedPeriod: string | null;
  fiscalYear: number | null;
  /** The agency system the forecast came from, e.g. an APFS instance. */
  sourceSystem: string | null;
  /** The provider's own lifecycle word. Never rewritten into "open"/"closed". */
  status: string | null;
  /** `false` = the agency withdrew it. `null` = never stated, which is NOT closed. */
  isActive: boolean | null;
  lastSyncedAt: string | null;
  providerModifiedAt: string | null;
}

/** Mirrors InboxRow in apps/api. One CLIENT-OPPORTUNITY decision context. */
export interface InboxRow {
  id: string;
  client: { id: string; name: string };
  /** Includes `agency_forecast` — see {@link INBOX_SOURCES}. */
  source: InboxSource;
  sourceRecordId: string;
  title: string;
  agency: string | null;
  /** Populated ONLY on an `agency_forecast` row. Null on every other rail. */
  forecast: InboxForecastFacts | null;
  responseDeadline: string | null;
  daysUntilDeadline: number | null;
  workflowStatus: string;
  humanDecision: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  owner: { userId: string; name: string | null; email: string | null } | null;
  relevanceScore: number | null;
  eligibility: { state: string | null; reason: string | null };
  /** The producer stopped suggesting this, but a human decision stands. */
  noLongerSuggested: boolean;
  /** The SOURCE has closed since it was last observed. */
  sourceClosed: boolean;
  updatedAt: string;
}

/** Mirrors InboxResponse in apps/api. */
export interface InboxResponse {
  filter: InboxFilter;
  /**
   * The client narrowing the server ACTUALLY applied, which is not necessarily
   * the one requested: a walled or unknown id is dropped and reported as null.
   * Render from this, never from the request parameter.
   */
  clientId: string | null;
  /**
   * The source narrowing the server applied, or null for every rail. Source is a
   * FILTER on this surface, never the top-level model.
   */
  source: InboxSource | null;
  rows: InboxRow[];
  nextCursor: string | null;
  pageSize: number;
  counts: Record<InboxFilter, number>;
  /** Counts across every visible client. Non-null only when `clientId` narrows. */
  countsAllClients: Record<InboxFilter, number> | null;
  /**
   * Non-null when a count could not be read. The counts then hold -1, because
   * "we could not count" and "there are none" are different facts.
   */
  countsUnavailableReason: string | null;
  generatedAt: string;
}

/** A count of -1 means "unreadable", not "none". Never render it as a number. */
export function formatInboxCount(n: number | undefined): string {
  if (n == null) return '—';
  return n < 0 ? '?' : String(n);
}

// ── Agency forecasts (P26) ──────────────────────────────────────────────────

/**
 * Mirrors FORECAST_RECOMMENDATIONS in apps/api's opportunity-recommendation.ts.
 *
 * `shape_now` is the forecast-specific distinction the common
 * `MachineRecommendation` vocabulary deliberately erases: a forecast worth
 * acting on is worth SHAPING — briefing the program office, finding a partner,
 * getting requirements right — never bidding, because there is nothing to bid
 * on. There is no `pursue` in this list, and the API's own mapping can never
 * produce one for a forecast.
 */
export const FORECAST_RECOMMENDATIONS = ['shape_now', 'monitor', 'pass', 'needs_review'] as const;
export type ForecastRecommendation = (typeof FORECAST_RECOMMENDATIONS)[number];

export const FORECAST_RECOMMENDATION_LABELS: Record<ForecastRecommendation, string> = {
  shape_now: 'Shape now',
  monitor: 'Monitor',
  pass: 'Pass',
  needs_review: 'Needs review',
};

export const FORECAST_RECOMMENDATION_COLORS: Record<ForecastRecommendation, string> = {
  shape_now: 'geekblue',
  monitor: 'blue',
  pass: 'default',
  needs_review: 'orange',
};

/**
 * The four actions a forecast offers. Mirrors FORECAST_ACTIONS in apps/api.
 *
 * `Pursue` and `Submit` are ABSENT by construction, not by styling: there is no
 * solicitation to submit against and no response window to pursue within, so
 * offering either would invite a team to act on a competition that does not
 * exist. A human who wants to treat a forecast as a pursuit has to qualify a
 * real notice first.
 */
export const FORECAST_ACTIONS = [
  'monitor',
  'assign_research',
  'plan_capability_briefing',
  'pass',
] as const;
export type ForecastAction = (typeof FORECAST_ACTIONS)[number];

export const FORECAST_ACTION_LABELS: Record<ForecastAction, string> = {
  monitor: 'Monitor',
  assign_research: 'Assign research',
  plan_capability_briefing: 'Plan capability briefing',
  pass: 'Pass',
};

/** Mirrors ForecastSignalEvidence in apps/api. */
export interface ForecastSignalEvidence {
  exactNaicsMatch: boolean;
  exactPscMatch: boolean;
  capabilityMatch: boolean;
  priorAgencyHistory: boolean;
  programElementLinkedSourceBacked: boolean;
  locationMatch: boolean;
  knownVehicleAccess: boolean;
  reviewedStrategicPriority: boolean;
  /**
   * Signals that could not be evaluated AT ALL, with the reason for each.
   *
   * Not a synonym for `false`. "The provider states no product/service code" is
   * a fact about the source; rendering it as an unticked box would state an
   * absence of the client's fit instead.
   */
  unavailable: Array<{ signal: string; reason: string }>;
}

/** Mirrors ForecastRecommendationView in apps/api. */
export interface ForecastRecommendationView {
  forecastRecommendation: ForecastRecommendation;
  /** The common vocabulary. NEVER 'pursue' for a forecast. */
  machineRecommendation: MachineRecommendation;
  /** EVIDENCE QUALITY. Never a probability of winning, and never a probability
   * that the forecast becomes a real solicitation. */
  recommendationConfidence: RecommendationConfidence;
  primaryReason: string;
  primaryRisk: string | null;
  recommendedNextAction: string;
  reasonCodes: string[];
  signals: ForecastSignalEvidence;
}

/**
 * Mirrors ForecastOpportunityRecord in apps/api.
 *
 * Deliberately NOT a {@link FundingOpportunity}: no `responseDeadline`, no
 * `eligibility`, no money. See the API service's own doc.
 */
export interface ForecastOpportunityRecord {
  source: typeof FORECAST_SOURCE;
  sourceRecordId: string;
  externalId: string | null;
  title: string;
  description: string | null;
  agency: string | null;
  departmentName: string | null;
  organizationAgencyName: string | null;
  officeName: string | null;
  facts: InboxForecastFacts;
  naicsCode: string | null;
  /** ALWAYS NULL — confirmed absent from this provider resource. */
  pscCode: string | null;
  setAside: string | null;
  contractVehicle: string | null;
  placeOfPerformance: string | null;
  primaryContact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    title: string | null;
  } | null;
  /** ALWAYS NULL — confirmed absent from this provider resource. */
  sourceUrl: string | null;
  recommendation: ForecastRecommendationView | null;
  clientId: string | null;
  decision: OpportunityDecision | null;
  workflow: { id: string; status: string } | null;
  /**
   * ALWAYS NULL today. "Not yet linked", never "no solicitation followed" — the
   * only honest way to link a forecast to a later notice is an exact identifier
   * the provider does not publish, and inferring one from title text is the
   * fuzzy identity matching this codebase forbids outright.
   */
  linkedOpportunity: null;
  missingProfileFields: MissingProfileField[];
  generatedAt: string;
}

/** The forecast surface's own flag. Byte-matches the API guard's constant. */
export const FUNDING_OPPORTUNITIES_FORECASTS_FEATURE = 'funding_opportunities_forecasts';

/** The forecast read route for one provider forecast id. */
export function forecastDetailApiPath(forecastId: string, clientId: string | null): string {
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return `/api/intelligence/opportunities/forecasts/${encodeURIComponent(forecastId)}${query}`;
}

/**
 * A source-stated `YYYY-MM-DD` for display, WITHOUT a timezone round trip.
 *
 * `new Date('2027-03-01')` is parsed as UTC midnight and then rendered in local
 * time, so every reader west of Greenwich sees 28 February — an agency's stated
 * award month moved by a day. Formatting from the parts avoids the instant
 * entirely, which is correct because a DATE has no instant.
 *
 * Returns the placeholder for null, and the raw string for anything that is not
 * a plain date — echoing an unexpected source value verbatim beats guessing.
 */
export function formatSourceDate(
  value: string | null,
  // The default is the SOURCE-absence sentence, not a bare "Not provided": every
  // caller on this surface is rendering a field the agency did or did not state,
  // and "Not provided" alone is ambiguous about whose gap it is.
  placeholder = 'Not provided by the source',
): string {
  if (!value) return placeholder;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = MONTHS[Number(mo) - 1] ?? mo;
  return `${Number(d)} ${month} ${y}`;
}

/**
 * The forecast rail's freshness line.
 *
 * A forecast's staleness matters MORE than a live notice's, not less: an agency
 * revises a forecast quietly and often, so "last observed 6 Aug" is the reader's
 * only cue that a shape-now recommendation might be acting on a withdrawn plan.
 */
export function formatForecastFreshness(facts: InboxForecastFacts): string {
  if (!facts.lastSyncedAt) return 'Never observed by Capiro';
  const observed = `Last observed ${shortDate(facts.lastSyncedAt)}`;
  if (!facts.providerModifiedAt) return `${observed} · agency states no revision date`;
  return `${observed} · agency last revised ${shortDate(facts.providerModifiedAt)}`;
}

// ── Notice history and the material-change timeline (P28) ───────────────────

/** The notice-history flag. Byte-matches the API guard's own constant. */
export const FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE =
  'funding_opportunities_notice_history';

/** Mirrors CHANGE_SEVERITIES in apps/api's opportunity-change-classifier.ts. */
export const CHANGE_SEVERITIES = ['critical', 'significant', 'informational'] as const;
export type ChangeSeverity = (typeof CHANGE_SEVERITIES)[number];

/**
 * The band names as a reader sees them.
 *
 * The split is about ACTION, not about size: a deadline or a cancellation
 * changes whether and when a team can respond at all.
 */
export const CHANGE_SEVERITY_LABELS: Record<ChangeSeverity, string> = {
  critical: 'Affects whether you can respond',
  significant: 'Affects whether you may respond',
  informational: 'Worth seeing',
};

export const CHANGE_SEVERITY_COLORS: Record<ChangeSeverity, string> = {
  critical: 'red',
  significant: 'orange',
  informational: 'blue',
};

/** Mirrors MaterialChange in apps/api. */
export interface MaterialChange {
  dimension: string;
  severity: ChangeSeverity;
  /** Verbatim previous value. Null means it was absent. */
  before: string | null;
  /** Verbatim new value. Null means it became absent. */
  after: string | null;
  /**
   * The composed sentence. NEVER a generic "the notice was updated" — that
   * label is the thing P28 exists to replace, because it tells a reader nothing
   * they can act on.
   */
  summary: string;
}

/** Mirrors TimelineEntry in apps/api. */
export interface TimelineEntry {
  tangoNoticeId: string;
  title: string | null;
  postedDate: string | null;
  providerUpdatedAt: string | null;
  sourceUrl: string | null;
  /** True for the earliest notice: there is nothing before it to compare against. */
  isFirstObservation: boolean;
  changes: MaterialChange[];
}

/** Mirrors OpportunityTimelineResponse in apps/api. */
export interface OpportunityTimelineResponse {
  source: OpportunitySource;
  sourceRecordId: string;
  entries: TimelineEntry[];
  changeCount: number;
  bySeverity: Record<ChangeSeverity, number>;
  /**
   * Change dimensions the provider states nothing about on a notice, with the
   * reason for each. Rendered rather than omitted: a reader who knows the
   * timeline misses stage transitions can go check the source; a reader who was
   * never told assumes it covers everything.
   */
  unsupported: Array<{ dimension: string; reason: string }>;
  /**
   * Why the timeline is the length it is. `no_notices_synced` and
   * `not_crosswalked` are both "Capiro cannot say", NOT "the solicitation was
   * never amended".
   */
  coverage: 'available' | 'no_notices_synced' | 'not_crosswalked';
  coverageExplanation: string;
  generatedAt: string;
}

export function timelineApiPath(source: string, sourceRecordId: string): string {
  return `/api/intelligence/opportunities/${encodeURIComponent(source)}/${encodeURIComponent(sourceRecordId)}/timeline`;
}

// ── Requirements extracted from documents (P31) ──────────────────────────────

/** The documents flag. Gates attachments (P29), text (P30) and requirements (P31). */
export const FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE = 'funding_opportunities_documents';

/** Mirrors REQUIREMENT_TYPES in apps/api's opportunity-requirement.schema.ts. */
export const REQUIREMENT_TYPE_LABELS: Record<string, string> = {
  technical: 'Technical',
  deliverable: 'Deliverable',
  evaluation: 'Evaluation criteria',
  past_performance: 'Past performance',
  clearance_security: 'Clearance / security',
  vehicle: 'Contract vehicle',
  certification: 'Certification',
  place_of_performance: 'Place of performance',
  submission: 'Submission',
  question_deadline: 'Question deadline',
  key_date: 'Key date',
};

/**
 * One extracted requirement, with the citation that makes it checkable.
 *
 * There is no shape here that carries a statement WITHOUT its excerpt, span and
 * document. A compliance list nobody can check against the source invites a
 * team to build a proposal against Capiro's paraphrase.
 */
export interface OpportunityRequirementView {
  id: string;
  requirementType: string;
  statement: string;
  /** VERBATIM from the document. Never a paraphrase. */
  sourceExcerpt: string;
  excerptStart: number;
  excerptEnd: number;
  sourcePage: number | null;
  fileName: string | null;
  extractionMethod: string;
  extractionModel: string;
  /** Evidence quality. NEVER a probability that the requirement is real. */
  confidence: string;
  /** 'pending' | 'accepted' | 'rejected'. A candidate is not a conclusion. */
  reviewStatus: string;
  /** Set when the document changed after this was extracted. */
  supersededAt: string | null;
}

export interface OpportunityRequirementsResponse {
  source: OpportunitySource;
  sourceRecordId: string;
  requirements: OpportunityRequirementView[];
  /**
   * Why the list is the length it is. Only `read_none_found` is a fact about the
   * solicitation; the other two are facts about Capiro's coverage.
   */
  coverage: 'available' | 'no_documents' | 'no_text' | 'read_none_found';
  coverageExplanation: string;
  /** P30's per-document text status, carried through verbatim rather than re-summarised. */
  documentTextStatus: Array<{ fileName: string | null; status: string; explanation: string }>;
  generatedAt: string;
}

export function requirementsApiPath(source: string, sourceRecordId: string): string {
  return `/api/intelligence/opportunities/${encodeURIComponent(source)}/${encodeURIComponent(sourceRecordId)}/requirements`;
}

// ── Opportunity identity, in one place ──────────────────────────────────────

/**
 * What it takes to name ONE opportunity for ONE client.
 *
 * Three parts, not two. `clientId` is part of the identity because the detail
 * surface shows relevance, eligibility, the recommendation and the team's
 * decision — every one of which is a fact about a client-opportunity PAIR. The
 * same SAM notice is a different thing for two different clients, and a link that
 * dropped the client would silently render the unscored catalog view instead.
 */
export interface OpportunityRef {
  /**
   * Includes `agency_forecast` (P26). The ref names a RECORD to open, and both
   * detail bodies are reached the same way — which is what keeps the drawer, the
   * full page and the `?detail=` deep link from needing three sets of rules.
   * What the two bodies then render is completely different; see
   * ForecastOpportunityDetail.
   */
  source: InboxSource;
  sourceRecordId: string;
  /** Null on the unscoped catalog read, where there is nothing to score against. */
  clientId: string | null;
}

/**
 * A ref that names a CATALOG record specifically.
 *
 * `FundingOpportunityDetail` takes this rather than {@link OpportunityRef}, so
 * "this body cannot render a forecast" is enforced by the compiler instead of by
 * a comment. The drawer and the route narrow to it after dispatching on source.
 */
export interface CatalogOpportunityRef extends OpportunityRef {
  source: OpportunitySource;
}

/**
 * Narrow a ref to the catalog, or null for a forecast.
 *
 * A function rather than an inline ternary at each call site because TypeScript
 * cannot narrow an OBJECT by testing one of its properties — `ref.source === 'x'`
 * narrows `ref.source`, not `ref` — so every dispatch site would otherwise need
 * its own cast, and a cast is exactly the thing that stops the compiler noticing
 * when a third record type arrives.
 */
export function asCatalogRef(ref: OpportunityRef): CatalogOpportunityRef | null {
  return isOpportunitySource(ref.source) ? { ...ref, source: ref.source } : null;
}

/**
 * Encoded for a single URL parameter, so the inbox drawer is deep-linkable and the
 * browser Back button closes it.
 *
 * Every part is `encodeURIComponent`d before joining. Grants.gov opportunity
 * numbers are free-form source strings — a colon or a slash in one would otherwise
 * split the ref into the wrong pieces, which is the kind of bug that only shows up
 * on the one record that happens to contain the character.
 */
export function encodeOpportunityRef(ref: OpportunityRef): string {
  return [ref.source, ref.sourceRecordId, ref.clientId ?? '']
    .map((part) => encodeURIComponent(part))
    .join(':');
}

/** Returns null for anything malformed. A bad ref renders not-found, never a crash. */
export function decodeOpportunityRef(raw: string | null): OpportunityRef | null {
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  let decoded: string[];
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  const [source, sourceRecordId, clientId] = decoded as [string, string, string];
  if (!isInboxSource(source) || !sourceRecordId) return null;
  return { source, sourceRecordId, clientId: clientId || null };
}

/** The CATALOG vocabulary: the two rails a `FundingOpportunity` can come from. */
export function isOpportunitySource(value: string): value is OpportunitySource {
  return value === 'grants_gov' || value === 'sam_gov';
}

/**
 * The INBOX/detail vocabulary: the catalog's two rails plus agency forecasts.
 *
 * Kept as a second predicate rather than a widening of the first, because the two
 * answer different questions: `isOpportunitySource` gates "can this be fetched as
 * a `FundingOpportunity`", which a forecast never can.
 */
export function isInboxSource(value: string): value is InboxSource {
  return (INBOX_SOURCES as readonly string[]).includes(value);
}

/** The full-page detail route for a ref. The drawer and this render the same body. */
export function opportunityDetailPath(ref: OpportunityRef): string {
  const query = ref.clientId ? `?clientId=${encodeURIComponent(ref.clientId)}` : '';
  return `/intelligence/opportunities/${ref.source}/${encodeURIComponent(ref.sourceRecordId)}${query}`;
}

// ── Display helpers ─────────────────────────────────────────────────────────

/** The intel-api flag key gating the whole surface. Byte-matches the API guard. */
export const FUNDING_OPPORTUNITIES_FEATURE = 'funding_opportunities';

/**
 * The client-first inbox flag. Byte-matches
 * FUNDING_OPPORTUNITIES_INBOX_FEATURE in the API's flag guard.
 *
 * SEPARATE from the master flag on purpose: the inbox changes what the default
 * experience IS, so a tenant already using the catalog keeps it until this is
 * explicitly turned on for them.
 */
export const FUNDING_OPPORTUNITIES_INBOX_FEATURE = 'funding_opportunities_client_inbox';

export const KIND_LABELS: Record<OpportunityKind, string> = {
  grant: 'Grant',
  cooperative_agreement: 'Cooperative agreement',
  sources_sought: 'Sources sought',
  presolicitation: 'Presolicitation',
  solicitation: 'Solicitation',
  combined_synopsis_solicitation: 'Combined synopsis / solicitation',
  special_notice: 'Special notice',
  amendment: 'Amendment',
  award_notice: 'Award notice',
  other: 'Other',
};

export const SOURCE_LABELS: Record<OpportunitySource, string> = {
  grants_gov: 'Grants.gov',
  sam_gov: 'SAM.gov',
};

/**
 * Labels for every rail an inbox row can be on.
 *
 * The forecast label is TWO facts, not one: "Agency forecast" says where it came
 * from, "early signal" says what it is. A reader who sees only the first can
 * reasonably read a forecast as something to bid on; the plan's own acceptance
 * line ("No forecast card says open, solicitation, eligible, or deadline unless
 * source states it") is why the second half is part of the label rather than a
 * tooltip.
 */
export const INBOX_SOURCE_LABELS: Record<InboxSource, string> = {
  grants_gov: 'Grants.gov',
  sam_gov: 'SAM.gov',
  agency_forecast: 'Agency forecast · early signal',
};

/** The short form, for a tag where the full two-part label will not fit. */
export const INBOX_SOURCE_SHORT_LABELS: Record<InboxSource, string> = {
  grants_gov: 'Grants.gov',
  sam_gov: 'SAM.gov',
  agency_forecast: 'Agency forecast',
};

export const ELIGIBILITY_LABELS: Record<EligibilityState, string> = {
  eligible: 'Eligible',
  ineligible: 'Not eligible',
  needs_review: 'Needs review',
  unknown: 'Unknown',
};

/**
 * NEVER "eligible"/"ineligible"/a percentage — acquisition position answers
 * a different question than `ELIGIBILITY_LABELS` does, and a shared word
 * between the two is exactly the blend AcquisitionPositionPanel.tsx's own
 * doc exists to prevent.
 */
export const ACQUISITION_POSITION_LABELS: Record<AcquisitionPositionState, string> = {
  direct_prime_access: 'Direct prime access',
  related_entity_access: 'Related-entity access',
  known_teaming_route: 'Known teaming route',
  vehicle_not_identified: 'Vehicle not identified',
  no_direct_access_evidence: 'No current access evidence',
  unknown: 'Unknown',
};

export const WORKFLOW_LABELS: Record<OpportunityWorkflowStatus, string> = {
  suggested: 'Suggested',
  saved: 'Saved',
  pursuing: 'Pursuing',
  dismissed: 'Dismissed',
  won: 'Won',
  lost: 'Lost',
  expired: 'Expired',
};

/**
 * Money for display. THE central honesty rule of this surface, in one function.
 *
 * `null` is "we hold no figure" and renders as the caller's placeholder — never
 * `$0`, which states a fact the source never stated. `0` is a real zero and IS
 * rendered as `$0`, because a source that says zero is different from a source
 * that says nothing.
 */
export function formatMoney(value: Money, placeholder = '—'): string {
  if (value == null) return placeholder;
  if (!Number.isFinite(value)) return placeholder;
  if (Math.abs(value) >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${Math.round(value)}`;
}

/** Deadline text. A note ("Continuous") replaces a missing date rather than hiding it. */
export function formatDeadline(
  responseDeadline: string | null,
  note: string | null,
): { text: string; daysRemaining: number | null } {
  if (!responseDeadline) {
    return { text: note?.trim() ? note.trim() : 'No deadline stated', daysRemaining: null };
  }
  const t = Date.parse(responseDeadline);
  if (!Number.isFinite(t)) return { text: 'No deadline stated', daysRemaining: null };
  const days = Math.ceil((t - Date.now()) / 86_400_000);
  const text = new Date(t).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return { text, daysRemaining: days };
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * "Grants.gov: current to 28 Jul" / an explicit never-synced statement / — and,
 * when the rail is failing, BOTH facts at once.
 *
 * A rail that succeeded a week ago and has failed every night since used to read
 * as plain "current to 22 Jul", because the API only ever reported successful
 * runs. That is the most dangerous rendering available: it looks healthy. The
 * failure is now stated in the same line as the last good data.
 */
export function formatFreshness(f: OpportunitySourceFreshness): string {
  if (f.neverSynced) {
    return f.lastRunStatus === 'error'
      ? `${f.label}: never synced — last attempt failed${f.lastAttemptAt ? ` ${shortDate(f.lastAttemptAt)}` : ''}`
      : `${f.label}: never synced`;
  }
  if (!f.lastSyncedAt) return `${f.label}: freshness unknown`;
  const base = `${f.label}: current to ${shortDate(f.lastSyncedAt)}`;
  if (f.lastRunStatus === 'error') {
    return `${base} — LAST RUN FAILED${f.lastAttemptAt ? ` ${shortDate(f.lastAttemptAt)}` : ''}`;
  }
  if (f.lastRunDegraded) {
    const errors = f.lastRunErrorCount ?? 0;
    return `${base} (last run had ${errors > 0 ? `${errors.toLocaleString()} ` : ''}errors)`;
  }
  return base;
}

/**
 * The Grants.gov detail-enrichment line, or null when there is nothing to say.
 *
 * Separate from {@link formatFreshness} because the catalog sync and the detail
 * enricher fail independently, and a green catalog with a dead enricher is a page
 * of grants with no terms on them.
 */
export function formatEnrichment(f: OpportunitySourceFreshness): string | null {
  const e = f.enrichment;
  if (!e) return null;
  if (e.degraded) {
    return `Grant details: enrichment FAILING${e.lastSuccessAt ? ` since ${shortDate(e.lastSuccessAt)}` : ''} — award ceilings and eligibility text may be missing`;
  }
  if (e.activeAwaitingEnrichment != null && e.activeAwaitingEnrichment > 0) {
    return `Grant details: ${e.activeAwaitingEnrichment.toLocaleString()} active grant${e.activeAwaitingEnrichment === 1 ? '' : 's'} awaiting detail fetch`;
  }
  if (e.lastSuccessAt) return `Grant details: enriched to ${shortDate(e.lastSuccessAt)}`;
  return 'Grant details: never enriched';
}

/**
 * The money line for one opportunity, source-appropriate.
 *
 * Grants and contracts get DIFFERENT labels because they are different kinds of
 * number: a grant ceiling is the most any single award will be, and a SAM notice
 * usually states no value at all. There is deliberately no code path that adds
 * them together.
 */
export function moneyLine(o: FundingOpportunity): { label: string; value: string } {
  if (o.source === 'grants_gov' && o.grantFunding) {
    const g = o.grantFunding;
    if (g.awardCeiling != null) {
      return { label: 'Award ceiling', value: formatMoney(g.awardCeiling) };
    }
    if (g.estimatedProgramFunding != null) {
      return { label: 'Program funding', value: formatMoney(g.estimatedProgramFunding) };
    }
    return { label: 'Award ceiling', value: 'Not stated' };
  }
  if (o.source === 'sam_gov') {
    // Always "Not stated" today, and that is a fact about SAM.gov rather than a
    // gap in this UI — see ContractValue in the API types.
    return { label: 'Contract value', value: formatMoney(o.contractValue?.estimatedValue ?? null, 'Not stated') };
  }
  return { label: 'Value', value: 'Not stated' };
}
