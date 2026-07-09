export interface ProgramElementYearPoint {
  id: string;
  fy: number;
  request: string | number | null;
  hascMark?: string | number | null;
  sascMark?: string | number | null;
  hacDMark?: string | number | null;
  sacDMark?: string | number | null;
  conference: string | number | null;
  enacted: string | number | null;
  notes?: string | null;
  raw?: unknown;
}

export interface ProgramElementDetail {
  peCode: string;
  title: string;
  /** PE mission / program description (parsed from the R-docs at ingestion). */
  description: string | null;
  service: string | null;
  budgetActivity: string | null;
  appropriationType: string | null;
  status: string | null;
  firstSeenFy: number | null;
  lastSyncedAt: string;
  currentUserIsWatching: boolean;
  years: ProgramElementYearPoint[];
  /** Step 1.2: counts so the profile can badge + lazy-load the project/proof-pack panels. */
  projectCount?: number;
  sourceCount?: number;
  /**
   * The FY with the most PEs carrying a live PB request catalog-wide (the "current
   * budget cycle" nearly every active PE is in). Lets the hero flag a PE whose own
   * latest year of record predates it — e.g. a program that finished RDT&E and
   * dropped out of the current justification books — as historical rather than
   * silently sparse.
   */
  currentCycleFy?: number | null;
}

/** R-2A project / sub-element of a PE (Step 1.2). */
export interface ProgramElementProject {
  id: string;
  projectCode: string;
  title: string;
  mission: string | null;
  budgetActivity: string | null;
  fy: number | null;
  sourceUrl: string | null;
  pageNumber: number | null;
  confidence: number | null;
}

/** Secondary Distribution per-recipient procurement line (P-40). */
export interface ProcurementLineFyRow {
  fy: number;
  quantity: number | null;
  dollars: number | null;
  unitCost: number | null;
}
export interface ProcurementLineRecipient {
  recipient: string;
  fyRows: ProcurementLineFyRow[];
}
export interface ProcurementLinesResponse {
  peCode: string;
  years: number[];
  recipients: ProcurementLineRecipient[];
  sourceUrl: string | null;
  totalRows: number;
}

/** One page-level citation in the proof pack (Step 1.2). */
export interface ProgramElementSourceItem {
  id: string;
  docType: string;
  exhibitType: string | null;
  fy: number | null;
  sourceUrl: string;
  pageNumber: number | null;
  pageEnd: number | null;
  snippet: string | null;
  publisher: string | null;
  confidence: number | null;
  sourceDocument: { title: string; budgetCycle: string; sha256: string | null } | null;
}

/** A typed, materiality-scored budget delta (Step 1.4). */
export interface ProgramElementDelta {
  id: string;
  peCode: string;
  assertedFy: number;
  deltaType: string;
  fromRef: string | null;
  toRef: string | null;
  amountFrom: string | number | null;
  amountTo: string | number | null;
  deltaAbs: string | number | null;
  deltaPct: number | null;
  explanation: string | null;
  materialityScore: number;
  computedAt: string;
}

export interface ProgramElementDeltaListResponse {
  data: ProgramElementDelta[];
  total: number;
  page: number;
  limit: number;
}

export interface ProgramElementListItem {
  peCode: string;
  title: string;
  service: string | null;
  budgetActivity: string | null;
  appropriationType: string | null;
  status: string | null;
  lastSyncedAt: string;
  // True when the PE has at least one FY history row, PE-linked federal award, or
  // a bill referencing it. Lets the finder flag/hide PEs with empty detail panels.
  hasData?: boolean;
  // ── Redesign enrichment (all optional; present on the finder list endpoint) ──
  /** Whether the current user is watching this PE. */
  watched?: boolean;
  /** Count of bills referencing this PE (from the detail materialized view). */
  billCount?: number | null;
  /** Most recent FY (and its value, $M) that carries a real President's-Budget request. */
  latestRequest?: number | null;
  latestRequestFy?: number | null;
  /** Most recent FY (and its value, $M) that carries a real enacted appropriation. */
  latestEnacted?: number | null;
  latestEnactedFy?: number | null;
  /**
   * Canonical "current" funding, $M — the furthest-along stage at the PE's
   * latest year of record (enacted→conference→SAC-D→HAC-D→SASC→HASC→request),
   * matching the detail page. `latestCurrentStage` is the FundingStage it came
   * from so the headline can say which stage the number represents.
   */
  latestCurrent?: number | null;
  latestCurrentFy?: number | null;
  latestCurrentStage?: string | null;
  /** Enacted-vs-request % for the latest-enacted FY (Congress over/under the PB). */
  deltaPct?: number | null;
  /** Last 6 fiscal years of enacted-or-conference-or-request ($M), ascending, for the row sparkline. */
  spark?: number[] | null;
  /** The most-material live budget delta on this PE — drives the row signal pill. */
  signalType?: string | null;
  signalScore?: number | null;
  signalDeltaPct?: number | null;
  // ── BL-1 money-graph enrichment (from program_element_intelligence_cache;
  //    null until the first derive-intelligence-cache run) ──
  /** RDTE_PE | PROCUREMENT_BLIN | OM_BLI (MILCON/TRANSFER/CLASSIFIED reserved). */
  lineType?: string | null;
  /** Transition-maturity rung 0-5 (F19); null when not applicable. */
  maturity?: number | null;
  /** Appropriability (F27): high | med | low + 0-100 composite. */
  appropTier?: string | null;
  appropScore?: number | null;
  /** Latest normalized budget action on the line (add|cut|new_start|termination). */
  actionSignalType?: string | null;
  actionSignalTone?: string | null;
  valleyOfDeath?: boolean | null;
}

// ── BL-1: capabilities (F4 "I sell X — where's the money?") ──────────────────
export interface CapabilitySummary {
  slug: string;
  name: string;
  aliases: string[];
  taxonomyPath: string;
  lineCount: number;
  /** Sum of latest PB requests across matched lines, $M. */
  requestTotal: number;
  /** Same, split by lineType (RDTE_PE / PROCUREMENT_BLIN / OM_BLI). */
  requestByLineType: Record<string, number>;
}

export interface CapabilityRecommendation {
  peCode: string;
  title: string;
  service: string | null;
  lineType: string | null;
  /** Entry wedge (F25) implied by the line type. */
  wedge: string;
  maturity: number | null;
  appropTier: string | null;
  appropScore: number | null;
  signalType: string | null;
  signalTone: string | null;
  valleyOfDeath: boolean;
  matchConfidence: string;
  /** Auditable evidence for the match ('title:"electronic warfare"'). */
  matchedOn: string;
  latestRequest: number | null;
  latestRequestFy: number | null;
  /** Canonical current funding ($M) + the stage it came from — matches the PE detail page. */
  latestCurrent: number | null;
  latestCurrentFy: number | null;
  latestCurrentStage: string | null;
}

export interface CapabilityRecommendationsResponse {
  capability: { slug: string; name: string; aliases: string[]; taxonomyPath: string } | null;
  data: CapabilityRecommendation[];
}

/** Free-text semantic search over PE mission embeddings (AI suggestions, not curated). */
export interface CapabilitySearchResponse {
  query: string;
  data: CapabilityRecommendation[];
}

// ── BL-2: per-line money-graph reads ─────────────────────────────────────────
/** One normalized committee/appropriations event (§1.2). */
export interface BudgetActionItem {
  id: string;
  fy: number;
  /** PB | HASC | SASC | HAC_D | SAC_D | CONF | ENACTED. */
  stage: string;
  /** add | cut | new_start | termination. */
  action: string;
  /** Signed $M vs `baseline`; null for non-monetary events. */
  amount: number | null;
  baseline: string;
  note: string | null;
  evidence: unknown;
}

/** One typed relationship edge touching this line (§1.3). */
export interface RelationshipItem {
  id: string;
  direction: 'in' | 'out';
  relType: string;
  confidence: string;
  /** accepted | candidate — candidates render dashed + labeled. */
  status: string;
  evidence: string;
  line: {
    peCode: string;
    title: string;
    service: string | null;
    lineType: string | null;
    maturity: number | null;
    appropTier: string | null;
    appropScore: number | null;
  };
}

/** One incumbent-map row (F20) — tier computed server-side. */
export interface IncumbentItem {
  company: string;
  tier: 'incumbent' | 'performer' | 'candidate';
  confidence: 'high' | 'med' | 'low';
  awardsTotal: number | null;
  awardCount: number;
  office: string | null;
  role: string | null;
  evidence: string;
  sourceUrl: string | null;
}

/** Maturity ladder (F19) as cached by derive-intelligence-cache. */
export interface MaturityLadderData {
  current: number;
  rungs: Array<{ n: number; label: string; reached: boolean; evidence: string }>;
}

/** Appropriability verdict (F27) as cached. */
export interface AppropriabilityData {
  score: number | null;
  tier: 'high' | 'med' | 'low' | null;
  factors: Array<{ key: string; label: string; value: number; evidence: string }>;
  unscored: Array<{ key: string; label: string; reason: string }>;
  reason: string;
}

// ── BL-3: Movement / Money graph / Watchlist signals ─────────────────────────
export interface MovementFeedItem {
  id: string;
  peCode: string;
  title: string;
  service: string | null;
  lineType: string | null;
  fy: number;
  stage: string;
  action: string;
  amount: number | null;
  note: string | null;
}

export interface MovementResponse {
  openFy: number;
  kpis: { actions: number; addsTotal: number; cutsTotal: number; openInConference: number };
  feed: MovementFeedItem[];
  heatmap: { fy: number; cols: string[]; rows: Array<{ lineType: string; vals: number[] }> };
  conference: Array<{
    peCode: string;
    title: string;
    service: string | null;
    fy: number;
    request: number | null;
    house: number | null;
    senate: number | null;
    /** appropriations (HAC-D vs SAC-D) or authorization (HASC vs SASC). */
    basis: string;
    gap: number | null;
    lean: 'house' | 'senate' | null;
  }>;
  anomalies: Array<{ peCode: string; title: string; kind: string; tone: string; note: string }>;
}

export interface MoneyGraphResponse {
  nodes: Array<{
    peCode: string;
    title: string;
    service: string | null;
    lineType: string | null;
    valleyOfDeath: boolean;
  }>;
  edges: Array<{
    from: string;
    to: string;
    relType: string;
    confidence: string;
    status: string;
    evidence: string;
  }>;
}

export interface WatchSignalItem {
  id: string;
  peCode: string;
  title: string;
  fy: number;
  stage: string;
  action: string;
  amount: number | null;
  note: string | null;
}

/** Portfolio-level aggregates for the finder summary strip. */
export interface ProgramElementSummary {
  tracked: number;
  withData: number;
  watched: number;
  latestRequestFy: number | null;
  totalRequest: number | null;
  latestEnactedFy: number | null;
  totalEnacted: number | null;
  avgDeltaPct: number | null;
  openMarkups: number;
  trend: { fy: number; total: number }[];
  byService: { service: string | null; count: number }[];
}

export interface ProgramElementMarkupMonitorItem {
  peCode: string;
  title: string;
  service: string | null;
  request: number | null;
  hascMark: number | null;
  sascMark: number | null;
  hacDMark: number | null;
  sacDMark: number | null;
  divergencePct: number;
}

export interface ProgramElementListResponse {
  data: ProgramElementListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface ProgramElementMarkupMonitorResponse {
  data: ProgramElementMarkupMonitorItem[];
  total: number;
  page: number;
  limit: number;
}

export interface ProgramElementBill {
  id: string;
  congress: number;
  billType: string;
  billNumber: string;
  title: string;
  policyArea: string | null;
  latestActionText: string | null;
  latestActionDate: string | null;
  url: string | null;
  sponsor?: string | null;
  committee?: string | null;
  passageProbability?: number | null;
  // How many distinct PEs this bill references. ~700 = an annual NDAA / blanket
  // authorizer that touches nearly every PE; a small count = a PE-specific bill.
  peCodeCount?: number;
  /** LEG-B: evidence-typed bill↔PE link (why this bill is linked to THIS pe).
   * Null for bills linked only via the legacy peCodes array. */
  link?: {
    type: string; // explicit_pe_code | budget_table_row | committee_mark_row | report_language | title_match | manual
    confidence: number;
    evidence: string;
    status: string; // accepted | candidate
  } | null;
  /** LEG-A: per-bill stage-classified actions that feed the bill-timeline swimlane. */
  actions?: ProgramElementBillAction[];
}

/** One legislative action rendered on the bill-timeline swimlane (BillsTouchingPePanel). */
export interface ProgramElementBillAction {
  id: string;
  date: string;
  text: string;
  type: string | null;
  chamber: string | null;
}

/** LEG-A: one stage-classified legislative action from a bill touching the PE. */
export interface BillActionEvent {
  billId: string;
  congress: number;
  billType: string;
  billNumber: string;
  billTitle: string;
  peCodeCount: number;
  date: string;
  /** Raw Congress.gov action text — rendered verbatim. */
  text: string;
  type: string | null;
  chamber: string | null;
  stage: string;
  stageLabel: string;
  stageRank: number;
}

export interface ProgramElementContractor {
  contractorName: string;
  amount: number;
  awards: number;
  contractType?: string | null;
  contractorIsCrmClient?: boolean;
  isNewEntrant?: boolean;
  // How this contractor was linked to the PE: 'direct' = the award carried this
  // PE code; 'program' = linked via the contract's DoD acquisition program code.
  source?: 'direct' | 'program' | null;
  // Human-readable provenance the panel shows so the link is never implied to be
  // more precise than it is.
  attribution?: string | null;
}

// A prime named directly in the Service's own R-3 "Product Development" budget
// exhibit. This is the primary, precise answer — zero inference, the government
// itself names the performing activity per program element.
export interface ProgramElementNamedPrime {
  contractorName: string;
  location: string | null;
  contractMethod: string | null;
  totalCostM: number | null;
  fy: number | null;
  sourceUrl: string | null;
  pageNumber: number | null;
  publisher: string | null;
  // Human-readable provenance, e.g. "Named prime per Navy FY2027 R-3 exhibit (p. 89)".
  attribution: string;
}

export interface ProgramElementContractorsResponse {
  // Named primes straight from the budget exhibit (Layer 1) — the primary,
  // precise answer. May be empty if no R-3 performer table covers this PE.
  namedPrimes?: ProgramElementNamedPrime[];
  data: ProgramElementContractor[];
  todo: string | null;
}

// A semantically-similar PE surfaced by mission-embedding similarity. This is a
// SUGGESTION, not a documented relationship — the UI must label it as such and
// show the similarity so the user can judge it.
export interface ProgramElementRelated {
  peCode: string;
  title: string;
  service: string | null;
  // 0..1 cosine similarity between the two PEs' mission embeddings.
  similarity: number;
}

export interface ProgramElementRelatedResponse {
  related: ProgramElementRelated[];
  todo: string | null;
}

// One PersonRole row flattened for the program-team panel (Step 2.2, plan §8:
// people hang off OFFICES and ROLES, never directly off a PE). Mirrors the API's
// PersonRoleSummaryDto exactly. `whyShown` is the human chain (role → office →
// program → PE); it NEVER says "owns PE".
export interface PersonRoleSummary {
  id: string;
  roleTitle: string;
  roleType: string;
  officeName: string | null;
  programName: string | null;
  /** The stored person_role.contact_use value. */
  contactUse: string;
  /** CONTACT_USE_LABELS[contactUse] (falls back to the raw value if unknown). */
  contactUseLabel: string;
  reviewStatus: string;
  observedAt: string;
  staleAt: string | null;
  whyShown: string;
}

export interface ProgramTeamPerson {
  id: string;
  fullName: string;
  service: string | null;
  organization: string | null;
  title: string | null;
  role: string | null;
  pePrimary: string | null;
  peSecondary: string[];
  emailDomain: string | null;
  publicProfileUrl: string | null;
  headshotUrl: string | null;
  confidence: number;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sourceCount: number;
  // Additive (Step 2.2, plan §8). Empty array when the person has no PersonRole
  // rows yet — render the legacy display + a "role mapping pending" note.
  roles?: PersonRoleSummary[];
}

export type ProgramElementSourceField =
  | 'request'
  | 'hascMark'
  | 'sascMark'
  | 'hacDMark'
  | 'sacDMark'
  | 'conference'
  | 'enacted';

export type ProgramElementYearSourceAttribution = Partial<
  Record<ProgramElementSourceField, string>
>;

export interface ProgramElementHistoryRow {
  id: string;
  fy: number;
  request: number | null;
  hascMark: number | null;
  sascMark: number | null;
  hacDMark: number | null;
  sacDMark: number | null;
  conference: number | null;
  enacted: number | null;
  projectedEnacted: boolean;
  sourceAttribution: ProgramElementYearSourceAttribution;
}

export interface FyHistoryChartProps {
  rows: ProgramElementHistoryRow[];
  loading?: boolean;
  onFyClick?: (fy: number) => void;
}

// ── Person -> PE link candidate review queue (Phase 1b) ───────────────────────
export interface PersonCandidate {
  id: string;
  personId: string;
  peCode: string;
  score: number;
  matchBasis: string;
  status: string;
  person: {
    id: string;
    fullName: string;
    organization: string | null;
    title: string | null;
    role: string | null;
  } | null;
  programElement: {
    peCode: string;
    title: string | null;
    service: string | null;
  } | null;
}

export interface PersonCandidateListResponse {
  data: PersonCandidate[];
  total: number;
  page: number;
  limit: number;
}

// ── DoW Directory (AcquisitionPersonnel list/detail) ──────────────────────────
// Backed by GET /api/acquisition-personnel (+ /:id). Reuses ProgramTeamPerson as
// the list-item shape (identical fields).
export type AcquisitionPersonnelListItem = ProgramTeamPerson;

export interface AcquisitionPersonnelListResponse {
  data: AcquisitionPersonnelListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface AcquisitionPersonnelSourceMention {
  id: string;
  source: string;
  sourceUrl: string | null;
  snippet: string | null;
  observedAt: string;
  confidence: number;
  metadata: unknown;
}

export interface AcquisitionPersonnelDetail {
  id: string;
  fullName: string;
  nameKey: string;
  service: string | null;
  organization: string | null;
  title: string | null;
  role: string | null;
  programOfRecord: string | null;
  pePrimary: string | null;
  peSecondary: string[];
  emailDomain: string | null;
  publicProfileUrl: string | null;
  confidence: number;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  metadata: unknown;
  sources: AcquisitionPersonnelSourceMention[];
}

export interface AcquisitionPersonnelListParams {
  service?: string;
  organization?: string;
  role?: string;
  pe_code?: string;
  pe_aligned?: 'aligned' | 'unaligned';
  sort?: 'pe_first' | 'confidence';
  q?: string;
  page?: number;
  limit?: number;
}

// ── Congressional report provisions (Step 2.4) ───────────────────────────────
// One extracted report-language provision linking a committee report to this PE.
// Backed by GET /api/program-elements/:peCode/provisions. `committee` is one of
// hasc|sasc|hac_d|sac_d|conference; `actionType` is the directive class (or null
// when the language is descriptive); `reviewStatus` is accepted|candidate.
export interface ProvisionItem {
  id: string;
  committee: string;
  fy: number;
  heading: string;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  actionType: string | null;
  sourceUrl: string | null;
  matchBasis: string;
  reviewStatus: string;
  confidence: number;
}

// ── SAM.gov procurement opportunities (Step 3.1) ─────────────────────────────
// One ACTIVE SAM.gov procurement notice linked to this PE. Backed by
// GET /api/program-elements/:peCode/opportunities. `reviewStatus` is
// accepted|candidate (quarantined never surfaced). `pocName`/`pocEmail` are the
// OFFICIAL contracting POC — surfaced for provenance, NEVER an outreach target.
// Dates are ISO strings over the wire (Date is JSON-serialized by the API).
export interface OpportunityItem {
  id: string;
  noticeId: string;
  title: string;
  noticeType: string;
  agency: string | null;
  office: string | null;
  pscCode: string | null;
  naicsCode: string | null;
  postedDate: string | null;
  responseDeadline: string | null;
  sourceUrl: string | null;
  pocName: string | null;
  pocEmail: string | null;
  matchBasis: string;
  reviewStatus: string;
  confidence: number;
}

// ── CRM contact picker (link an acquisition-personnel record to a contact) ────
export interface EngagementContactListItem {
  id: string;
  fullName: string | null;
  email: string | null;
  organization: string | null;
  title: string | null;
  clientId: string | null;
}
