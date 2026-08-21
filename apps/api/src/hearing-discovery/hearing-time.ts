/**
 * Eastern-time derivation for the `committee_hearing` corpus.
 *
 * WHY THIS FILE EXISTS
 * Congress conducts all chamber business on Eastern time, and Congress.gov's
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
 * These helpers live outside `sync-hearings.ts` so they can be unit-tested
 * without importing PrismaClient or the sync-run helper (and therefore without a
 * generated Prisma client). Everything here is PURE and converts through the IANA
 * zone, so DST is ICU's problem rather than a hardcoded offset's.
 */

/** IANA zone for all congressional business. */
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
  const p: Record<string, string> = {};
  for (const { type, value } of ET_PARTS_FMT.formatToParts(d)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // `hour12: false` renders midnight as "24" under some ICU versions.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
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
  const { hour, minute } = etParts(d);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${ampm}`;
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
  const { year, month, day } = etParts(d);
  return new Date(Date.UTC(year, month - 1, day));
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
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let ts = naive - etOffsetMs(new Date(naive));
  ts = naive - etOffsetMs(new Date(ts));
  return new Date(ts);
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
