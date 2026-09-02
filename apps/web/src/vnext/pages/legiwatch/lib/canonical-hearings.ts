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
import { normalizeCalendarPage, liveHearingApiError } from '../../../../pages/radar/live-hearings/live-hearings-api.js';
import type { LiveHearingCalendarPage } from '../../../../pages/radar/live-hearings/live-hearings.types.js';

export interface WeekRangeParams {
  /** Inclusive Eastern calendar day `YYYY-MM-DD`. */
  from: string;
  /** Exclusive Eastern calendar day `YYYY-MM-DD` (the Monday after the week). */
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
export function useLwWeekCalendar(params: WeekRangeParams) {
  const api = useApi();
  return useQuery<LiveHearingCalendarPage, Error>({
    queryKey: ['lw', 'canonical-calendar', params],
    queryFn: async () => {
      const q = new URLSearchParams();
      q.set('from', params.from);
      q.set('to', params.to);
      // The week grid renders at most 7 days; 200 rows is the server's max page
      // and comfortably bounds any real week. Overflow is surfaced honestly
      // (total > rows.length) rather than silently hidden.
      q.set('pageSize', '200');
      q.set('page', '1');
      if (params.eventStatus) q.set('eventStatus', params.eventStatus);
      if (params.chamber) q.set('chamber', params.chamber);
      if (params.committee) q.set('committee', params.committee);
      if (params.q) q.set('q', params.q);
      try {
        return normalizeCalendarPage((await api.get<unknown>(`/api/legiwatch/live-hearings/calendar?${q.toString()}`)).data);
      } catch (err) {
        throw new Error(liveHearingApiError(err));
      }
    },
    // Week navigation is user-paced; never refetch behind the user's back and
    // never retry-storm a failing endpoint (QA §19).
    staleTime: 60_000,
    retry: false,
  });
}
