/**
 * Typed client + query keys for the unified intel FEED (Phase 6 §9.7).
 * Reads intel-api `GET /intel-api/clients/:clientId/feed` (bill|hearing|combined
 * alerts, keyset-paginated). Gated in the UI by the `tracker_v2` intel feature
 * flag — invisible until a tenant is cut over. Types mirror
 * apps/intel-api/src/feed/feed.service.ts.
 */

export type FeedSourceType = 'bill' | 'hearing' | 'combined';
export type FeedSeverity = 'info' | 'notable' | 'critical';

export interface FeedBillEvidence {
  billId: string;
  displayNum: string;
  title: string | null;
  url: string | null;
  stage: string;
  actionText: string | null;
  actionDate: string | null;
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
export interface FeedEvidence {
  bill?: FeedBillEvidence;
  hearing?: FeedHearingEvidence;
  link?: { via?: string; confidence?: number; matchCount?: number; billAlertId?: string | null; hearingAlertId?: string | null };
}

export type RecommendedActionKind =
  | 'draft_memo'
  | 'draft_outreach'
  | 'pull_quotes'
  | 'add_to_report'
  | 'add_talking_point'
  | 'open_bill'
  | 'open_hearing';

export interface RecommendedAction {
  kind: RecommendedActionKind;
  label: string;
  primary?: boolean;
  target?: { billId?: string; sessionId?: string };
}

/** Current action state on an alert (decorated by intel-api from intel_action_item). */
export interface FeedItemActions {
  memo?: { documentAttachmentId: string | null; title: string | null };
  inReport: boolean;
  talkingPoints: number;
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

/** Build the query string for one feed page. */
export function feedQueryString(source: FeedFilter, order: FeedOrder, cursor?: string): string {
  const p = new URLSearchParams();
  if (source !== 'all') p.set('sourceType', source);
  p.set('order', order);
  p.set('limit', String(FEED_PAGE_SIZE));
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

export const SOURCE_LABEL: Record<FeedSourceType, string> = {
  bill: 'Bill',
  hearing: 'Hearing',
  combined: 'Bill + Hearing',
};
