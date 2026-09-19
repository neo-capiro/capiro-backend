/**
 * "View latest Florida hearings" — an explicit, bounded lookup for the most
 * recent canonical Florida proceeding that MATCHES the active calendar
 * selection (committee / kind / search / chamber / session / following /
 * folder billIds), ignoring only the date bounds and pagination. This is NOT
 * automatic: the calendar never changes the date window in response to a
 * filter, and this hook is only invoked by a deliberate user action (see
 * HearingsTab). The single most-recent matching row is fetched (pageSize 1,
 * latest-first); there is no all-history fetch into the browser, and because
 * the lookup honors the active filters, the row it finds can actually render
 * in the calendar it jumps to.
 *
 * Public Florida rows are visible to every tenant — no media feature flag is
 * required to VIEW them. The query is served by the same global canonical
 * calendar endpoint as the week view, with the whitelisted `sort=desc`
 * direction the server added for exactly this lookup.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import {
  normalizeCalendarPage,
  liveHearingApiError,
} from '../../../../pages/radar/live-hearings/live-hearings-api.js';
import type { CanonicalHearingEvent } from '../../../../pages/radar/live-hearings/live-hearings.types.js';

export interface LatestFloridaHearingLookup {
  /** The most recent matching Florida hearing, or null when none exists. */
  hearing: CanonicalHearingEvent | null;
  /** True once the server answered — distinguishes "no matching FL rows" from "loading". */
  answered: boolean;
}

/**
 * The active calendar selection, minus the date bounds and pagination that
 * would defeat the point of a "find the latest" lookup. Every filter the user
 * actually set is preserved, so a jump to the returned event's week shows the
 * event — the row matches the same predicate the calendar renders.
 */
export interface LatestFloridaSelection {
  committee?: string;
  q?: string;
  eventType?: string;
  session?: string;
  following?: boolean;
  chamber?: string;
  eventStatus?: string;
  /**
   * Explicit folder-selection billIds. `undefined` = no folder filter (use the
   * plain GET). A NON-empty array = POST the folder selection. An EMPTY array
   * is a real selection state (the user picked folders that match nothing) —
   * NOT "no filter" — and must short-circuit to an honest "no matching rows"
   * answer rather than fall through to the global GET (which would return an
   * unrelated hearing the calendar itself can never render).
   */
  billIds?: string[];
}

interface ApiLike {
  get: (url: string) => Promise<{ data: unknown }>;
  post: (url: string, body: unknown) => Promise<{ data: unknown }>;
}

/**
 * The bounded "latest matching FL hearing" fetch, extracted so it is testable
 * without the react-query runtime. Returns the single most-recent matching
 * row (or null), never an unrelated global hearing.
 */
export async function fetchLatestFloridaHearing(
  api: ApiLike,
  selection: LatestFloridaSelection,
): Promise<LatestFloridaHearingLookup> {
  // An explicitly empty folder selection means the user picked folders that
  // match NOTHING — the calendar returns [] for it (the existing week hook
  // renders an empty range without a fallback to a global read). Mirror that
  // here: no request, and an honest "no matching FL rows" answer.
  if (selection.billIds !== undefined && selection.billIds.length === 0) {
    return { hearing: null, answered: true };
  }
  const data = selection.billIds?.length
    ? (
        await api.post('/api/legiwatch/live-hearings/calendar/query', {
          jurisdiction: 'FL',
          sort: 'desc',
          pageSize: 1,
          ...selection,
        })
      ).data
    : (
        await api.get(
          `/api/legiwatch/live-hearings/calendar?${latestFloridaQueryString(selection)}`,
        )
      ).data;
  const page = normalizeCalendarPage(data);
  return { hearing: page.items[0] ?? null, answered: true };
}

/** GET query string for the no-folder path (mirrors the POST body exactly). */
function latestFloridaQueryString(selection: LatestFloridaSelection): string {
  const q = new URLSearchParams();
  q.set('jurisdiction', 'FL');
  q.set('sort', 'desc');
  q.set('pageSize', '1');
  if (selection.committee) q.set('committee', selection.committee);
  if (selection.q) q.set('q', selection.q);
  if (selection.eventType) q.set('eventType', selection.eventType);
  if (selection.session) q.set('session', selection.session);
  if (selection.following) q.set('following', 'true');
  if (selection.chamber) q.set('chamber', selection.chamber);
  if (selection.eventStatus) q.set('eventStatus', selection.eventStatus);
  return q.toString();
}

export function useLatestFloridaHearing(
  selection: LatestFloridaSelection,
  enabled: boolean,
) {
  const api = useApi();
  const actor = useApiScope();
  return useQuery<LatestFloridaHearingLookup, Error>({
    queryKey: ['lw', 'latest-florida-hearing', actor, selection],
    enabled,
    queryFn: async () => {
      try {
        return await fetchLatestFloridaHearing(api, selection);
      } catch (err) {
        throw new Error(liveHearingApiError(err));
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}
