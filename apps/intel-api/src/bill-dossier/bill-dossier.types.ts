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

export interface BillKpi {
  label: string;
  value: string;
  sub: string | null;
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
}

export type VoteTarget = 'rule' | 'committee' | 'passage';

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
  scope: FundingScope;
  stage: BudgetFundingStage;
  vehicleClass: BudgetVehicleClass;
  amountMillions: number;
  effectiveDate: string | null;
  source: string | null;
  sourceUrl: string | null;
  /** Page in the source document the figure was read from (R4 §4.1). */
  sourcePage: number | null;
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

export interface ProgramElementImpact {
  pe: string;
  name: string | null;
  requestMillions: number | null;
  houseMillions: number | null;
  senateMillions: number | null;
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
}

export interface FundingBlock {
  /** False in R1 (defense_funding_intel disabled) or when a bill is not a funding vehicle. */
  available: boolean;
  /** Grounded empty-state message when `available` is false (never renders "$0"). */
  status: string | null;
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
