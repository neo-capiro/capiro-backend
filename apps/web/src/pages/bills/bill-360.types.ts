/**
 * Bill 360 dossier response contract (web mirror of the intel-api
 * BillDossierResponse produced in R1, apps/intel-api/src/bill-dossier/
 * bill-dossier.types.ts). Kept in sync with the wire shape so the R2 UI renders
 * the dossier with no adapter. Every fact/analysis string carries an `origin`
 * so the UI can badge provenance (Official / Capiro analysis / Analyst outlook).
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

export type DossierSeverity = 'critical' | 'notable' | 'info' | 'success' | 'accent' | 'neutral';

export interface EvidenceValue {
  origin: EvidenceOrigin;
  text: string;
  asOf: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  confidence?: number | null;
  expires?: string | null;
}

export interface DossierContext {
  contextType: 'client' | 'policy_portfolio';
  externalRef: string;
  name: string;
  scopeId?: string;
}

export interface BillIdentity {
  id: string;
  num: string;
  title: string;
  chamber: string | null;
  type: string | null;
  congress: number | null;
  sponsor: string | null;
  sponsorLegislatorId?: string | null;
  introduced: string | null;
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
 * Stable identity for each cell of the Bill 360 KPI strip (LW-QA-021). Mirrors
 * apps/intel-api/src/bill-dossier/bill-dossier.types.ts. Surfaces render the
 * strip by looking cells up by `id` — NEVER by array position or label string.
 */
export type BillKpiId =
  | 'current_status'
  | 'latest_vote'
  | 'funding_position'
  | 'delta_from_request'
  | 'last_official_action'
  | 'next_milestone';

/** A `date` value is a full ISO instant and MUST be narrowed before painting. */
export type BillKpiValueType = 'status' | 'text' | 'date' | 'money' | 'signed_money';

export interface BillKpi {
  id: BillKpiId;
  label: string;
  /** `null` = not available; `unavailableReason` says why. Never 0, never blank. */
  value: string | null;
  valueType: BillKpiValueType;
  asOf: string | null;
  sub: string | null;
  /** Non-null exactly when `value` is null. */
  unavailableReason: string | null;
  /** Value-line copy for a null-but-pending value, e.g. "Analysis pending". */
  unavailableLabel?: string | null;
}

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
  outcome?: string | null;
  outcomeSev?: DossierSeverity;
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
  controls: boolean;
  note: string | null;
}

export interface FundingPositionView {
  vehicleId?: string | null;
  fiscalYear?: number;
  scope: FundingScope;
  stage: BudgetFundingStage;
  vehicleClass: BudgetVehicleClass;
  vehicleTrack?: BudgetVehicleClass | null;
  vehicleStatus?: string | null;
  amountTreatment?: FundingAmountTreatment;
  amountMillions: number;
  effectiveDate: string | null;
  source: string | null;
  sourceUrl: string | null;
  /** Page in the source document the figure was read from (R4 §4.1). */
  sourcePage: number | null;
  sourceDocumentTitle?: string | null;
  sourceDocumentKey?: string | null;
  sourceDocumentVersion?: string | null;
  sourceDocumentCurrent?: boolean | null;
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
  fiscalYear?: number | null;
  vehicleTrack?: BudgetVehicleClass | null;
  houseLabel?: string;
  senateLabel?: string;
  conferenceLabel?: string;
  requestMillions: number | null;
  houseMillions: number | null;
  senateMillions: number | null;
  conferenceMillions?: number | null;
  enactedMillions?: number | null;
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
  actionType?: string | null;
  reviewStatus?: string;
  billLinkStatus?: string;
  reconciliationRequired?: boolean;
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
  sourceDocumentVersion: string | null;
  sourceDocumentUrl: string | null;
  sourceDocumentCurrent: boolean | null;
}

export interface FundingBlock {
  available: boolean;
  status: string | null;
  /** Optional only for compatibility with pre-upgrade cached responses. */
  tablesAvailable?: boolean;
  analysisStatus?: FundingAnalysisStatus;
  vehicle?: FundingVehicleContext | null;
  overrideReconciliation?: 'not_required' | 'verification_required' | 'reconciled';
  positions: FundingPositionView[];
  reqCompare: FundingComparison | null;
  senateCompare: FundingComparison | null;
  /** Every other same-FY, same-scope figure (House / Senate / conference) — R4 §4.1. */
  comparisons: FundingComparison[];
  guardrail: string | null;
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
 * A watchlist tag that matched this bill for the client (R1 §1.2). Client route
 * only; `[]` globally. Carried on the contract but NOT rendered in R2 — neither
 * the prototype nor plan §2.2 places it on a Bill 360 surface.
 */
export interface MatchedTopic {
  label: string;
  fit: number | null;
  jurisdiction: string | null;
  matchedAt: string | null;
}

/**
 * A recommended next action, verbatim from `intel_alert.recommended_action`
 * (R1 §1.2). Never synthesized. Client route only; `[]` globally. Carried on the
 * contract but NOT rendered in R2, same reason as {@link MatchedTopic}.
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

export interface ExpectedMilestone {
  milestoneType: ExpectedMilestoneType | null;
  windowStart: string | null;
  windowEnd: string | null;
  confidence: ExpectedConfidenceLevel | null;
  rationale: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  stale: boolean;
}

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
  noVote: string | null;
  funding: FundingBlock;
  relatedVehicles: RelatedVehicle[];
  hearings: BillHearingView[];
  alerts: ContextAlertView[];
  matchedTopics: MatchedTopic[];
  recommendedActions: RecommendedActionView[];
  provenance: DossierProvenance;
}
