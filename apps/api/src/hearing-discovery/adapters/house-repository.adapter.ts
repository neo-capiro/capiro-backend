/**
 * House Committee Repository discovery adapter (`house-repository`).
 *
 * docs.house.gov is the House Clerk's own repository and publishes upcoming
 * House meetings BEFORE the Congress.gov API reflects them (the API lags the
 * Clerk by a day or more), so this is the source that makes the forward window
 * usable for the House. Its rows carry the same `EventID` Congress.gov uses for
 * `house-event`, which is why both adapters land on `cm-{congress}-{eventId}`
 * and merge onto one canonical hearing.
 *
 * Priority is deliberately WORSE (higher number) than `congress-gov`: docs.house
 * is faster but thinner — no witnesses, no system code, no agenda bills — so
 * where the two disagree the API wins, while docs.house still fills the fields
 * the API has not published yet. That is exactly what the projection in
 * `canonical-diff.ts` does with source priority.
 */
import { etCalendarDay, houseStartsAt } from '../hearing-time.js';
import { inferVisibility, normalizeEventStatus } from '../hearing-identity.js';
import { byDayUrl, inferHouseType, parseByDay } from './house-docs-parse.js';
import { fetchText, sleep } from './source-http.js';
import type {
  CommitteeSourceAdapter,
  DiscoveryContext,
  SourceDescriptor,
  SourceEvent,
  SourceHealth,
} from '../hearing-discovery.types.js';

export interface HouseRepositoryAdapterOptions {
  /** Current Congress, for the canonical `cm-{congress}-{eventId}` id. */
  congress: number;
  /**
   * Committee display name → congress_committee.system_code. docs.house.gov
   * publishes only a name, and without a system code the event cannot be filed
   * under a committee on the master calendar.
   */
  resolveSystemCodeByName?: (committeeName: string) => string | null;
}

export class HouseRepositoryAdapter implements CommitteeSourceAdapter {
  readonly adapterKey = 'house-repository';
  readonly parserVersion = 'house-repository/2026-10-06-completeness';
  discoveryErrors: string[] = [];

  constructor(private readonly options: HouseRepositoryAdapterOptions) {}

  async discoverEvents(source: SourceDescriptor, ctx: DiscoveryContext): Promise<SourceEvent[]> {
    this.discoveryErrors = [];
    const events: SourceEvent[] = [];
    // Anchor on the EASTERN calendar day: docs.house.gov publishes an Eastern
    // calendar, and a UTC anchor silently skips the current day's page between
    // 8 PM and midnight ET (the defect this comment's ancestor documents).
    const base = etCalendarDay(new Date());

    for (let offset = 0; offset <= ctx.daysAhead; offset += 1) {
      const day = new Date(base.getTime() + offset * 86_400_000);
      await sleep(ctx.delayMs);
      const res = await fetchText(byDayUrl(day), { accept: 'text/html' });
      if (!res.ok || res.body == null) {
        const error = `ByDay ${byDayUrl(day)} failed: ${res.error ?? 'no body'}`;
        this.discoveryErrors.push(error);
        ctx.log(`[house-repository] ${error}`);
        continue;
      }
      for (const meeting of parseByDay(res.body)) {
        const systemCode = this.options.resolveSystemCodeByName?.(meeting.committee) ?? null;
        const type = inferHouseType(meeting.title, meeting.committee);
        events.push({
          externalEventId: meeting.eventId,
          congress: this.options.congress,
          chamber: 'house',
          committeeSystemCode: systemCode,
          committeeName: meeting.committee,
          title: meeting.title || null,
          eventType: type,
          // The repository has no status column; a canceled meeting is simply
          // removed from the day page. Reporting null (not 'scheduled') keeps
          // this source from clearing a cancellation Congress.gov published.
          eventStatus: normalizeEventStatus(null),
          visibility: inferVisibility(meeting.title, type),
          startsAt: houseStartsAt(day, meeting.time),
          calendarDate: day,
          displayTime: meeting.time,
          location: meeting.location,
          officialPageUrl: `https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=${meeting.eventId}`,
          witnesses: [],
          agendaBillIds: [],
          sourceUpdatedAt: null,
          streamCandidates: [],
          raw: { source: 'docs.house.gov/ByDay', committeeAsPublished: meeting.committee },
        });
      }
    }

    // Preserve valid days while callers record every unreadable day as partial.
    return events;
  }

  async healthCheck(source: SourceDescriptor, ctx: DiscoveryContext): Promise<SourceHealth> {
    const day = etCalendarDay(new Date());
    const res = await fetchText(byDayUrl(day), { accept: 'text/html', timeoutMs: 15_000 });
    return {
      ok: res.ok,
      status: res.status,
      durationMs: res.durationMs,
      error: res.error,
      observedEvents: res.body ? parseByDay(res.body).length : null,
    };
  }
}
