/**
 * Congress.gov committee-meeting discovery adapter (`congress-gov`).
 *
 * PRIMARY source, and the highest-authority one: it is the only Congress.gov
 * endpoint carrying UPCOMING scheduled hearings/markups with date, time, room
 * and status, and its `eventId` is the identifier both chambers key on — which
 * is why the canonical id stays `cm-{congress}-{eventId}` and this adapter's
 * rows merge with whatever `sync-hearings.ts` already wrote instead of
 * duplicating it.
 *
 * Cost shape: the list endpoint is minimal (eventId/updateDate/chamber/url), so
 * each event needs a detail fetch. For a 10-15 minute cadence that must not mean
 * ~2,650 detail calls a run, so the adapter narrows by `fromDateTime` off the
 * SyncRun watermark and bounds pages.
 *
 * Both of those were VERIFIED live against api.congress.gov on 2026-08-20 rather
 * than assumed:
 *   - `fromDateTime=2026-08-19T00:00:00Z` reduced pagination.count from 2656 to
 *     5, so the updateDate filter is genuinely applied server-side.
 *   - the list is ordered by updateDate DESCENDING (offset 0 is the newest
 *     change; offset 2650 is January 2025), so even an unfiltered first page
 *     returns exactly the events that changed most recently.
 * Together those make an incremental run cheap, and the page bound keeps a
 * cold-start run finite.
 */
import { formatTime, hearingCalendarDate, resolveSourceTime, safeDate } from '../hearing-time.js';
import { inferVisibility, normalizeChamber, normalizeEventStatus } from '../hearing-identity.js';
import {
  advertisedVideoCandidates,
  formatLocation,
  formatWitnesses,
  meetingPublicUrl,
  relatedAgendaBills,
} from './congress-gov-parse.js';
import { fetchJson, sleep } from './source-http.js';
import type {
  CommitteeSourceAdapter,
  DiscoveryContext,
  SourceDescriptor,
  SourceEvent,
  SourceHealth,
} from '../hearing-discovery.types.js';

export const CONGRESS_BASE = 'https://api.congress.gov/v3';

interface MeetingListItem {
  eventId?: string | null;
  chamber?: string | null;
  congress?: number | null;
  url?: string | null;
  updateDate?: string | null;
}

interface MeetingDetail {
  eventId?: string | null;
  chamber?: string | null;
  congress?: number | null;
  title?: string | null;
  type?: string | null;
  meetingStatus?: string | null;
  date?: string | null;
  updateDate?: string | null;
  location?: { building?: string | null; room?: string | null } | null;
  committees?: Array<{ name?: string | null; systemCode?: string | null }> | null;
  videos?: Array<{ name?: string | null; url?: string | null }> | null;
  witnesses?: Array<{
    name?: string | null;
    position?: string | null;
    organization?: string | null;
  }> | null;
  relatedItems?: {
    bills?: Array<{
      type?: string | null;
      number?: number | string | null;
      congress?: number | null;
      url?: string | null;
    }> | null;
  } | null;
}

export interface CongressGovAdapterOptions {
  apiKey: string;
  /** Congress numbers to scan. Defaults to the current Congress only. */
  congresses?: number[];
  /** Hard page bound per congress, so a run is always finite. */
  maxPages?: number;
  listLimit?: number;
  /** systemCode → display name, normally served from our own congress_committee. */
  resolveCommitteeName?: (systemCode: string) => string | null;
}

export class CongressGovAdapter implements CommitteeSourceAdapter {
  readonly adapterKey = 'congress-gov';
  readonly parserVersion = 'congress-gov/2026-08-20';

  constructor(private readonly options: CongressGovAdapterOptions) {}

  async discoverEvents(source: SourceDescriptor, ctx: DiscoveryContext): Promise<SourceEvent[]> {
    if (!this.options.apiKey) {
      throw new Error('CONGRESS_API_KEY is required for the congress-gov adapter');
    }
    const congresses = this.options.congresses ?? [currentCongress()];
    const listLimit = this.options.listLimit ?? 250;
    const maxPages = this.options.maxPages ?? 8;
    const events: SourceEvent[] = [];

    for (const congress of congresses) {
      let offset = 0;
      for (let page = 0; page < maxPages; page += 1) {
        await sleep(ctx.delayMs);
        const listUrl = this.listUrl(congress, listLimit, offset, ctx.since);
        const list = await fetchJson<{ committeeMeetings: MeetingListItem[] }>(listUrl);
        if (!list.ok) {
          throw new Error(`committee-meeting list failed: ${list.error ?? 'unknown'}`);
        }
        const items = list.data?.committeeMeetings ?? [];
        if (items.length === 0) break;

        for (const item of items) {
          if (!item.eventId || !item.url) continue;
          await sleep(ctx.delayMs);
          const detail = await fetchJson<{ committeeMeeting: MeetingDetail }>(
            this.withAuth(item.url),
          );
          const d = detail.data?.committeeMeeting;
          if (!d) {
            // A single unreadable detail record must not abort discovery; the
            // caller counts it, and the coverage audit surfaces a pattern of them.
            ctx.log(
              `[congress-gov] detail fetch failed for event ${item.eventId}: ${detail.error ?? 'no payload'}`,
            );
            continue;
          }
          const event = this.toSourceEvent(d, item, congress, ctx);
          if (event) events.push(event);
        }

        offset += listLimit;
        if (items.length < listLimit) break;
      }
    }
    return events;
  }

  async healthCheck(source: SourceDescriptor, ctx: DiscoveryContext): Promise<SourceHealth> {
    const url = this.listUrl(this.options.congresses?.[0] ?? currentCongress(), 1, 0, null);
    const res = await fetchJson<{ committeeMeetings: MeetingListItem[] }>(url, {
      timeoutMs: 15_000,
    });
    return {
      ok: res.ok,
      status: res.status,
      durationMs: res.durationMs,
      error: res.error,
      observedEvents: res.data?.committeeMeetings?.length ?? null,
    };
  }

  /** Normalize one committee-meeting detail into a canonical observation. */
  private toSourceEvent(
    d: MeetingDetail,
    item: MeetingListItem,
    congress: number,
    ctx: DiscoveryContext,
  ): SourceEvent | null {
    const eventId = (d.eventId ?? item.eventId ?? '').trim();
    if (!eventId) return null;
    const instant = safeDate(d.date);
    if (!instant) {
      // No date at all: recorded as skipped rather than filed under a fabricated
      // day. `committee_hearing.date` is NOT NULL, and guessing would misplace
      // the event on the master calendar permanently.
      ctx.log(`[congress-gov] event ${eventId} has no parseable date; skipped`);
      return null;
    }
    const chamber = normalizeChamber(d.chamber ?? item.chamber);
    const systemCode = d.committees?.[0]?.systemCode ?? null;
    const committeeName =
      (systemCode ? this.options.resolveCommitteeName?.(systemCode) : null) ??
      d.committees?.[0]?.name ??
      null;
    const officialPageUrl = meetingPublicUrl(d, congress, chamber, eventId);
    const status = normalizeEventStatus(d.meetingStatus);

    // Zone-aware WHEN resolution (2026-09-04 field-hearing defect class). The
    // Congress.gov detail payload gives the instant + its own wall clock; a
    // field hearing's zone comes only from an EXPLICIT source statement, so
    // `resolveSourceTime` keeps normal Washington hearings on the Eastern
    // instant verbatim and only overrides when a first-party page states an
    // explicit local clock + zone (carried via the payload's optional
    // `timezone` field when present).
    const resolved = resolveSourceTime({
      instant,
      calendarDay: hearingCalendarDate(instant),
      displayClock: formatTime(d.date),
      zoneToken: (d as { timezone?: string | null }).timezone ?? null,
    });
    if (resolved.authority === 'explicit_local') {
      ctx.log(
        `[congress-gov] event ${eventId}: explicit local time ${resolved.displayTime} ` +
          `${resolved.timeZone} overrides the central-calendar instant`,
      );
    }

    return {
      externalEventId: eventId,
      congress: d.congress ?? item.congress ?? congress,
      chamber,
      committeeSystemCode: systemCode,
      // Congress.gov's committees[] does not distinguish parent from sub; a
      // second entry, when present, is the subcommittee.
      subcommitteeSystemCode: d.committees?.[1]?.systemCode ?? null,
      committeeName,
      title: d.title?.trim() || null,
      eventType: d.type?.trim() || null,
      eventStatus: status,
      visibility: inferVisibility(d.title, d.type),
      startsAt: resolved.startsAt,
      calendarDate: resolved.calendarDate,
      displayTime: resolved.displayTime,
      timeZone: resolved.timeZone,
      location: formatLocation(d.location),
      officialPageUrl,
      witnesses: formatWitnesses(d.witnesses),
      agendaBillIds: relatedAgendaBills(d).map((b) => b.billId),
      sourceUpdatedAt: safeDate(d.updateDate ?? item.updateDate),
      streamCandidates: advertisedVideoCandidates(d, officialPageUrl).map((c) => ({
        provider: c.provider,
        officialPageUrl: c.officialPageUrl,
        mediaUrl: c.mediaUrl,
      })),
      raw: {
        meetingStatus: d.meetingStatus ?? null,
        rawType: d.type ?? null,
        committees: d.committees ?? [],
      },
    };
  }

  private listUrl(congress: number, limit: number, offset: number, since: Date | null): string {
    const params = new URLSearchParams({
      api_key: this.options.apiKey,
      format: 'json',
      limit: String(limit),
      offset: String(offset),
    });
    // Congress.gov's updateDate window. Applied when we have a watermark so a
    // routine run only revisits records the source itself changed.
    if (since) params.set('fromDateTime', toCongressDateTime(since));
    return `${CONGRESS_BASE}/committee-meeting/${congress}?${params.toString()}`;
  }

  /**
   * Single-event fetch for the provenance backfill: the SAME detail endpoint,
   * the SAME normalizer (`toSourceEvent`) and the SAME parser version as
   * scheduled discovery — so an observation written by the backfill is
   * indistinguishable from one written by the recurring job. Exposed as a
   * public method instead of teaching the backfill to page the list endpoint.
   */
  async fetchCommitteeMeetingDetail(
    externalEventId: string,
    congress: number = this.options.congresses?.[0] ?? currentCongress(),
    chamber?: 'house' | 'senate' | 'joint',
  ): Promise<MeetingDetail | null> {
    if (!this.options.apiKey) {
      throw new Error('CONGRESS_API_KEY is required for the congress-gov adapter');
    }
    // The detail resource is namespaced by chamber:
    // /committee-meeting/{congress}/{chamber}/{eventId} — verified live 2026-09-01
    // (a chamber-less path 404s with "Unknown resource").
    const segments = chamber
      ? `${congress}/${chamber}`
      : `${congress}/house/${externalEventId}|${congress}/senate/${externalEventId}`;
    const urls = chamber
      ? [`${CONGRESS_BASE}/committee-meeting/${segments}/${externalEventId}?api_key=${this.options.apiKey}&format=json`]
      : segments
          .split('|')
          .map(
            (s) =>
              `${CONGRESS_BASE}/committee-meeting/${s}/${externalEventId}?api_key=${this.options.apiKey}&format=json`,
          );
    for (const url of urls) {
      const detail = await fetchJson<{ committeeMeeting: MeetingDetail }>(url, {
        timeoutMs: 15_000,
      });
      const meeting = detail.data?.committeeMeeting ?? null;
      if (meeting) return meeting;
    }
    return null;
  }

  /**
   * Public wrapper over the private normalizer for the single-event fetch path.
   * `item` carries only what the detail record omits (list metadata), which for
   * a direct event fetch is the congress number itself.
   */
  toSourceEventPublic(
    d: MeetingDetail,
    source: SourceDescriptor,
  ): SourceEvent | null {
    const congress = d.congress ?? currentCongress();
    return this.toSourceEvent(d, { eventId: null, congress }, congress, {
      since: null,
      daysAhead: 0,
      delayMs: 0,
      log: () => {},
    });
  }

  private withAuth(rawUrl: string): string {
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}api_key=${this.options.apiKey}&format=json`;
  }
}

/** Congress.gov wants `YYYY-MM-DDTHH:MM:SSZ` with no milliseconds. */
export function toCongressDateTime(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

/**
 * Current Congress number from the year. The 119th runs 2025-2026; each
 * Congress spans two years and starts in an odd year.
 */
export function currentCongress(now: Date = new Date()): number {
  const year = now.getUTCFullYear();
  const startYear = year % 2 === 0 ? year - 1 : year;
  return Math.floor((startYear - 1789) / 2) + 1;
}
