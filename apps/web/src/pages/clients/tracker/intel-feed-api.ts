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

export interface FeedItem {
  id: string;
  sourceType: FeedSourceType;
  kind: string;
  severity: FeedSeverity;
  materiality: string;
  score: number;
  clientImpact: string | null;
  urgency: string | null;
  title: string;
  whyItMatters: string | null;
  recommendedAction: string | null;
  evidence: FeedEvidence;
  status: string;
  createdAt: string;
}

export interface FeedResponse {
  items: FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
  counts: Partial<Record<FeedSourceType, number>>;
}

export type FeedFilter = 'all' | FeedSourceType;
export type FeedOrder = 'date' | 'score';

const enc = encodeURIComponent;

export const intelFeedPaths = {
  feed: (clientId: string) => `/intel-api/clients/${enc(clientId)}/feed`,
};

export const intelFeedKeys = {
  feed: (clientId: string, source: FeedFilter, order: FeedOrder) =>
    ['intel-feed', clientId, source, order] as const,
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
