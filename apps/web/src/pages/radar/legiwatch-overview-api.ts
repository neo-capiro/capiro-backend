import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { useUpcomingHearings, type UpcomingHearing } from '../../lib/hearing-watch-api.js';
import { intelFeedPaths, type FeedResponse } from '../clients/tracker/intel-feed-api.js';
import { intelTrackerPaths } from '../clients/tracker/intel-tracker-api.js';
import type { BoardBill, BoardResponse } from '../clients/tracker/tracker-api.js';

/**
 * The aggregate counters behind the LegiWatch header strip and tab badges.
 *
 * Every figure here is a server-side count, not a page length. Three numbers
 * the v3 mockup also showed — comment deadlines closing, source-coverage gaps,
 * and per-hearing watchlist hits — are deliberately absent: intel-api has no
 * aggregate for the first two, and `watchlistMatchCount` only counts matches
 * found while a hearing was being live-transcribed, so it reads 0 for every
 * hearing nobody captured and would misreport a schedule.
 */
export interface LegiWatchOverview {
  needsReview: number | null;
  needsReviewCritical: number | null;
  billsMovingThisWeek: number | null;
  hearingsToday: number | null;
  hearingsThisWeek: number | null;
  /** Rows behind the rail widgets, from the same two queries as the counts. */
  todayHearings: UpcomingHearing[];
  movingBills: BoardBill[];
  hearingsUnavailable: boolean;
}

const CHANGED_WITHIN_DAYS = 7;

/** Local calendar day as `YYYY-MM-DD`, matching `UpcomingHearing.scheduledAt`. */
function localDayKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function useLegiWatchOverview(opts: {
  clientId: string | null;
  feedEnabled: boolean;
  hearingsEnabled: boolean;
}): LegiWatchOverview {
  const { clientId, feedEnabled, hearingsEnabled } = opts;
  const api = useApi();
  const scope = clientId ?? '_all';

  // limit=1 because only the `counts`/`severityCounts` facets are wanted; the
  // server computes those over the whole filtered set, not the returned page.
  const needsReviewQuery = useQuery({
    queryKey: ['legiwatch-overview', 'needs-review', scope],
    queryFn: async () => {
      const base = clientId ? intelFeedPaths.feed(clientId) : intelFeedPaths.tenantFeed();
      const res = await api.get<FeedResponse>(`${base}?workState=new&limit=1`);
      return res.data;
    },
    enabled: feedEnabled,
    retry: false,
    staleTime: 60_000,
  });

  const billsMovingQuery = useQuery({
    queryKey: ['legiwatch-overview', 'bills-moving', scope],
    queryFn: async () => {
      const res = await api.get<BoardResponse>(
        intelTrackerPaths.board(scope, undefined, { changedWithinDays: CHANGED_WITHIN_DAYS }),
      );
      return res.data;
    },
    retry: false,
    staleTime: 60_000,
  });

  // Shares ['intel','upcoming-hearings'] with the Hearings tab, so opening that
  // tab reuses this cache entry rather than issuing a second request.
  const hearingsQuery = useUpcomingHearings();

  const feed = needsReviewQuery.data;
  const needsReview = feed
    ? Object.values(feed.counts ?? {}).reduce<number>((sum, n) => sum + (n ?? 0), 0)
    : null;

  let hearingsToday: number | null = null;
  let hearingsThisWeek: number | null = null;
  let todayHearings: UpcomingHearing[] = [];
  if (hearingsEnabled && hearingsQuery.data) {
    const today = new Date();
    const todayKey = localDayKey(today);
    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndKey = localDayKey(weekEnd);
    todayHearings = hearingsQuery.data.filter((h) => h.scheduledAt === todayKey);
    hearingsToday = todayHearings.length;
    hearingsThisWeek = hearingsQuery.data.filter(
      (h) => h.scheduledAt >= todayKey && h.scheduledAt <= weekEndKey,
    ).length;
  }

  // A legacy or `_all` board response can omit `bills` on a column; flatMap
  // would then keep the undefined as an element and the rail would crash on the
  // first field read.
  const movingBills = (billsMovingQuery.data?.columns ?? [])
    .flatMap((c) => c?.bills ?? [])
    .filter((b): b is BoardBill => Boolean(b))
    .sort((a, b) => (b.latestActionDate ?? '').localeCompare(a.latestActionDate ?? ''));

  return {
    needsReview,
    needsReviewCritical: feed?.severityCounts?.critical ?? null,
    billsMovingThisWeek: billsMovingQuery.data?.total ?? null,
    hearingsToday,
    hearingsThisWeek,
    todayHearings,
    movingBills,
    // A failed schedule fetch must not read as "no hearings today" (v3 rule 06).
    hearingsUnavailable: hearingsEnabled && hearingsQuery.isError,
  };
}
