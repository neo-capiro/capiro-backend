/**
 * Senate central schedule discovery adapter (`senate-schedule`).
 *
 * Source: https://www.senate.gov/general/committee_schedules/hearings.xml — the
 * Senate's own machine-readable committee schedule, and the one that made the
 * 2026-07-29 timezone defect provable. Verified live 2026-08-20; the shape below
 * is transcribed from that response, not assumed:
 *
 *   <css_meetings_scheduled>
 *     <meeting>
 *       <identifier>338724</identifier>
 *       <last_update_iso_8601>2026-08-03T15:34:42.000000Z-04:00</last_update_iso_8601>
 *       <cmte_code>SSAS00</cmte_code>
 *       <committee>Armed Services</committee>
 *       <type>Closed Hearing</type>
 *       <date_iso_8601>2026-09-17</date_iso_8601>
 *       <time_iso_8601>09:30:00</time_iso_8601>
 *       <room>SVC-217</room>
 *       <matter>To receive a closed briefing on ...</matter>
 *       <video_url/>
 *     </meeting>
 *
 * Three things about that payload drive the code:
 *
 *  1. The feed opens with a SENTINEL `<meeting>` whose cmte_code/committee are
 *     empty and whose matter reads "No committee hearings scheduled". Ingesting
 *     it would mint a phantom hearing every run, so rows without a committee
 *     code are dropped.
 *  2. `last_update_iso_8601` is MALFORMED — it carries both `Z` and a numeric
 *     offset (`...Z-04:00`). `new Date()` returns Invalid Date on it, so the `Z`
 *     is stripped before parsing rather than the timestamp being discarded.
 *  3. `type` distinguishes "Closed Hearing" from an open one. A closed briefing
 *     must never be queued for public capture, which is why visibility is read
 *     from this field and not guessed.
 *
 * The feed carries no Congress.gov `eventId`, so a Senate hearing that
 * Congress.gov ALSO published would duplicate if identity stopped at the id
 * rung. It does not: the reconciler's `natural` rung matches on (chamber,
 * system code, Eastern day, Eastern clock), which is what folds the two reports
 * onto one canonical row.
 */
import { etWallClockToInstant } from '../hearing-time.js';
import { inferVisibility, normalizeEventStatus } from '../hearing-identity.js';
import { cleanText, fetchText } from './source-http.js';
import type {
  CommitteeSourceAdapter,
  DiscoveryContext,
  SourceDescriptor,
  SourceEvent,
  SourceHealth,
  Visibility,
} from '../hearing-discovery.types.js';

export const SENATE_SCHEDULE_URL =
  'https://www.senate.gov/general/committee_schedules/hearings.xml';

export interface SenateMeetingRow {
  identifier: string | null;
  lastUpdate: Date | null;
  committeeCode: string | null;
  committeeName: string | null;
  type: string | null;
  dateIso: string | null;
  timeIso: string | null;
  room: string | null;
  matter: string | null;
  videoUrl: string | null;
}

export interface SenateScheduleAdapterOptions {
  congress: number;
  url?: string;
  /** systemCode → display name, from our own congress_committee registry. */
  resolveCommitteeName?: (systemCode: string) => string | null;
}

export class SenateScheduleAdapter implements CommitteeSourceAdapter {
  readonly adapterKey = 'senate-schedule';
  readonly parserVersion = 'senate-schedule/2026-08-20';

  constructor(private readonly options: SenateScheduleAdapterOptions) {}

  async discoverEvents(source: SourceDescriptor, ctx: DiscoveryContext): Promise<SourceEvent[]> {
    const url = this.options.url ?? source.sourceUrl ?? SENATE_SCHEDULE_URL;
    const res = await fetchText(url, { accept: 'application/xml,text/xml' });
    if (!res.ok || res.body == null) {
      throw new Error(`senate schedule fetch failed: ${res.error ?? `HTTP ${res.status}`}`);
    }
    const rows = parseSenateSchedule(res.body);
    const events: SourceEvent[] = [];
    for (const row of rows) {
      const event = this.toSourceEvent(row, ctx);
      if (event) events.push(event);
    }
    return events;
  }

  async healthCheck(source: SourceDescriptor): Promise<SourceHealth> {
    const url = this.options.url ?? source.sourceUrl ?? SENATE_SCHEDULE_URL;
    const res = await fetchText(url, { accept: 'application/xml,text/xml', timeoutMs: 15_000 });
    return {
      ok: res.ok,
      status: res.status,
      durationMs: res.durationMs,
      error: res.error,
      observedEvents: res.body ? parseSenateSchedule(res.body).length : null,
    };
  }

  private toSourceEvent(row: SenateMeetingRow, ctx: DiscoveryContext): SourceEvent | null {
    // Sentinel / placeholder rows carry no committee. Dropping them is what
    // keeps "No committee hearings scheduled" out of the master calendar.
    if (!row.committeeCode || !row.dateIso) return null;
    const code = row.committeeCode.trim().toLowerCase();
    const day = parseIsoDay(row.dateIso);
    if (!day) {
      ctx.log(`[senate-schedule] meeting ${row.identifier ?? '?'} has unparseable date; skipped`);
      return null;
    }
    const clock = parseIsoClock(row.timeIso);
    const startsAt = clock
      ? etWallClockToInstant(
          day.getUTCFullYear(),
          day.getUTCMonth() + 1,
          day.getUTCDate(),
          clock.hour,
          clock.minute,
        )
      : null;

    // Senate subcommittee codes share the parent's first four characters and do
    // not end in '00' (ssas00 = full committee, ssas15 = a subcommittee).
    const isSub = !code.endsWith('00');
    const parentCode = isSub ? `${code.slice(0, 4)}00` : code;

    const visibility: Visibility = /closed|executive/i.test(row.type ?? '')
      ? 'private'
      : inferVisibility(row.matter, row.type);

    return {
      // The feed's own identifier is a real official id, so it anchors the
      // observation's idempotency key even though it is not a Congress.gov one.
      externalEventId: row.identifier ?? `${code}-${row.dateIso}-${row.timeIso ?? 'na'}`,
      congress: this.options.congress,
      chamber: 'senate',
      committeeSystemCode: parentCode,
      subcommitteeSystemCode: isSub ? code : null,
      committeeName:
        this.options.resolveCommitteeName?.(parentCode) ??
        (row.committeeName ? `Senate Committee on ${row.committeeName}` : null),
      title: row.matter,
      eventType: row.type,
      eventStatus: normalizeEventStatus(row.type),
      visibility,
      startsAt,
      calendarDate: day,
      displayTime: clock ? formatClock(clock.hour, clock.minute) : null,
      location: row.room,
      officialPageUrl: SENATE_SCHEDULE_URL,
      witnesses: [],
      agendaBillIds: [],
      sourceUpdatedAt: row.lastUpdate,
      // A populated <video_url> is an advertised page/media candidate; it is
      // recorded unprobed, and Phase 4's resolver decides what it is.
      streamCandidates: row.videoUrl
        ? [
            {
              provider: 'senate-isvp',
              officialPageUrl: row.videoUrl,
              mediaUrl: null,
            },
          ]
        : [],
      raw: { senateType: row.type, room: row.room, identifier: row.identifier },
    };
  }
}

/** `<tag>value</tag>` — first match only, entity-decoded and tag-stripped. */
function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  if (!m || m[1] === undefined) return null;
  const value = cleanText(m[1]);
  return value.length ? value : null;
}

/** Split the feed into `<meeting>` blocks and normalize each. */
export function parseSenateSchedule(xml: string): SenateMeetingRow[] {
  const out: SenateMeetingRow[] = [];
  const blocks = xml.match(/<meeting>[\s\S]*?<\/meeting>/gi) ?? [];
  for (const block of blocks) {
    out.push({
      identifier: tag(block, 'identifier'),
      lastUpdate: parseSenateTimestamp(tag(block, 'last_update_iso_8601')),
      committeeCode: tag(block, 'cmte_code'),
      committeeName: tag(block, 'committee'),
      type: tag(block, 'type'),
      dateIso: tag(block, 'date_iso_8601'),
      timeIso: tag(block, 'time_iso_8601') ?? tag(block, 'time'),
      room: tag(block, 'room'),
      matter: tag(block, 'matter'),
      videoUrl: tag(block, 'video_url'),
    });
  }
  return out;
}

/**
 * The feed emits `2026-08-03T15:34:42.000000Z-04:00` — both a `Z` and an
 * offset, which is not valid ISO 8601 and parses to Invalid Date. The `Z` is
 * dropped when a numeric offset follows it; the timestamp is real and worth
 * keeping, so it is repaired rather than discarded.
 */
export function parseSenateTimestamp(raw: string | null): Date | null {
  if (!raw) return null;
  const repaired = raw.replace(/Z(?=[+-]\d{2}:?\d{2}$)/, '');
  const d = new Date(repaired);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `2026-09-17` → UTC-midnight Date, matching the `@db.Date` convention. */
export function parseIsoDay(raw: string | null): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((raw ?? '').trim());
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `09:30:00` or `09:30 AM` → 24h parts. Null when there is no usable time. */
export function parseIsoClock(raw: string | null): { hour: number; minute: number } | null {
  const s = (raw ?? '').trim();
  const iso = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (iso && iso[1] && iso[2]) {
    const hour = Number(iso[1]);
    const minute = Number(iso[2]);
    if (hour <= 23 && minute <= 59) return { hour, minute };
    return null;
  }
  const ampm = /^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/.exec(s);
  if (ampm && ampm[1] && ampm[2] && ampm[3]) {
    const raw12 = Number(ampm[1]);
    const minute = Number(ampm[2]);
    if (raw12 < 1 || raw12 > 12 || minute > 59) return null;
    let hour = raw12 % 12;
    if (/[Pp]/.test(ampm[3])) hour += 12;
    return { hour, minute };
  }
  return null;
}

function formatClock(hour: number, minute: number): string {
  const meridiem = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${meridiem}`;
}
