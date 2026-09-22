/**
 * Bill 360 dossier response contract (Release R1 — plan §0.3 / §3.1).
 *
 * The dossier is a READ MODEL composed by {@link BillDossierService} from:
 *  - GLOBAL bill facts (apps/api-owned `congress_bill` and children via
 *    SourceDataRepository, or `state_bill` via StateSourceDataRepository), and
 *  - tenant/client tracking context (`intel_tracked_bill`, `intel_alert`) —
 *    populated only on the client route.
 *
 * Field shapes mirror the Bill 360 prototype view-model (`CX.bills[id]`) so the
 * R2 UI renders the dossier with no adapter, and every fact/analysis string
 * carries an `origin` (official | derived | analyst) so the UI can badge
 * provenance without inference.
 *
 * R1 populates `context.contextType = 'client'` only and returns `funding` as an
 * explicit "not yet available" empty state (defense_funding_intel is R3, §3.6);
 * the envelope is forward-compatible so R3 fills `funding.*` and R6 adds the
 * `policy_portfolio` context without changing this shape.
 */
import type {
  BudgetFundingStage,
  BudgetVehicleClass,
  EvidenceOrigin,
  ExpectedConfidenceLevel,
  ExpectedMilestoneType,
  FundingScope,
  FundingVerificationStatus,
} from '@capiro/shared';

/** UI severity token (drives coloring); mirrors the prototype `sev` enum. */
export type DossierSeverity = 'critical' | 'notable' | 'info' | 'success' | 'accent' | 'neutral';

/** A provenance-tagged text block (a fact or a piece of analysis). */
export interface EvidenceValue {
  origin: EvidenceOrigin;
  text: string;
  asOf: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  confidence?: number | null;
  /** Analyst outlooks can expire; official facts never do. ISO date or null. */
  expires?: string | null;
}

/** Which object the dossier is scoped to (null = the global/public view). */
export interface DossierContext {
  contextType: 'client' | 'policy_portfolio';
  externalRef: string;
  name: string;
  scopeId?: string;
}

export interface BillIdentity {
  id: string;
  /** Human designation, e.g. "H.R. 8800" / "TX HB 1234". */
  num: string;
  title: string;
  chamber: string | null;
  /** Bill type token, e.g. "hr" | "s" | "hres". */
  type: string | null;
  congress: number | null;
  sponsor: string | null;
  sponsorLegislatorId?: string | null;
  introduced: string | null;
  /** Canonical (derived) status — NEVER overwritten by an analyst outlook. */
  statusLabel: string;
  statusSev: DossierSeverity;
  statusAt: string | null;
  stage: string | null;
  jurisdiction: string | null;
  isState: boolean;
  url: string | null;
}

export interface LatestAction {
  text: string | null;
  date: string | null;
}

/**
 * Stable identity for each cell of the Bill 360 KPI strip (LW-QA-021).
 *
 * The strip used to be an unkeyed positional array, so every consumer had to
 * key by array index or by a display label string — a reorder or an insertion
 * silently painted a value under the wrong label. Consumers now look cells up
 * by `id` and NEVER by position.
 */
export type BillKpiId =
  | 'current_status'
  | 'latest_vote'
  | 'funding_position'
  | 'delta_from_request'
  | 'last_official_action'
  | 'next_milestone';

/**
 * How a KPI value must be presented. `date` is the load-bearing one: such a
 * value is a full ISO instant and MUST be narrowed to a calendar date by the
 * renderer (an unformatted one paints `2026-07-22T00:00:00.000Z` in a stat tile).
 * `signed_money` can only ever hold `fmtSignedMillions()` output — never a date.
 */
export type BillKpiValueType = 'status' | 'text' | 'date' | 'money' | 'signed_money';

export interface BillKpi {
  id: BillKpiId;
  label: string;
  /**
   * `null` means NOT AVAILABLE, and `unavailableReason` then says why in the
   * bill's own terms. Never `0`, never a bare em-dash standing in for a fact the
   * dossier does not have (§3.6 — no $0 unless a source states zero).
   */
  value: string | null;
  valueType: BillKpiValueType;
  /** ISO instant the value is as-of, when the underlying fact carries a date. */
  asOf: string | null;
  /** Short caption under the value. Dates belong in `asOf`, not here. */
  sub: string | null;
  /** Non-null exactly when `value` is null. */
  unavailableReason: string | null;
  /**
   * Optional copy for the value line when the underlying value is null. This
   * lets a sourced-but-unverified figure read "Analysis pending" instead of
   * being conflated with a genuinely unavailable figure. The reason remains
   * the grounded supporting text below the value.
   */
  unavailableLabel?: string | null;
}

/** Four fixed, keyed overview cards (each optional). Titles are hard-coded UI-side. */
export interface DossierOverview {
  whatChanged: EvidenceValue | null;
  whyItMatters: EvidenceValue | null;
  officialNextStep: EvidenceValue | null;
  analystOutlook: EvidenceValue | null;
}

export type MilestoneState = 'done' | 'current' | 'failed' | 'upcoming';

export interface LegislativeMilestone {
  date: string | null;
  label: string;
  detail: string | null;
  state: MilestoneState;
  sev?: DossierSeverity;
  /** Explicit result so a failed procedural motion never resembles passage. */
  outcome?: string | null;
  outcomeSev?: DossierSeverity;
  /** Raw official rows represented by this display event (rows are not deleted). */
  sourceIds?: string[];
  sourceCount?: number;
}

export type VoteTarget = 'rule' | 'committee' | 'passage' | 'procedural';

export interface VotePartyBreakdown {
  gopYea: number;
  gopNay: number;
  demYea: number;
  demNay: number;
}

export interface BillVote {
  id: string;
  label: string;
  target: VoteTarget;
  chamber: string | null;
  date: string | null;
  result: string | null;
  resultSev: DossierSeverity;
  tally: string;
  party: VotePartyBreakdown | null;
  note: string | null;
}

export interface GoverningRule {
  id: string;
  label: string;
  desc: string | null;
  result: string | null;
  resultSev: DossierSeverity;
  tally: string;
  date: string | null;
  /** When true, this rule's outcome controls the displayed status. */
  controls: boolean;
  note: string | null;
}

export interface FundingPositionView {
  /** Exact budget-package vehicle this amount belongs to; null means package-level only. */
  vehicleId: string | null;
  fiscalYear: number;
  scope: FundingScope;
  stage: BudgetFundingStage;
  vehicleClass: BudgetVehicleClass;
  vehicleTrack: BudgetVehicleClass | null;
  vehicleStatus: string | null;
  amountTreatment: FundingAmountTreatment;
  amountMillions: number;
  effectiveDate: string | null;
  source: string | null;
  sourceUrl: string | null;
  /** Page in the source document the figure was read from (R4 §4.1). */
  sourcePage: number | null;
  sourceDocumentTitle: string | null;
  sourceDocumentKey: string | null;
  /** SHA-256 content identity of the exact source version, when registered. */
  sourceDocumentVersion: string | null;
  sourceDocumentCurrent: boolean | null;
  verification: FundingVerificationStatus;
  primary: boolean;
  note: string | null;
}

export interface FundingComparison {
  scope: FundingScope;
  label: string;
  amountMillions: number | null;
  deltaMillions: number | null;
  pct: number | null;
  billId?: string | null;
  comparable: boolean;
}

export type ProgramElementMatchBasis = 'explicit' | 'inferred';
export type FundingAmountTreatment =
  | 'request'
  | 'proposed_authorization'
  | 'appropriated_funding'
  | 'interim_funding'
  | 'supplemental'
  | 'reconciliation'
  | 'unknown';
export type FundingAnalysisStatus = 'unavailable' | 'analysis_pending' | 'reviewed' | 'verified';

export interface ProgramElementImpact {
  pe: string;
  name: string | null;
  fiscalYear: number | null;
  vehicleTrack: BudgetVehicleClass | null;
  houseLabel: string;
  senateLabel: string;
  conferenceLabel: string;
  requestMillions: number | null;
  houseMillions: number | null;
  senateMillions: number | null;
  conferenceMillions: number | null;
  enactedMillions: number | null;
  deltaVsRequestMillions: number | null;
  pct: number | null;
  basis: ProgramElementMatchBasis;
  source: string | null;
}

export interface FundingProvision {
  sec: string | null;
  title: string;
  summary: string | null;
  origin: EvidenceOrigin;
  source: string | null;
  actionType: string | null;
  reviewStatus: string;
  billLinkStatus: string;
  reconciliationRequired: boolean;
}

export interface FundingVehicleContext {
  id: string;
  label: string;
  track: BudgetVehicleClass;
  stage: BudgetFundingStage;
  status: string;
  chamber: string | null;
  fiscalYear: number;
  amountTreatment: FundingAmountTreatment;
  sourceDocumentTitle: string | null;
  sourceDocumentKey: string | null;
  /** SHA-256 content identity of the exact bill/table source version. */
  sourceDocumentVersion: string | null;
  sourceDocumentUrl: string | null;
  sourceDocumentCurrent: boolean | null;
}

export interface FundingBlock {
  /** False in R1 (defense_funding_intel disabled) or when a bill is not a funding vehicle. */
  available: boolean;
  /** Grounded unavailable or analysis-pending message (never renders "$0"). */
  status: string | null;
  /** True when source tables/line items exist even if Capiro review is incomplete. */
  tablesAvailable: boolean;
  analysisStatus: FundingAnalysisStatus;
  vehicle: FundingVehicleContext | null;
  overrideReconciliation: 'not_required' | 'verification_required' | 'reconciled';
  positions: FundingPositionView[];
  reqCompare: FundingComparison | null;
  senateCompare: FundingComparison | null;
  /**
   * Every OTHER same-FY, same-scope figure as the primary — the House / Senate /
   * conference like-for-like set (R4 §4.1). Each entry is `comparable: true` by
   * construction; a figure on a different scope or fiscal year never appears here,
   * it stays in `positions` without a comparison.
   */
  comparisons: FundingComparison[];
  guardrail: string | null;
  /** Single collection reused by both the Funding and the Impact tabs. */
  programElementImpacts: ProgramElementImpact[];
  provisions: FundingProvision[];
  parentPackageLabel: string | null;
}

export interface RelatedVehicle {
  billId: string;
  num: string;
  title: string | null;
  role: string;
}

export interface BillHearingMention {
  ts: string | null;
  speaker: string | null;
  quote: string | null;
}

export interface BillHearingView {
  id: string;
  title: string | null;
  committee: string | null;
  date: string | null;
  mentions: BillHearingMention[];
}

export interface ContextAlertView {
  id: string;
  sev: DossierSeverity;
  date: string | null;
  title: string;
}

/**
 * A watchlist topic/tag that matched this bill FOR THIS CLIENT, read from the
 * client's `intel_bill_match` row (§1.2 "matched topics"). Client route only —
 * the global dossier returns `[]` because matching is inherently contextual.
 */
export interface MatchedTopic {
  label: string;
  /** The match row's fit score (0–1), shared by every tag on the row. */
  fit: number | null;
  jurisdiction: string | null;
  matchedAt: string | null;
}

/**
 * A recommended next action for this bill (§1.2 "recommended actions"), taken
 * VERBATIM from the client's alert rows (`intel_alert.recommended_action`).
 * Nothing here is synthesized by the dossier: if the alert engine recorded no
 * recommendation, the list is empty. `origin` is always `derived` (Capiro
 * analysis) so the UI never badges it as an official fact.
 */
export interface RecommendedActionView {
  text: string;
  origin: EvidenceOrigin;
  sev: DossierSeverity;
  date: string | null;
  alertId: string;
}

export interface SourceRef {
  label: string;
  as: string | null;
  origin: EvidenceOrigin;
  fresh: boolean;
  url?: string | null;
}

export interface DossierProvenance {
  lastSyncedAt: string | null;
  sourceCheckedAt?: string | null;
  sourceCheckAttemptedAt?: string | null;
  sourceCheckStatus?: string;
  sourceCheckReason?: string | null;
  documentDate?: string | null;
  sources: SourceRef[];
}

/** Analyst-maintained expected next milestone (origin: analyst). */
export interface ExpectedMilestone {
  milestoneType: ExpectedMilestoneType | null;
  windowStart: string | null;
  windowEnd: string | null;
  confidence: ExpectedConfidenceLevel | null;
  rationale: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** True when `windowEnd` is in the past. */
  stale: boolean;
}

/** Per-client tracking context (client route only). */
export interface BillContext {
  tracked: boolean;
  position: 'support' | 'oppose' | 'monitor' | null;
  priority: 'low' | 'med' | 'high' | null;
  analystNote: string | null;
  stage: string | null;
  trackedAt: string | null;
  expected: ExpectedMilestone | null;
}

export interface BillDossierResponse {
  bill: BillIdentity;
  latest: LatestAction;
  context: DossierContext | null;
  tracking: BillContext | null;
  kpis: BillKpi[];
  overview: DossierOverview;
  milestones: LegislativeMilestone[];
  votes: BillVote[];
  governingRules: GoverningRule[];
  /** Explicit "no roll call recorded on this bill" — never inferred passage/failure. */
  noVote: string | null;
  funding: FundingBlock;
  relatedVehicles: RelatedVehicle[];
  hearings: BillHearingView[];
  alerts: ContextAlertView[];
  /** Client route only; `[]` on the global route (matching is contextual). */
  matchedTopics: MatchedTopic[];
  /** Client route only; `[]` on the global route. Never synthesized. */
  recommendedActions: RecommendedActionView[];
  provenance: DossierProvenance;
}
