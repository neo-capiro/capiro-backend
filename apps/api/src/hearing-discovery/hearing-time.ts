/**
 * Source-timezone-aware derivation for the `committee_hearing` corpus.
 *
 * WHY THIS FILE EXISTS
 * Congress conducts most chamber business on Eastern time, and Congress.gov's
 * `date` field is a TRUE UTC INSTANT — `2026-07-29T12:30:00Z` is the 8:30 AM ET
 * Fauci hearing. `sync-hearings.ts` used to read `getUTCHours()` under the
 * documented premise "Congress.gov encodes hearing times as UTC wall-clock for
 * the chamber". That premise is FALSE, and it put every hearing time in the
 * product 4 hours late (5 in winter). Verified 2026-07-29 against senate.gov's
 * own hearings.xml: all five of that day's hearings rendered at exactly +4h.
 *
 * The same instant also fed the `@db.Date` column, so the bug compounded — an
 * 8:00 PM ET hearing is 00:00Z the NEXT day, which filed it under tomorrow AND
 * stripped its time, because 00:00Z is Congress.gov's "date known, time unknown"
 * sentinel.
 *
 * FIELD HEARINGS (2026-09-04 defect class, cm-119-119533): a central calendar
 * can also publish a field hearing's LOCAL wall clock (e.g. "1:00 PM" for a
 * Santa Clarita, CA hearing) encoded as an Eastern instant — 17:00Z — when the
 * official committee announcement says 1:00 PM PT (20:00Z). A UTC instant is
 * always authoritative once we have the correct one; the failure mode is an
 * AMBIGUOUS central-calendar instant vs an EXPLICIT official local time + zone.
 * Authority rule (QA brief §4): an official first-party announcement stating an
 * explicit local time AND zone outranks an ambiguous central-calendar instant.
 * Location text may corroborate a zone but never infers one on its own.
 *
 * Everything here is PURE and converts through IANA zones, so DST is ICU's
 * problem rather than a hardcoded offset's. The helpers live outside
 * `sync-hearings.ts` so they can be unit-tested without importing PrismaClient.
 */

/** IANA zone for all congressional business (the corpus default). */
export const ET_ZONE = 'America/New_York';

const ET_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export interface EtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Wall-clock parts of an instant in Eastern time (DST-correct). */
export function etParts(d: Date): EtParts {
  return zoneParts(d, ET_ZONE);
}

/**
 * Congress.gov emits a bare UTC midnight (`T00:00:00Z`) as its "the date is
 * known, the time is not" sentinel.
 *
 * This MUST be tested on the raw UTC instant, BEFORE any zone conversion. In
 * Eastern, 00:00Z reads as 8:00 PM (EDT) the PREVIOUS day, so converting first
 * would invent a precise-looking wrong time AND file the row under the wrong
 * calendar date.
 */
export function isDateOnlySentinel(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
}

/** Time-of-day as "2:15 PM" in Eastern time; null for a date-only record. */
export function formatTime(iso: string | null | undefined): string | null {
  const d = safeDate(iso);
  if (!d || isDateOnlySentinel(d)) return null;
  return clockLabelOf(d, ET_ZONE);
}

/** `new Date(v)` that yields null instead of an Invalid Date. */
export function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * The Eastern calendar day of an instant, as a UTC-midnight `Date` (which is how
 * Prisma serialises into a `@db.Date` column).
 *
 * Unconditional — no sentinel handling. Use this for "now" and for any value that
 * is genuinely an instant. Passing "now" through `hearingCalendarDate` instead
 * would, for the one minute a day when it is exactly 00:00Z, return the PREVIOUS
 * Eastern day.
 */
export function etCalendarDay(d: Date): Date {
  return zoneCalendarDay(d, ET_ZONE);
}

/**
 * The calendar day to file a Congress.gov-sourced hearing under.
 *
 * The Eastern date for a real instant; the UTC date verbatim for a date-only
 * record, where the UTC date IS the intended day and converting would shift it a
 * day earlier.
 */
export function hearingCalendarDate(d: Date): Date {
  if (isDateOnlySentinel(d)) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  return etCalendarDay(d);
}

/** Eastern UTC-offset in ms at an instant (-4h in EDT, -5h in EST). */
function etOffsetMs(at: Date): number {
  const p = etParts(at);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // etParts has minute resolution, so compare against a minute-floored instant.
  return asIfUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/**
 * Instant for an Eastern wall-clock reading — the inverse of `etParts`.
 *
 * Two passes: take the offset at the naive guess, then re-read it at the
 * corrected instant so a DST transition on the target day settles. The remaining
 * edge is the nonexistent 2-3 AM hour on spring-forward day (and the doubled hour
 * in the fall), which no committee has ever scheduled into.
 */
export function etWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return zoneWallClockToInstant(year, month, day, hour, minute, ET_ZONE);
}

/** Parse a scraped "10:00 AM" / "2:15 PM" clock into 24h parts; null if unparseable. */
export function parseEtClock(
  raw: string | null | undefined,
): { hour: number; minute: number } | null {
  const m = (raw ?? '').trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/);
  if (!m) return null;
  // Destructured rather than indexed: `noUncheckedIndexedAccess` types m[n] as
  // `string | undefined`, and the guard below is what makes that safe.
  const [, hh, mm, meridiem] = m;
  if (hh === undefined || mm === undefined || meridiem === undefined) return null;
  const rawHour = Number(hh);
  const minute = Number(mm);
  if (rawHour < 1 || rawHour > 12 || minute > 59) return null;
  let hour = rawHour % 12;
  if (/[Pp]/.test(meridiem)) hour += 12;
  return { hour, minute };
}

/**
 * `startsAt` for a docs.house.gov row. That source's time is ALREADY an Eastern
 * wall-clock string scraped off the page (unlike Congress.gov's UTC instant), so
 * it is converted forward rather than re-derived. Null when the page listed no
 * parseable time — never a fabricated midnight.
 */
export function houseStartsAt(day: Date, time: string | null): Date | null {
  const clock = parseEtClock(time);
  if (!clock) return null;
  return etWallClockToInstant(
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    clock.hour,
    clock.minute,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Zone-aware layer (2026-09-04 field-hearing correction, QA brief §2/§3).
// Every pre-existing export above keeps its exact signature and behavior; the
// functions below generalize the same math to any IANA zone.
// ─────────────────────────────────────────────────────────────────────────────

/** IANA zone aliases a first-party announcement may print. */
const ZONE_ALIASES: Record<string, string> = {
  ET: ET_ZONE,
  EDT: ET_ZONE,
  EST: ET_ZONE,
  CT: 'America/Chicago',
  CDT: 'America/Chicago',
  CST: 'America/Chicago',
  MT: 'America/Denver',
  MDT: 'America/Denver',
  PT: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  AKT: 'America/Anchorage',
  AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  HAST: 'Pacific/Honolulu',
};

const ZONE_WORDS: Array<{ re: RegExp; zone: string }> = [
  { re: /\beastern\b/i, zone: ET_ZONE },
  { re: /\bcentral\b/i, zone: 'America/Chicago' },
  { re: /\bm(ean)?[ -]?time\b|\bm(ean)?[ -]?time\b|\bmountain\b/i, zone: 'America/Denver' },
  { re: /\bpacific\b/i, zone: 'America/Los_Angeles' },
  { re: /\balaska\b/i, zone: 'America/Anchorage' },
  { re: /\bhawaii|\bhawai/i, zone: 'Pacific/Honolulu' },
];

const zoneFmtCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let fmt = zoneFmtCache.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    zoneFmtCache.set(zone, fmt);
  }
  return fmt;
}

/** True when ICU recognizes the zone. */
export function isValidIanaZone(zone: string | null | undefined): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a source-published zone token to an IANA zone. Accepts IANA names
 * verbatim ("America/Los_Angeles"), abbreviations ("PT", "PDT", "ET"), and
 * spelled-out words ("Pacific Time"). Returns the product default (Eastern)
 * for anything unrecognized — never guesses from a location string here.
 */
export function normalizeSourceZone(
  raw: string | null | undefined,
  text?: string | null,
): string {
  const token = (raw ?? '').trim();
  if (token) {
    if (ZONE_ALIASES[token.toUpperCase()]) return ZONE_ALIASES[token.toUpperCase()]!;
    if (isValidIanaZone(token)) return token;
  }
  for (const { re, zone } of ZONE_WORDS) {
    if (text && re.test(text)) return zone;
  }
  return ET_ZONE;
}

/** Wall-clock parts of an instant in ANY IANA zone. */
export function zoneParts(d: Date, zone: string): EtParts {
  const p: Record<string, string> = {};
  for (const { type, value } of zoneFormatter(zone).formatToParts(d)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // `hour12: false` renders midnight as "24" under some ICU versions.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
}

/** "1:00 PM" style clock label of an instant in the given zone. */
export function clockLabelOf(d: Date, zone: string): string {
  const { hour, minute } = zoneParts(d, zone);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${ampm}`;
}

/** The calendar day of an instant in the given zone, as a `@db.Date` UTC-midnight. */
export function zoneCalendarDay(d: Date, zone: string): Date {
  const p = zoneParts(d, zone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

/**
 * Instant for a wall-clock reading in the given zone — the zone-general inverse
 * of `zoneParts` (two-pass DST settle, same as `etWallClockToInstant`).
 */
export function zoneWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): Date {
  const probe = zoneFormatter(zone);
  const partsAt = (at: number): EtParts => {
    const p: Record<string, string> = {};
    for (const { type, value } of probe.formatToParts(new Date(at))) p[type] = value;
    return {
      year: Number(p.year),
      month: Number(p.month),
      day: Number(p.day),
      hour: Number(p.hour) % 24,
      minute: Number(p.minute),
    };
  };
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (at: number): number => {
    const p = partsAt(at);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at / 60_000) * 60_000;
  };
  let ts = naive - offsetAt(naive);
  ts = naive - offsetAt(ts);
  return new Date(ts);
}

/**
 * Wall-clock → instant for a source-published local time. Accepts "1:00 PM"
 * plus a zone token/word as printed on the official page. Null when the clock
 * is unparseable — never a fabricated time.
 */
export function localWallClockToInstant(
  day: Date,
  clock: string | null | undefined,
  zone: string,
): Date | null {
  const parsed = parseEtClock(clock);
  if (!parsed) return null;
  return zoneWallClockToInstant(
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    parsed.hour,
    parsed.minute,
    zone,
  );
}

/**
 * Inputs one official source publishes about WHEN an event happens, before any
 * trust decision. `instant` may be a correctly-zoned UTC instant OR an
 * ambiguous central-calendar instant whose zoning is unknown; `displayClock`
 * is the wall-clock string the source printed, `zoneToken`/`text` the zone
 * evidence it published.
 */
export interface SourceTimeInput {
  /** Parsed source instant, or null for date-only. */
  instant: Date | null;
  /** The source's own calendar day (`@db.Date` UTC-midnight), verbatim. */
  calendarDay: Date;
  /** Wall-clock string the source printed, e.g. "1:00 PM". */
  displayClock?: string | null;
  /** Zone token the source printed ("PT", "PDT", "America/Los_Angeles"). */
  zoneToken?: string | null;
  /** Surrounding official text, for spelled-out zone words ("1:00 PM Pacific"). */
  zoneText?: string | null;
}

/** The resolved, single-shape result every writer consumes. */
export interface ResolvedSourceTime {
  /** True UTC instant when the time is known; null for date-only. */
  startsAt: Date | null;
  /** `@db.Date` calendar day to file the event under. */
  calendarDate: Date;
  /** Official wall-clock display string, e.g. "1:00 PM". */
  displayTime: string | null;
  /** IANA zone the official time is stated in. */
  timeZone: string;
  /**
   * How the instant was derived. `explicit_local` beats `instant` for the
   * canonical row (authority rule above); `instant` means the UTC instant was
   * used as-is (Eastern assumption unchanged for normal Washington hearings).
   */
  authority: 'explicit_local' | 'instant' | 'date_only';
}

/**
 * Resolve one source's WHEN into the shared shape.
 *
 * Rules:
 *  1. An instant that is Congress.gov's date-only sentinel → startsAt=null, the
 *     UTC day verbatim, no fabricated time (unchanged 2026-07-29 behavior).
 *  2. An explicit official local clock + explicit zone → the instant is
 *     DERIVED from that wall clock on the source's calendar day
 *     (authority: explicit_local), with or without a competing instant. This is
 *     what corrects a mis-zoned central-calendar instant: the official page's
 *     own "1:00 PM PT" outranks the calendar's ambiguous 17:00Z encoding.
 *  3. Otherwise a real instant is used as-is and its wall clock is rendered in
 *     the resolved zone (Eastern by default — unchanged behavior for normal
 *     hearings).
 */
export function resolveSourceTime(input: SourceTimeInput): ResolvedSourceTime {
  const { instant, calendarDay } = input;
  const zone = normalizeSourceZone(input.zoneToken, input.zoneText);

  if (instant && isDateOnlySentinel(instant)) {
    return {
      startsAt: null,
      calendarDate: new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate())),
      displayTime: null,
      timeZone: zone,
      authority: 'date_only',
    };
  }

  const explicitClock = input.displayClock?.trim() ? parseEtClock(input.displayClock) : null;
  const zoneIsExplicit =
    (input.zoneToken != null && input.zoneToken.trim().length > 0) ||
    (input.zoneText != null && ZONE_WORDS.some(({ re }) => re.test(input.zoneText ?? '')));
  if (explicitClock && zoneIsExplicit) {
    const derived = zoneWallClockToInstant(
      calendarDay.getUTCFullYear(),
      calendarDay.getUTCMonth() + 1,
      calendarDay.getUTCDate(),
      explicitClock.hour,
      explicitClock.minute,
      zone,
    );
    return {
      startsAt: derived,
      calendarDate: zoneCalendarDay(derived, zone),
      displayTime: clockLabelOf(derived, zone),
      timeZone: zone,
      authority: 'explicit_local',
    };
  }

  if (instant) {
    return {
      startsAt: instant,
      calendarDate: zoneCalendarDay(instant, zone),
      displayTime: clockLabelOf(instant, zone),
      timeZone: zone,
      authority: 'instant',
    };
  }

  // No instant at all: the source's own day verbatim; a clock string is only
  // display, never converted.
  return {
    startsAt: null,
    calendarDate: calendarDay,
    displayTime: input.displayClock?.trim() || null,
    timeZone: zone,
    authority: 'date_only',
  };
}
