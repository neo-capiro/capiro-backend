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
export const INBOX_SOURCES = [
  'grants_gov',
  'sam_gov',
  'agency_forecast',
  'dibbs',
  'sbir_sttr',
] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

export const FORECAST_SOURCE = 'agency_forecast' as const;

export function isForecastRow(row: { source: string }): boolean {
  return row.source === FORECAST_SOURCE;
}

/**
 * The DLA bid-board rail (P41).
 *
 * In {@link INBOX_SOURCES} and deliberately NOT in {@link OpportunitySource},
 * for the reason the block above gives: a bid-board line item has no response
 * deadline, no eligibility determination and no money, so it can never be
 * fetched as a `FundingOpportunity`. It has a quantity, a unit of issue and a
 * closing date instead, and its recommendation comes from a different scorer
 * with a different vocabulary.
 */
export const DIBBS_SOURCE = 'dibbs' as const;

export function isDibbsRow(row: { source: string }): boolean {
  return row.source === DIBBS_SOURCE;
}

/**
 * The SBIR/STTR topic rail (P43), and the LAST planned source.
 *
 * Also not in {@link OpportunitySource}: P43's own acceptance keeps a topic's
 * eligibility at `needs_review` permanently, because nothing in the schema
 * establishes it — so a topic can never be a `FundingOpportunity`, which
 * carries an eligibility determination.
 */
export const SBIR_SOURCE = 'sbir_sttr' as const;

export function isSbirRow(row: { source: string }): boolean {
  return row.source === SBIR_SOURCE;
}

/** The SBIR capability, per tenant. Mirrors P43's `funding_opportunities_sbir`. */
export const FUNDING_OPPORTUNITIES_SBIR_FEATURE = 'funding_opportunities_sbir';

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

/**
 * Mirrors InboxDibbsFacts in apps/api — the field list is COPIED from it, not
 * re-derived, because a mirror that drifts is a type that lies about the wire.
 *
 * Every field is verbatim from `tango_dibbs_solicitation`. Null means the
 * provider stated nothing — never zero, never "no", and never a closed bid.
 *
 * `quantity` is a STRING because the column is NUMERIC(18,4) and a value near
 * the top of that range exceeds 2^53. The provider's exact digits are carried
 * end to end precisely to avoid a float round-trip; turning it into a JS number
 * here would undo that on the last step before the screen.
 */
export interface InboxDibbsFacts {
  /** `'rfq' | 'rfp'` in practice. Typed as the wire types it — see {@link asPursuableDibbsFacts}. */
  documentType: string;
  solicitation: string;
  /** The provider's own display spelling, when it gave one. Never parsed. */
  solicitationFormatted: string | null;
  nsn: string | null;
  partNumber: string | null;
  nomenclature: string | null;
  /** RFQ only, as an exact decimal string. Null on an RFP, which states none. */
  quantity: string | null;
  /** RFQ only. A quantity without its unit is meaningless, so the pair is dropped rather than a unit invented. */
  unitOfIssue: string | null;
  /** RFQ only. */
  setAside: string | null;
  /** RFP only. */
  buyerCode: string | null;
  /**
   * `YYYY-MM-DD`. A calendar day with no time component, so a bid closing on
   * the 30th is the 30th everywhere. Format with {@link formatSourceDate}, never
   * with `new Date()` in local time.
   */
  closesDate: string | null;
  /** The provider's own judgement. `null` = never stated, and never rewritten into "open". */
  isOpen: boolean | null;
  documentUrl: string | null;
  /** RFP only. */
  techDocsUrl: string | null;
  /** When Capiro last observed this item. Freshness, not a source fact. */
  lastSyncedAt: string | null;
}

/** A DIBBS document a client can actually bid. Mirrors DibbsPursuableDocumentType in apps/api. */
export type DibbsPursuableDocumentType = 'rfq' | 'rfp';

/**
 * Narrow the wire's `documentType` to the two a bid-board card can render, or
 * null for anything else.
 *
 * A function rather than an inline check at the call site for the reason
 * {@link asCatalogRef} gives: TypeScript cannot narrow an OBJECT by testing one
 * of its properties, so every call site would otherwise need its own cast — and
 * a cast is exactly what stops the compiler noticing when a third document type
 * arrives. A caller that gets null must fall back to a renderer that claims
 * nothing about the document type, never coerce it into one of these two.
 */
export function asPursuableDibbsFacts(
  facts: InboxDibbsFacts,
): (InboxDibbsFacts & { documentType: DibbsPursuableDocumentType }) | null {
  return facts.documentType === 'rfq' || facts.documentType === 'rfp'
    ? { ...facts, documentType: facts.documentType }
    : null;
}

/**
 * The part-profile gap EVERY dibbs row carries today, and why it is a constant
 * rather than a field on the row.
 *
 * The gap is a scoring output, not a solicitation fact, so it is correctly
 * absent from `InboxDibbsFacts` — that interface is verbatim
 * `tango_dibbs_solicitation` and a scoring result does not belong in it. But the
 * inbox response carries no scoring breakdown either, so there is no wire field
 * to read it from.
 *
 * Passing `null` to the card instead would be the one thing that must not
 * happen: `null` there means "a part-level match was attempted and there is no
 * gap", which would tell a reader that this client's parts were compared and
 * came up short. Nothing in this schema stores a client's reviewed NSNs or part
 * numbers — apps/api's `scoreDibbsRelevance` documents `clientHasRecordedParts`
 * as "`false` today for every client" — so no part-level comparison has ever
 * happened for anyone.
 *
 * So the honest value today is this constant, and it is stated in ONE place
 * with a test pinning it. When a client part store lands, this stops being a
 * structural fact about the system and becomes per-row data: at that point it
 * moves onto the API response and this constant is deleted, not edited.
 */
export const DIBBS_PART_PROFILE_GAP_TODAY = 'no_client_parts_recorded' as const;

/**
 * Mirrors InboxSbirCycleFacts in apps/api — the parent solicitation cycle for
 * an SBIR topic, when Capiro HOLDS it.
 *
 * `program` is the only place the SBIR/STTR distinction lives. A topic does not
 * carry it, so a topic whose cycle is absent cannot be labelled either — and
 * must not be, since STTR is the one requiring a research partner.
 */
export interface InboxSbirCycleFacts {
  solicitationNumber: string;
  cycleName: string | null;
  /** `'SBIR' | 'STTR'` as the provider spells it. Never normalised. */
  program: string | null;
  year: number | null;
  startDate: string | null;
  endDate: string | null;
  solicitationStatus: string | null;
  solDownloadUrl: string | null;
}

/**
 * Mirrors InboxSbirFacts in apps/api — the field list is COPIED from it.
 *
 * There is deliberately NO `phase`: the published SBIR contract carries none on
 * either endpoint, so a field here would be one nothing could ever populate.
 */
export interface InboxSbirFacts {
  topicNumber: string | null;
  title: string | null;
  agency: string | null;
  year: number | null;
  /** The parent cycle as STATED by the source. Null means the source named none. */
  solicitationNumber: string | null;
  releaseDate: string | null;
  openDate: string | null;
  /** `YYYY-MM-DD`. Format with {@link formatSourceDate}, never `new Date()` locally. */
  closeDate: string | null;
  solicitationStatus: string | null;
  topicUrl: string | null;
  officialSolicitationUrl: string | null;
  lastSyncedAt: string | null;
  /**
   * The parent cycle when Capiro HOLDS it.
   *
   * Null means NOT HELD — a fact about Capiro's sync — which is distinct from
   * `solicitationNumber` being null, a fact about the source. The card renders
   * two different sentences for the two, so they must stay distinguishable.
   */
  cycle: InboxSbirCycleFacts | null;
}

/** Mirrors InboxRow in apps/api. One CLIENT-OPPORTUNITY decision context. */
export interface InboxRow {
  id: string;
  client: { id: string; name: string };
  /** Includes `agency_forecast` and `dibbs` — see {@link INBOX_SOURCES}. */
  source: InboxSource;
  sourceRecordId: string;
  title: string;
  agency: string | null;
  /** Populated ONLY on an `agency_forecast` row. Null on every other rail. */
  forecast: InboxForecastFacts | null;
  /** Populated ONLY on a `dibbs` row. Null on every other rail. */
  dibbs: InboxDibbsFacts | null;
  /** Populated ONLY on a `sbir_sttr` row. Null on every other rail. */
  sbir: InboxSbirFacts | null;
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

// ── Government landscape (P33) ───────────────────────────────────────────────

/** The landscape flag. Byte-matches the API guard's own constant. */
export const FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE =
  'funding_opportunities_government_landscape';

/** Mirrors LANDSCAPE_SOURCES in apps/api's government-landscape.types.ts. */
export const LANDSCAPE_SOURCE_LABELS: Record<string, string> = {
  program_element: 'Program Element',
  budget_movement: 'Budget movement',
  client_facility: 'Client facility',
  congressional_district: 'Congressional district',
  legislation: 'Legislation',
  hearing: 'Hearing',
  regulation: 'Regulation',
  committee: 'Committee',
  acquisition_personnel: 'Acquisition personnel',
  reviewed_relationship: 'Reviewed relationship',
  client_priority: 'Client priority',
};

/**
 * One item in the packet.
 *
 * `basis` is the load-bearing field: `source_backed` means a source states the
 * link, `inferred` means two things resemble each other. An inferred item is
 * never presented as verified and never drives a high-confidence action.
 */
export interface LandscapeItemView {
  source: string;
  sourceId: string;
  label: string;
  basis: 'source_backed' | 'inferred';
  /** The exact value that connected the two things. Never a paraphrase. */
  matchedOn: string;
  evidenceRef: string | null;
  asOf: string | null;
}

export interface LandscapeSourceReportView {
  source: string;
  /**
   * `not_wired` means Capiro cannot read this source yet; `empty` means it read
   * it and found nothing. Only the second is a finding.
   */
  state: 'available' | 'empty' | 'not_wired' | 'denied';
  itemCount: number;
  explanation: string;
}

/** Mirrors LandscapePacket in apps/api. */
export interface LandscapePacketView {
  clientId: string;
  source: string;
  sourceRecordId: string;
  items: LandscapeItemView[];
  sources: LandscapeSourceReportView[];
  /** Coverage, never confidence: a fully-covered packet can be empty. */
  coverage: { available: number; wired: number; declared: number };
  fingerprint: string;
  generatedAt: string;
}

export function landscapeApiPath(
  source: string,
  sourceRecordId: string,
  clientId: string,
): string {
  return `/api/intelligence/opportunities/${encodeURIComponent(source)}/${encodeURIComponent(sourceRecordId)}/landscape?clientId=${encodeURIComponent(clientId)}`;
}

// ── Pursuit pipeline (P35) ──────────────────────────────────────

/** The pipeline flag. Byte-matches the API guard's own constant. */
export const FUNDING_OPPORTUNITIES_PIPELINE_FEATURE = 'funding_opportunities_pipeline_v2';

// ── Budget beta context (P44) ───────────────────────────────────────────────

/** The budget flag. Byte-matches the API guard's own constant. */
export const FUNDING_OPPORTUNITIES_BUDGET_FEATURE = 'funding_opportunities_budget_context';

/** The label every surface must use. Byte-matches the API's own constant. */
export const BUDGET_BETA_LABEL = 'Tango Budget Beta';

export interface BudgetAccountView {
  federalAccountSymbol: string;
  fiscalYear: number;
  accountTitle: string;
  agencyName: string | null;
  bureauName: string | null;
  /** Exact decimal STRINGS, never numbers — see the API's own `decimal`. */
  money: {
    requestedBa: string | null;
    enactedBa: string | null;
    apportioned: string | null;
    obligatedTotal: string | null;
    outlayedTotal: string | null;
    unobligatedBalance: string | null;
    contractObligated: string | null;
  };
  attributionStatus: string | null;
  attributionConfidence: string | null;
  clientFlow: {
    recipientUei: string;
    contractObligated: string | null;
    contractOutlayed: string | null;
    contractCount: number | null;
    fundingOfficeName: string | null;
    fundingAgencyName: string | null;
  } | null;
  lastSyncedAt: string | null;
}

export interface BudgetContextView {
  state: 'available' | 'disabled' | 'denied' | 'not_synced' | 'no_client_identity' | 'no_flows';
  explanation: string;
  source: string;
  noticeLinkage: { linked: false; explanation: string };
  grain: string;
  fiscalYears: Array<{ fiscalYear: number; accounts: BudgetAccountView[] }>;
  asOf: string;
}

/**
 * Keyed on the CLIENT, not on an opportunity.
 *
 * No source-backed key links a SAM.gov notice to a Treasury federal account, so
 * a per-opportunity path would promise a join that does not exist.
 */
export function budgetContextApiPath(clientId: string): string {
  return `/api/intelligence/clients/${encodeURIComponent(clientId)}/budget-context`;
}

// ── Procurement risk (P45) ──────────────────────────────────────────────────

/** The risk flag. Byte-matches the API guard's own constant. */
export const FUNDING_OPPORTUNITIES_RISK_FEATURE = 'funding_opportunities_risk_context';

export interface ProtestViewData {
  caseNumber: string | null;
  sourceSystem: string | null;
  /** The provider's own word. Null means OPEN or unstated, never "failed". */
  outcome: string | null;
  outcomeCaveat: string;
  caseType: string | null;
  filedDate: string | null;
  decisionDate: string | null;
  agencyName: string | null;
  protesterName: string | null;
  sourceUrl: string | null;
  matchedOn: 'protester_uei';
}

export interface ExclusionViewData {
  state: 'none_observed' | 'active' | 'expired' | 'unverified';
  explanation: string;
  providerFlag: string | null;
  sourceUrl: string | null;
  observedAt: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface RiskContextView {
  state: 'available' | 'disabled' | 'denied' | 'no_client_identity';
  explanation: string;
  /** `needs_review` or nothing. There is no value that reads as a clearance. */
  recommendationHint: { state: 'needs_review'; reason: string } | null;
  exclusion: ExclusionViewData;
  protests: ProtestViewData[];
  caveats: string[];
  asOf: string;
}

/** Keyed on the client: risk evidence is matched to a UEI, not to a notice. */
export function riskContextApiPath(clientId: string): string {
  return `/api/intelligence/clients/${encodeURIComponent(clientId)}/risk-context`;
}

// ── Meri assessment (P38) ───────────────────────────────────────────────────

/** The Meri flag. Byte-matches the API guard's own constant. */
export const FUNDING_OPPORTUNITIES_MERI_FEATURE = 'funding_opportunities_meri_v2';

/** Mirrors ASSESSMENT_SECTIONS in apps/api. Declaration order IS render order. */
export const ASSESSMENT_SECTIONS = [
  'recommendationRestatement',
  'fit',
  'eligibility',
  'acquisitionPosition',
  'governmentContext',
  'risksAndUnknowns',
  'nextThreeActions',
  'evidenceMap',
] as const;
export type AssessmentSectionKey = (typeof ASSESSMENT_SECTIONS)[number];

export const ASSESSMENT_SECTION_LABELS: Record<AssessmentSectionKey, string> = {
  recommendationRestatement: 'Capiro’s recommendation',
  fit: 'Fit',
  eligibility: 'Eligibility',
  acquisitionPosition: 'Acquisition position',
  governmentContext: 'Government context',
  risksAndUnknowns: 'Risks and unknowns',
  nextThreeActions: 'Next actions',
  evidenceMap: 'Evidence map',
};

export interface AssessedClaimView {
  section: AssessmentSectionKey;
  text: string;
  verdict: 'supported' | 'held' | 'rejected';
  refs: string[];
  unresolvedRefs: string[];
  holdReason: string | null;
}

export interface MeriAssessmentView {
  clientId: string;
  source: string;
  sourceRecordId: string;
  recommendation: string | null;
  modelState: 'applied' | 'unavailable' | 'rejected';
  modelStateExplanation: string;
  sections: Record<AssessmentSectionKey, string[]>;
  claims: AssessedClaimView[];
  nextThreeActions: string[];
  disagreement: { proposed: string; rationale: string } | null;
  proposedDrafts: Array<{ kind: string; title: string; rationale: string }>;
  incomplete: boolean;
  incompleteReasons: string[];
  fingerprint: string;
}

export interface AssessmentProvenanceView {
  promptVersion: string;
  policyVersion: string;
  compilerVersion: string | null;
  contextPacketId: string | null;
  model: string | null;
  artifactVersion: number;
  assessedAt: string;
}

export type AssessmentResultView =
  | { state: 'available'; assessment: MeriAssessmentView; provenance: AssessmentProvenanceView }
  | {
      state: 'disabled' | 'denied' | 'not_found' | 'unsupported_source' | 'invalid_request';
      explanation: string;
    };

/**
 * A POST, not a GET.
 *
 * Producing an assessment calls a model and writes an audit artifact. Behind a
 * GET it would run on every page load and every prefetch — real tokens and a
 * real row, spent because a user hovered a link.
 */
export function assessmentApiPath(source: string, sourceRecordId: string): string {
  return `/api/intelligence/opportunities/${encodeURIComponent(source)}/${encodeURIComponent(sourceRecordId)}/assessment`;
}

/** Mirrors PIPELINE_STAGES in apps/api. Declaration order IS column order. */
export const PIPELINE_STAGES = [
  'reviewing',
  'qualified',
  'pursuing',
  'submitted',
  'won',
  'lost',
  'passed',
] as const;
export type PipelineStageView = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStageView, string> = {
  reviewing: 'Reviewing',
  qualified: 'Qualified',
  pursuing: 'Pursuing',
  submitted: 'Submitted',
  won: 'Won',
  lost: 'Lost',
  passed: 'Passed',
};

/**
 * Stages the server requires a stated reason for.
 *
 * Mirrors HUMAN_ONLY_STAGES, and the UI uses it to ASK before posting rather
 * than letting the server refuse a move the user has already dragged. The server
 * is still the gate — this only decides whether to open the reason prompt.
 */
export const PIPELINE_STAGES_NEEDING_REASON: readonly PipelineStageView[] = [
  'submitted',
  'won',
  'lost',
  'passed',
];

// ── Outcome capture (P36) ───────────────────────────────────────────────────

export const PURSUIT_OUTCOME_KINDS = ['won', 'lost', 'passed'] as const;
export type PursuitOutcomeKindView = (typeof PURSUIT_OUTCOME_KINDS)[number];

/** Mirrors the API's own closed vocabularies. One list per kind, deliberately. */
export const OUTCOME_REASON_CODES: Readonly<Record<PursuitOutcomeKindView, readonly string[]>> =
  Object.freeze({
    won: [
      'best_value',
      'lowest_price',
      'past_performance',
      'teaming_strength',
      'incumbent_advantage',
      'technical_superiority',
      'other',
    ],
    lost: [
      'price',
      'technical_score',
      'past_performance_gap',
      'no_bid_competitive',
      'set_aside_ineligible',
      'protest_related',
      'agency_cancelled',
      'other',
    ],
    passed: [
      'capacity_constraint',
      'strategic_fit',
      'bonding_capacity',
      'teaming_fell_through',
      'deadline_missed',
      'client_declined',
      'other',
    ],
  });

export const OUTCOME_REASON_CODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  best_value: 'Best value',
  lowest_price: 'Lowest price',
  past_performance: 'Past performance',
  teaming_strength: 'Teaming strength',
  incumbent_advantage: 'Incumbent advantage',
  technical_superiority: 'Technical superiority',
  price: 'Price',
  technical_score: 'Technical score',
  past_performance_gap: 'Past performance gap',
  no_bid_competitive: 'Did not bid — too competitive',
  set_aside_ineligible: 'Set-aside ineligible',
  protest_related: 'Protest-related',
  agency_cancelled: 'Agency cancelled',
  capacity_constraint: 'Capacity constraint',
  strategic_fit: 'Strategic fit',
  bonding_capacity: 'Bonding capacity',
  teaming_fell_through: 'Teaming fell through',
  deadline_missed: 'Deadline missed',
  client_declined: 'Client declined',
  other: 'Other',
});

export interface OutcomeRecordView {
  id: string;
  kind: PursuitOutcomeKindView;
  outcomeDate: string;
  reasonCodes: string[];
  note: string | null;
  vehicleOutcome: string | null;
  sourceAwardLink: string | null;
  recordedByUserId: string | null;
  recordedAt: string;
  current: boolean;
}

export type RecordOutcomeResultView =
  | { state: 'recorded'; outcome: OutcomeRecordView; memoryCandidateProposed: boolean }
  | { state: 'disabled' | 'denied' | 'invalid_request'; explanation: string };

export interface OutcomeHistoryResultView {
  state: 'available' | 'disabled' | 'denied';
  explanation: string;
  outcomes: OutcomeRecordView[];
}

export function outcomeApiPath(clientId: string, source: string, sourceRecordId: string): string {
  return `/api/intelligence/clients/${encodeURIComponent(clientId)}/opportunities/${encodeURIComponent(source)}/${encodeURIComponent(sourceRecordId)}/outcome`;
}

export interface PipelineCardView {
  rowId: string;
  source: string;
  sourceRecordId: string | null;
  title: string | null;
  stage: PipelineStageView | null;
  /**
   * `recorded` means a person moved it. `workflow_status` means the stage was
   * derived from the legacy column, `legacy_override` means a recorded stage is
   * out of date, and `unstaged` means neither column places it in the pipeline.
   */
  stageBasis: 'recorded' | 'workflow_status' | 'legacy_override' | 'unstaged';
  stageExplanation: string;
  /** The optimistic-concurrency token. Sent back on every move. */
  version: number;
  /** Computed server-side, so the board cannot offer a move the server refuses. */
  allowedTransitions: PipelineStageView[];
  responseDeadline: string | null;
}

export interface PipelineBoardView {
  clientId: string;
  counts: {
    stages: Array<{ stage: PipelineStageView; count: number }>;
    /** Rows in NO stage, split by why. Never folded into a stage column. */
    unstaged: { suggested: number; expired: number; other: number };
    total: number;
    derivedFromWorkflowStatus: number;
  };
  cards: PipelineCardView[];
  /** True when `cards` is a window. The COUNTS are never a window. */
  cardsTruncated: boolean;
}

export function pipelineBoardApiPath(clientId: string): string {
  return `/api/intelligence/clients/${encodeURIComponent(clientId)}/pipeline`;
}

export function pipelineStageApiPath(clientId: string, rowId: string): string {
  return `/api/intelligence/clients/${encodeURIComponent(clientId)}/pipeline/${encodeURIComponent(rowId)}/stage`;
}

// ── Deterministic action plan (P34) ─────────────────────────────

/** Mirrors ACTION_CATEGORIES in apps/api. Declaration order is display order. */
export const ACTION_CATEGORY_LABELS: Record<string, string> = {
  qualify: 'Qualify',
  shape: 'Shape',
  respond: 'Respond',
  research: 'Research',
  monitor: 'Monitor',
  reference: 'Reference',
};

export interface ProposedActionView {
  id: string;
  category: string;
  title: string;
  rationale: string;
  /** `review` and `pursuit` are P08 intents; `none` creates nothing. */
  intent: 'review' | 'pursuit' | 'none';
  evidence: Array<{ source: string; sourceId: string; matchedOn: string }>;
  /** Only ever from a source-backed landscape item. Null is the common case. */
  suggestedTarget: string | null;
  dueDateBasis: string | null;
  dueDate: string | null;
  unresolvedPrerequisites: string[];
}

export interface ActionPlanView {
  source: string;
  sourceRecordId: string;
  clientId: string;
  stage: string;
  actions: ProposedActionView[];
  fingerprint: string;
  generatedAt: string;
}

export interface ActionPlanResultView {
  state: 'available' | 'denied' | 'unknown_record';
  explanation: string;
  /** Null under `denied` and `unknown_record` — there is no stage to name. */
  plan: ActionPlanView | null;
  acceptance: { wired: boolean; explanation: string };
}

export const PLAN_STAGE_LABELS: Record<string, string> = {
  forecast: 'Forecast',
  sources_sought: 'Sources sought',
  presolicitation: 'Presolicitation',
  solicitation: 'Solicitation',
  amendment: 'Amendment',
  grant: 'Grant',
  closed_or_informational: 'Closed or informational',
};

/**
 * Which workflow statuses mean the workflow ALREADY carries this decision.
 *
 * Mirrors what P08 writes: `review` -> `saved`, `pursuit` -> `pursuing`. The
 * terminal statuses are included because a won or lost opportunity was pursued
 * to get there, so re-proposing the decision would be noise.
 *
 * Deliberately labelled "recorded" rather than "committed" in the UI: a `saved`
 * row may have been saved by hand rather than by accepting this proposal, and
 * claiming the plan caused it would be a claim the client cannot check.
 */
export const RECORDED_STATUSES_BY_INTENT: Record<'review' | 'pursuit', readonly string[]> = {
  review: ['saved', 'pursuing', 'won', 'lost'],
  pursuit: ['pursuing', 'won', 'lost'],
};

export function isActionRecorded(
  intent: ProposedActionView['intent'],
  workflowStatus: string | null | undefined,
): boolean {
  if (intent === 'none' || workflowStatus == null) return false;
  return RECORDED_STATUSES_BY_INTENT[intent].includes(workflowStatus);
}

export function actionPlanApiPath(
  source: string,
  sourceRecordId: string,
  clientId: string,
): string {
  return `/api/intelligence/opportunities/${encodeURIComponent(source)}/${encodeURIComponent(sourceRecordId)}/action-plan?clientId=${encodeURIComponent(clientId)}`;
}

/** P08's idempotent server action. The ONLY path that commits an action. */
export function opportunityActionApiPath(
  clientId: string,
  source: string,
  sourceRecordId: string,
): string {
  return `/api/intelligence/clients/${encodeURIComponent(clientId)}/opportunities/${encodeURIComponent(source)}/${encodeURIComponent(sourceRecordId)}/action`;
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
   * Includes `agency_forecast` (P26) and `dibbs` (P41). The ref names a RECORD
   * to open, and every detail body is reached the same way — which is what keeps
   * the drawer, the full page and the `?detail=` deep link from needing three
   * sets of rules. What each body then renders is completely different; see
   * ForecastOpportunityDetail.
   *
   * A `dibbs` ref is legal and round-trips like any other, but there is no
   * bid-board detail body yet: both the drawer and the full page say so in
   * those words rather than falling through to a renderer for a different
   * record type. Encoding one is therefore safe; assuming it can be RENDERED as
   * an opportunity or a forecast is not.
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
 * Narrow a ref to the catalog, or null for anything that is not a catalog
 * record.
 *
 * A function rather than an inline ternary at each call site because TypeScript
 * cannot narrow an OBJECT by testing one of its properties — `ref.source === 'x'`
 * narrows `ref.source`, not `ref` — so every dispatch site would otherwise need
 * its own cast, and a cast is exactly the thing that stops the compiler noticing
 * when a third record type arrives.
 *
 * THE THIRD RECORD TYPE HAS ARRIVED. Until P41 this returned null only for a
 * forecast, so `asCatalogRef(ref) == null` and "this is a forecast" were the
 * same test, and a caller could use either. They are no longer the same test:
 * a `dibbs` ref also returns null here. A dispatch that still treats null as
 * "forecast" renders a DLA bid-board item as an agency forecast — see
 * FundingOpportunityDrawer, which now switches on `ref.source` for exactly this
 * reason. Test the source, never the absence.
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
 * The INBOX/detail vocabulary: the catalog's two rails, plus agency forecasts
 * and the DLA bid board.
 *
 * Kept as a second predicate rather than a widening of the first, because the two
 * answer different questions: `isOpportunitySource` gates "can this be fetched as
 * a `FundingOpportunity`", which neither a forecast nor a bid-board item ever can.
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
  /*
    Two facts, for the same reason the forecast label is: "DLA bid board" says
    where it came from, "line item" says what one row IS. A reader who sees only
    the first can reasonably read the row as a whole solicitation, and it is not
    — `tango_dibbs_award` rows are line-item grain, which is why P40 prohibits
    an aggregate across them outright. The grain belongs in the label, not in a
    tooltip a reader has to hover to find.
  */
  dibbs: 'DLA bid board · line item',
  /*
    Two facts again. "SBIR/STTR" says where it came from; "topic" says what one
    row IS — the unit a small business responds to, not a solicitation to bid.
    The slash is deliberate: which of the two programs a topic belongs to lives
    on its parent CYCLE, and Capiro does not always hold that, so the rail label
    must not commit to either.
  */
  sbir_sttr: 'SBIR/STTR · topic',
};

/**
 * What both detail frames say about a bid-board ref, in ONE place.
 *
 * The drawer and the full page render the same body for every other record type
 * precisely so they cannot disagree about it (see FundingOpportunityDrawer's
 * file doc). `dibbs` has no shared body to render, so the next best guarantee is
 * one copy of the sentence — otherwise two independently written panels drift,
 * and a reader who saw the drawer and a reader who opened the link end up with
 * different accounts of the same item.
 */
export const DIBBS_NO_DETAIL_MESSAGE = 'Bid-board items do not have a detail page yet';
export const DIBBS_NO_DETAIL_DESCRIPTION =
  'This is a Defense Logistics Agency bid-board line item. Capiro holds it and shows it in the opportunities queue, but the detail view for this rail has not been built. This says nothing about whether the item exists.';

/** The short form, for a tag where the full two-part label will not fit. */
export const INBOX_SOURCE_SHORT_LABELS: Record<InboxSource, string> = {
  grants_gov: 'Grants.gov',
  sam_gov: 'SAM.gov',
  agency_forecast: 'Agency forecast',
  dibbs: 'DLA bid board',
  sbir_sttr: 'SBIR/STTR',
};

/**
 * What both detail frames say about an SBIR topic ref, in ONE place.
 *
 * Same reasoning as {@link DIBBS_NO_DETAIL_MESSAGE}: there is no shared body to
 * render for this rail, so the next best guarantee against the drawer and the
 * full page drifting is one copy of the sentence.
 */
/**
 * The two sentences an SBIR topic card shows that do NOT vary by topic.
 *
 * Both are byte-copies of `sbir-relevance.ts`'s constants in apps/api. They are
 * duplicated rather than fetched because neither is a per-topic scoring output:
 *
 *   - the phase gap is a fact about the SOURCE — there is no phase field on
 *     either SBIR endpoint — so it is true for every topic and will stay true
 *     until the provider publishes one;
 *   - eligibility is a constant `needs_review` by P43's own acceptance, since
 *     nothing in this schema establishes it.
 *
 * When a producer wires the scorer to real rows, these come from the scored
 * result and these constants are DELETED rather than edited — the same posture
 * as {@link DIBBS_PART_PROFILE_GAP_TODAY}.
 */
export const SBIR_PHASE_GAP_EXPLANATION =
  'The source publishes no phase for this topic, so none is shown. This is a gap in the published contract, not a judgement about the topic.';
export const SBIR_ELIGIBILITY_REASON =
  'SBIR eligibility is not evaluated. It turns on US ownership, employee count and — for STTR — a research-institution partner, none of which Capiro holds as a structured fact. A small-business certification is not the same question as the SBIR size standard for this topic.';

export const SBIR_NO_DETAIL_MESSAGE = 'Topics do not have a detail page yet';
export const SBIR_NO_DETAIL_DESCRIPTION =
  'This is an SBIR/STTR topic. Capiro holds it and shows it in the opportunities queue, but the detail view for this rail has not been built. This says nothing about whether the topic exists.';

/**
 * The common recommendation vocabulary as a reader sees it.
 *
 * Exported (P32) rather than declared privately in each renderer. The card and
 * the detail composed these independently before, which is how a card can say
 * "Pursue" while the drawer says "Needs review" about the same row — a parity
 * problem that stops existing when there is one table.
 */
export const RECOMMENDATION_LABELS: Record<MachineRecommendation, string> = {
  pursue: 'Pursue',
  monitor: 'Monitor',
  pass: 'Pass',
  needs_review: 'Needs review',
};

export const RECOMMENDATION_COLORS: Record<MachineRecommendation, string> = {
  pursue: 'green',
  monitor: 'blue',
  pass: 'default',
  needs_review: 'orange',
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
