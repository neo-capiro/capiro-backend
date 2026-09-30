/**
 * Canonical hearing-calendar access for the vNext LegiWatch module (PR A).
 *
 * Reuses the Phase 7/8 canonical contracts (`/api/legiwatch/live-hearings/*`)
 * and normalizers that the legacy surface already ships, so vNext and Radar
 * share ONE backend, ONE normalizer and ONE capability model:
 *
 *  - LW-QA-001: rows carry the true `startsAt` instant (or none) — the shared
 *    date/time contract in `./hearing-datetime.ts` renders it honestly.
 *  - LW-QA-002: rows carry `visibility` + `capturePolicy`, so a closed session
 *    is classified before any capture affordance is offered.
 *  - LW-QA-005: the calendar is fetched per selected date RANGE (`from`/`to`),
 *    so historical weeks fetch real completed/archive rows and counts are the
 *    server's count for exactly the visible range.
 */
export {
  normalizeCanonicalHearingEvent,
  normalizeCalendarPage,
  liveHearingApiError,
  useLiveHearingsCalendar,
  useLiveHearingsLive,
  useCanonicalHearingEvent,
  useHearingUpdates,
  usePublicHearingTranscript,
  useHearingIntelligence,
  useCommitteeRoom,
} from '../../../../pages/radar/live-hearings/live-hearings-api.js';
export {
  browserCaptureCapability,
  serverCaptureCapability,
  capturePolicyLabel,
  captureStatusLabel,
  isLiveEvent,
  safeOfficialHttpUrl,
} from '../../../../pages/radar/live-hearings/live-hearings-capability.js';
export type {
  CanonicalHearingEvent,
  LiveHearingCalendarPage,
  PublicTranscriptPage,
  PublicTranscriptSegment,
  HearingIntelligenceItem,
  HearingCommitteeRoom,
  HearingSiteUpdate,
} from '../../../../pages/radar/live-hearings/live-hearings.types.js';

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import {
  normalizeCalendarPage,
  liveHearingApiError,
} from '../../../../pages/radar/live-hearings/live-hearings-api.js';
import type { LiveHearingCalendarPage } from '../../../../pages/radar/live-hearings/live-hearings.types.js';

export interface WeekRangeParams {
  jurisdiction?: 'US' | 'FL' | 'ALL';
  session?: string;
  stateCommitteeId?: string;
  billIds?: string[];
  following?: boolean;
  eventType?: string;
  /** Inclusive Eastern calendar day `YYYY-MM-DD` (the week's Monday). */
  from: string;
  /**
   * Inclusive Eastern calendar day `YYYY-MM-DD` (the week's Sunday). The API
   * filters `date.lte`, so both ends are INCLUSIVE — a Sunday hearing is inside
   * the range. Never send the following Monday here: it would pull next week's
   * rows into this week's query.
   */
  to: string;
  eventStatus?: string;
  chamber?: string;
  committee?: string;
  q?: string;
}

/**
 * Week-scoped canonical calendar fetch (LW-QA-005). The query key includes the
 * range so navigating weeks cannot serve one week's data for another, and the
 * `from`/`to` bounds make historical weeks return their real rows — including
 * completed events — instead of paging a fixed forward-only window locally.
 */
// The server's own per-page cap (live-hearings.service.ts MAX_PAGE_SIZE). A
// week's TRUE total can exceed this — 230 tracked committees/subcommittees
// can each hold a hearing in the same week — so a single fetch is not enough
// to promise "every hearing this week is in this grid."
const CALENDAR_PAGE_SIZE = 200;
// Hard ceiling on follow-up pages so a runaway total can never hang the UI in
// a fetch loop; 20 pages (4,000 rows) is far beyond any plausible week even
// once full multi-source discovery is live. If this is ever actually hit, the
// remainder is surfaced honestly (total > rows.length) rather than fetched
// forever or silently dropped.
const CALENDAR_MAX_PAGES = 20;

export function useLwWeekCalendar(params: WeekRangeParams, enabled = true) {
  const api = useApi();
  const actor = useApiScope();
  return useQuery<LiveHearingCalendarPage, Error>({
    queryKey: ['lw', 'canonical-calendar', actor, params],
    enabled,
    queryFn: async () => {
      const q = new URLSearchParams();
      q.set('from', params.from);
      q.set('to', params.to);
      q.set('pageSize', String(CALENDAR_PAGE_SIZE));
      if (params.eventStatus) q.set('eventStatus', params.eventStatus);
      if (params.chamber) q.set('chamber', params.chamber);
      if (params.committee) q.set('committee', params.committee);
      if (params.q) q.set('q', params.q);
      for (const key of [
        'jurisdiction',
        'session',
        'stateCommitteeId',
        'following',
        'eventType',
      ] as const)
        if (params[key] !== undefined) q.set(key, String(params[key]));
      const readPage = async () =>
        params.billIds
          ? (
              await api.post<unknown>('/api/legiwatch/live-hearings/calendar/query', {
                ...params,
                page: Number(q.get('page')),
                pageSize: CALENDAR_PAGE_SIZE,
              })
            ).data
          : (await api.get<unknown>(`/api/legiwatch/live-hearings/calendar?${q.toString()}`)).data;
      try {
        // The week grid must show every hearing in range, not just the first
        // page — a single week can plausibly exceed one page's worth once
        // hearings are tracked across all committees/subcommittees. Keep
        // fetching subsequent pages until the server's own `total` is fully
        // accounted for (or the safety ceiling above trips).
        q.set('page', '1');
        const first = normalizeCalendarPage(await readPage());
        const rows = [...first.items];
        let page = 1;
        while (rows.length < first.total && page < CALENDAR_MAX_PAGES) {
          page += 1;
          q.set('page', String(page));
          const next = normalizeCalendarPage(await readPage());
          if (next.items.length === 0) break;
          rows.push(...next.items);
        }
        return { ...first, items: rows };
      } catch (err) {
        throw new Error(liveHearingApiError(err));
      }
    },
    // Keep the selected week and filters stable while detecting hearings that
    // start live and capture requests that advance during an open session.
    staleTime: 60_000,
    // Week navigation is user initiated; retain the current grid while the
    // next range loads so the calendar does not collapse into a transient
    // loading panel between the latest-hearing jump and its settled result.
    placeholderData: (previous) => previous,
    retry: false,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
}
