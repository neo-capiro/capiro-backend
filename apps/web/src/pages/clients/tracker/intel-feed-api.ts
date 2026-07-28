import { buildAlert, type AlertBuildResult } from '@capiro/shared';
/**
 * Typed client + query keys for the unified intel FEED (Phase 6 §9.7).
 * Reads intel-api `GET /intel-api/clients/:clientId/feed` (bill|hearing|combined
 * alerts, keyset-paginated). Gated in the UI by the `tracker_v2` intel feature
 * flag — invisible until a tenant is cut over. Types mirror
 * apps/intel-api/src/feed/feed.service.ts.
 */

export type FeedSourceType =
  | 'bill'
  | 'hearing'
  | 'combined'
  | 'state_bill'
  | 'regulation'
  // R4 §4.3: a Program Element funding movement on a client's watchlist.
  | 'program_element';
export type FeedSeverity = 'info' | 'notable' | 'critical';

export interface FeedBillEvidence {
  billId: string;
  displayNum: string;
  title: string | null;
  url: string | null;
  stage: string;
  actionText: string | null;
  actionDate: string | null;
  /** State Legislation Platform (S7.1): 2-letter state code, or 'US' for federal. */
  jurisdiction?: string;
}
export interface FeedHearingMention {
  segmentId: string | null;
  timestampMs: number | null;
  speakerName: string | null;
  quote: string | null;
  quoteSource: 'textPlain' | 'encrypted';
  issueTags: string[];
  term?: string;
  termType?: string;
  score?: number;
}
export interface FeedHearingEvidence {
  sessionId: string;
  title: string | null;
  committeeId: string | null;
  occurredAt: string | null;
  mentions: FeedHearingMention[];
}
/**
 * Program Element funding-movement evidence (R4 §4.3). Every amount is in MILLIONS
 * and carries its fiscal year + delta type; `href` is the deep link to the
 * line-level Program Element 360 dossier, which stays the source of truth (§4.2).
 */
export interface FeedProgramElementEvidence {
  peCode: string;
  title: string | null;
  fiscalYear: number;
  deltaType: string;
  deltaTypeLabel: string;
  fromRef: string | null;
  toRef: string | null;
  amountFromMillions: number | null;
  amountToMillions: number | null;
  deltaMillions: number | null;
  deltaPct: number | null;
  materialityScore: number;
  href: string;
}

/**
 * P0-07: intel-api normalizes every writer shape into ONE versioned contract on read
 * (apps/intel-api/src/feed/normalize-evidence.ts). The `bill` / `hearing` /
 * `programElement` / `link` keys are unchanged — the bill fix arrives for free because
 * `evidence.bill` finally exists for bill-change-detector alerts. Every NEW field is
 * optional so a cached page or a not-yet-deployed intel-api degrades cleanly, the same
 * posture as `tag?` and `recommendedActions?`.
 */
export interface FeedEvidence {
  /** Present once intel-api normalizes on read. Absent on a cached pre-Gate-C page. */
  schemaVersion?: number;
  type?: FeedSourceType | 'unknown';
  bill?: FeedBillEvidence;
  hearing?: FeedHearingEvidence;
  programElement?: FeedProgramElementEvidence;
  regulation?: Record<string, unknown>;
  link?: {
    via?: string;
    confidence?: number;
    matchCount?: number;
    billAlertId?: string | null;
    hearingAlertId?: string | null;
  };
  /** P1-09: the alert's relevance explanation, finally legible to a consumer. */
  match?: {
    matchedTags: string[];
    termId: string | null;
    topicLabel: string | null;
    why: string | null;
    details: Array<{
      termType: string;
      matchType: string;
      matchedText: string;
      sourceField: string;
      weight: number;
      confidence: number;
      explanation: string;
    }>;
  };
  provenance?: {
    sourceUrl: string | null;
    triggerKey: string | null;
    tone: string | null;
    band: string | null;
    jurisdiction: string;
    /** Gate L (HP-03) followup: the state legislative session's display name.
     *  Absent for federal alerts and for rows written before this was added. */
    session?: string;
    writerShape: string;
  };
  /** §4.8 (Gate D d-1): each factor's share of the score. Absent on any alert
   *  written before the re-weight — those carry v1 scores. */
  scoreFactors?: Record<string, number>;
  /** Factors with no signal at all. Rendered "unavailable", never as 0. */
  scoreUnavailable?: string[];
  /** Which scoring model produced `score`. Absent/1 = the pre-Gate-D model.
   *  Scoring is FORWARD-ONLY (§6.2), so a Priority list mixes the two. */
  scoreModel?: number;
  /** Every stored key the normalizer did not claim — nothing the writer recorded is lost. */
  extra?: Record<string, unknown>;
}

export type RecommendedActionKind =
  | 'draft_memo'
  | 'district_brief'
  | 'draft_outreach'
  | 'pull_quotes'
  | 'add_to_report'
  | 'add_talking_point'
  | 'open_bill'
  | 'open_hearing'
  /** R4 §4.3: open the line-level Program Element 360 dossier. */
  | 'open_program_element';

export interface RecommendedAction {
  kind: RecommendedActionKind;
  label: string;
  primary?: boolean;
  target?: { billId?: string; sessionId?: string; peCode?: string };
}

/** Current action state on an alert (decorated by intel-api from intel_action_item). */
export interface FeedItemActions {
  memo?: {
    documentAttachmentId: string | null;
    title: string | null;
    /** MP-13/H-5: the memo's most recent hold, if any. */
    reviewRequestId?: string | null;
  };
  inReport: boolean;
  talkingPoints: number;
}

/** P2-04: the CURRENT USER's triage state for this alert. The intelligence event
 *  itself is global (`intel_alert.status` is shared by the whole firm); this is
 *  per-user, so one analyst's dismiss never hides the alert from another.
 *  Decorated by intel-api in Gate D phase e — optional until then. */
export interface FeedItemWorkState {
  state: 'new' | 'in_review' | 'assigned' | 'actioned' | 'snoozed' | 'dismissed';
  assignedTo: string | null;
  assignedToName?: string | null;
  snoozedUntil: string | null;
  note: string | null;
}

export interface FeedItem {
  id: string;
  /** Owning client (always present). Drives the client label on the global feed. */
  clientId: string;
  /** Resolved client display name — only populated by the tenant-wide roll-up. */
  clientName?: string | null;
  sourceType: FeedSourceType;
  kind: string;
  severity: FeedSeverity;
  materiality: string;
  score: number;
  clientImpact: string | null;
  urgency: string | null;
  title: string;
  whyItMatters: string | null;
  /** The matched watchlist tag (topic label / term), for the calm feed card's
   *  tag CHIP (LegiWatch v2). Null/absent when no structured tag is available
   *  (optional so a cached page or a not-yet-deployed intel-api degrades cleanly). */
  tag?: string | null;
  recommendedAction: string | null;
  evidence: FeedEvidence;
  status: string;
  createdAt: string;
  /** Intelligent next-actions for this alert (memo / outreach / quotes / …). */
  recommendedActions?: RecommendedAction[];
  /** Whether a memo is already drafted, in the weekly report, etc. */
  actions?: FeedItemActions;
  /** P2-04: this user's own triage state. Absent = never triaged (treat as 'new'). */
  workState?: FeedItemWorkState;
}

export interface FeedResponse {
  items: FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
  counts: Partial<Record<FeedSourceType, number>>;
  /** Per-severity totals (tenant/client-scoped) for the Feed rail "At a glance". */
  severityCounts?: Partial<Record<FeedSeverity, number>>;
}

export type FeedFilter = 'all' | FeedSourceType;
export type FeedOrder = 'date' | 'score';

const enc = encodeURIComponent;

export const intelFeedPaths = {
  feed: (clientId: string) => `/intel-api/clients/${enc(clientId)}/feed`,
  // P11: tenant-wide cross-client roll-up (Radar's global altitude).
  tenantFeed: () => `/intel-api/clients/_all/feed`,
};

export const intelFeedKeys = {
  feed: (clientId: string, source: FeedFilter, order: FeedOrder) =>
    ['intel-feed', clientId, source, order] as const,
  // Distinct key namespace so the global roll-up never shares cache with a
  // per-client feed (which would leak cross-client rows into a client view).
  tenantFeed: (source: FeedFilter, order: FeedOrder) =>
    ['intel-feed', '_all', source, order] as const,
};

export const FEED_PAGE_SIZE = 25;

/**
 * Build the query string for one feed page.
 *
 * P2-04: `workFilter` is the per-user worklist facet. 'default' is the active
 * queue and is sent as NOTHING — the server already excludes this user's
 * dismissed and still-snoozed alerts by default, so omitting it keeps the
 * common case's URL (and therefore its cache entry) byte-identical to before.
 */
export function feedQueryString(
  source: FeedFilter,
  order: FeedOrder,
  cursor?: string,
  workFilter?: string,
): string {
  const p = new URLSearchParams();
  if (source !== 'all') p.set('sourceType', source);
  p.set('order', order);
  p.set('limit', String(FEED_PAGE_SIZE));
  if (cursor) p.set('cursor', cursor);
  if (workFilter && workFilter !== 'default') p.set('workState', workFilter);
  return p.toString();
}

export const SOURCE_LABEL: Record<FeedSourceType, string> = {
  bill: 'Bill',
  hearing: 'Hearing',
  combined: 'Bill + Hearing',
  state_bill: 'State bill',
  regulation: 'Regulation',
  program_element: 'Program element',
};

/**
 * P1-10/§4.8: the display band for an alert's score. Mirrors intel-api's
 * `bandOf` thresholds (alert-scorer.ts) exactly — do not drift them, or a
 * card's band stops matching the one stored on the alert and emailed.
 *
 * Prefers the band the WRITER stored in evidence (`provenance.band`) and only
 * derives from `score` when a pre-Gate-C row carries none.
 */
export function alertBand(item: FeedItem): 'High' | 'Med' | 'Low' {
  const stored = item.evidence?.provenance?.band;
  if (stored === 'High' || stored === 'Med' || stored === 'Low') return stored;
  const s = typeof item.score === 'number' ? item.score : 0;
  return s >= 0.66 ? 'High' : s >= 0.45 ? 'Med' : 'Low';
}

/** Human labels for the §4.8 score factors. */
export const SCORE_FACTOR_LABEL: Record<string, string> = {
  relevance: 'client relevance',
  materiality: 'materiality',
  urgency: 'time sensitivity',
  clientPriority: 'client priority',
  targetOpportunity: 'target opportunity',
  evidenceConfidence: 'evidence confidence',
  duplicationPenalty: 'duplication penalty',
};

/** §6.2: alerts written before the re-weight keep v1 scores. */
export const SCORE_MODEL_CURRENT = 2;

export function isPriorScoreModel(item: FeedItem): boolean {
  return (item.evidence?.scoreModel ?? 1) < SCORE_MODEL_CURRENT;
}

/**
 * §4.8 (d-5): the Priority chip's tooltip — every factor, its contribution, and
 * an explicit `unavailable` for anything with no signal. Falls back to the
 * generic sentence for a pre-re-weight alert, which carries no breakdown.
 */
export function scoreExplanation(item: FeedItem): string {
  const factors = item.evidence?.scoreFactors;
  const unavailable = item.evidence?.scoreUnavailable ?? [];
  if (!factors || !Object.keys(factors).length) {
    return (
      'Ranked from client relevance, materiality, urgency, and client priority. ' +
      'Scored by the prior model — see the Priority sort note.'
    );
  }
  const lines = Object.entries(factors).map(
    ([k, v]) => `${SCORE_FACTOR_LABEL[k] ?? k} — ${v >= 0 ? '+' : ''}${v.toFixed(2)}`,
  );
  // An unavailable factor is named as such rather than shown contributing 0.
  for (const k of unavailable) lines.push(`${SCORE_FACTOR_LABEL[k] ?? k} — unavailable`);
  return lines.join('\n');
}

/**
 * Feed → canonical Alert adapter (MeriV2 Phase-1, SC1.1/SC1.2): maps a
 * FeedItem onto the ONE seven-field Alert.
 *
 * P1-11: this is INTERNAL COMPLETENESS INSTRUMENTATION and is no longer
 * rendered to analysts. It used to drive an "incomplete" chip on the feed card,
 * which fired on EVERY alert because `whoActs` had no source and was hard-coded
 * to ''. The user-facing warning is now `materialGaps` in TrackerFeedPanel,
 * which only fires on evidence an analyst can act on. Items are still never
 * hidden or filtered on incompleteness (drop-nothing).
 *
 * `whoActs` now reads the per-user work state's assignee, so an unassigned
 * alert is legitimately incomplete on that field rather than artificially so.
 */
export function toCanonicalAlert(item: FeedItem): AlertBuildResult {
  return buildAlert({
    whatChanged: item.title,
    whyItMatters: item.whyItMatters ?? '',
    clientId: item.clientId,
    // P1-09: fall back to the normalized match block, so a bill-change alert (which
    // never carries a termId) yields a non-empty issueId instead of reading incomplete.
    issueId: item.tag ?? item.evidence.match?.matchedTags?.[0] ?? '',
    whoActs: item.workState?.assignedTo ?? '',
    deadline: item.evidence.bill?.actionDate ?? item.evidence.hearing?.occurredAt ?? null,
    sourceType: item.sourceType,
  });
}
