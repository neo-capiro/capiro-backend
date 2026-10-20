import type { BillStage } from './bill-stage.util.js';
import type { MatchReason, MatchReasonKind } from './bill-fit.util.js';
export interface BoardCursor {
  t: string;
  id: string;
  /** Tenant-wide board only: completes the (trackedAt,billId,clientId) key. */
  c?: string;
}

/**
 * P1-18: server-side board filters (the audit's "default to active/recent/
 * changed bills rather than the entire history"). ALL default OFF — today's
 * default is "everything tracked"; silently narrowing it would make bills
 * vanish from an analyst's board (MASTER §4.5).
 */
export interface BoardFilters {
  /** Only bills with a bill/state_bill alert in the last N days. */
  changedWithinDays?: number;
  /**
   * Excludes terminal bills from the active board. Historically a STAGE-based
   * proxy for "terminal" (the enacted lane, because every rank-9 terminal
   * collapsed into it). That proxy was wrong at the source — a failed bill was
   * never enacted — so the exclusion is now TWO-part: the 'enacted' lane still
   * drops genuinely enacted bills, and a canonical-status pass drops
   * terminal-NEGATIVE state bills (vetoed / failed / dead_by_deadline) whose
   * lane is no longer 'enacted'. Federal bills are unchanged (their terminal
   * signal was never carried by the enacted lane). The richer `terminalRisk`
   * card signal is still derived per card; this gate keeps the PAGINATED query
   * correct for the common state-terminal case via one bounded status read,
   * only when activeOnly is set.
   */
  activeOnly?: boolean;
  stages?: BillStage[];
  /** Tenant board (`_all`) only; `getBoard` ignores it (already one client). */
  clientIds?: string[];
}

export interface BoardQueryOpts {
  limit?: number;
  cursor?: string;
  filters?: BoardFilters;
}

export interface BoardPage {
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
  withheld: number;
}

/** Editable Bill 360 client-bill context fields (Release R1, §1.3). All optional. */
export interface UpdateBillContextInput {
  position?: string;
  priority?: string;
  analystNote?: string;
  expectedMilestoneType?: string;
  expectedWindowStart?: string;
  expectedWindowEnd?: string;
  expectedConfidence?: string;
  expectedRationale?: string;
}

export interface RecommendationItem {
  billId: string;
  displayNum: string;
  title: string | null;
  stage: BillStage;
  stageLabel: string;
  passageProbability: number;
  latestActionText: string | null;
  latestActionDate: Date | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  cosponsorsCount: number | null;
  fit: number;
  matchedTags: string[];
  /** Gate K (MP-09): topic ids behind matchedTags's topic entries (never
   *  issue areas) — see BillFit.matchedTopicIds. */
  matchedTopicIds: string[];
  why: string;
  whyKind: MatchReasonKind;
  matchReasons: MatchReason[];
  /** 'US' | <state code> (State Legislation Platform, S5/S7.2). Absent = 'US' — every pre-Phase-0 caller stays unaffected. */
  jurisdiction?: string;
  /** Official state deep link (a state candidate only) — new-match-detector's billUrl() prefers this over any congress.gov synthesis. */
  stateUrl?: string | null;
  /** LegiScan/OpenStates source link (a state candidate only) — the billUrl() fallback below stateUrl. */
  url?: string | null;
}

/** One Add-bill-modal search hit (P1.1 — exact legacy BillSearchResult shape). */
export interface BillSearchResult {
  billId: string;
  displayNum: string;
  title: string | null;
  stage: BillStage;
  probability: number;
  /** P1-17: 'US' or a 2-letter state code, so the Add Bill modal can label
   *  which rail each result came from. */
  jurisdiction?: string;
}

/**
 * The most recent material change on a tracked bill, for the card's chip.
 *
 * P1-08: `severity` and `tone` are new. The web used to re-derive a tone from its
 * OWN copy of a narrow federal change-type list, so a failed governing rule or a
 * state veto rendered as an ordinary 'notable' chip. Both now come from the
 * server: `severity` straight off the `intel_alert` column, `tone` from the
 * detector's own vocabulary (`toneForChange`).
 */
export interface ChangeChip {
  label: string;
  changeType: string | null;
  at: Date;
  /** The detector's own classification: 'info' | 'notable' | 'critical'. */
  severity: string | null;
  /** 'success' | 'critical' | 'notable' | 'info' — distinguishes "Became law"
   *  (success) from "Failed / rejected" (critical), which severity alone cannot. */
  tone: string | null;
}

export interface BoardCard {
  billId: string;
  displayNum: string;
  title: string | null;
  stage: BillStage;
  passageProbability: number;
  latestActionText: string | null;
  latestActionDate: Date | null;
  note: string | null;
  isManual: boolean;
  unread: boolean;
  trackedAt: Date;
  matchedTags: string[];
  /**
   * P0-06: the subset of `matchedTags` whose topic priority is 'high'. The web's
   * High-fit filter reads THIS instead of deriving it from the watchlist query,
   * which is not enabled on the Bills surface at all — so the filter used to match
   * nothing there on a cold load.
   */
  matchedHighPriorityTopics: string[];
  /** The client's stance on the highest-priority matched topic: support|oppose|monitor|null. */
  matchedPosition: string | null;
  changeChip: ChangeChip | null;
  /**
   * P2-09: the bill's REAL status label, not the coarse lane it was bucketed
   * into. The board has four lanes but the detector classifies far more, so a
   * failed governing rule used to render as an ordinary card in the lane its
   * stage happened to map to.
   */
  canonicalStatus: string | null;
  /** P2-09: a failed rule / veto / failed vote / past-deadline state bill. */
  terminalRisk: boolean;
  // Phase 9 (Bill→Hearing interlink): "discussed in N hearings" chip. Presence
  // comes from the trackedBill hearing badge (set by the linker); the count is
  // the number of distinct `combined` alerts for this bill.
  lastHearingSessionId: string | null;
  lastHearingAt: Date | null;
  hearingCount: number;
  /** 'US' | <state code> (State Legislation Platform, S7.2). Absent = 'US'. */
  jurisdiction?: string;
  /**
   * MP-15 / Gate H phase d: the Clerk user id that tracked this bill — already
   * in memory from the unfiltered `findMany` above, just never projected.
   * Null for a row tracked before this column was populated (edge case 4).
   * A Clerk id, NOT a DB user UUID — the web resolves it to a name via
   * GET /api/users/tenant-members, never via useTeamMembers() (wrong id space).
   */
  trackedBy: string | null;
}

export interface BoardColumn {
  id: BillStage;
  label: string;
  cards: BoardCard[];
}
