/**
 * Hill Day module — time-zone aware date helpers (pure, unit-tested).
 *
 * The calendar week is rendered in the sponsor's (Eastern) time zone
 * regardless of the viewer's browser zone, so the picker, the resolution cards
 * and the generated packet all agree on which day a meeting falls on.
 */

export const DEFAULT_TIME_ZONE = 'America/New_York';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function parts(date: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return out;
}

/** `YYYY-MM-DD` of the instant in the zone. */
export function localDateKey(iso: string | Date, timeZone: string): string {
  const p = parts(typeof iso === 'string' ? new Date(iso) : iso, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Monday (`YYYY-MM-DD`) of the week containing the instant, in the zone. */
export function mondayOf(iso: string | Date, timeZone: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const p = parts(d, timeZone);
  const idx = WEEKDAYS.indexOf(p.weekday as (typeof WEEKDAYS)[number]);
  const local = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  local.setUTCDate(local.getUTCDate() - Math.max(0, idx));
  return local.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` plus n days (calendar arithmetic, zone-free). */
export function addDays(dateKey: string, n: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The UTC instant of local midnight on `dateKey` in `timeZone`. Two-step
 * offset correction handles DST edges without a tz database.
 */
export function zonedMidnightUtc(dateKey: string, timeZone: string): string {
  // We want the instant whose wall clock in `timeZone` reads `dateKey` 00:00.
  // offset(instant) = wall(instant) − instant, so instant = target − offset;
  // two passes converge across a DST boundary.
  const target = Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10)));
  const offsetAt = (instant: Date): number => {
    const p = parts(instant, timeZone);
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    return wall - instant.getTime();
  };
  let instant = new Date(target);
  instant = new Date(target - offsetAt(instant));
  instant = new Date(target - offsetAt(instant));
  return instant.toISOString();
}

/** `8:45 AM` in the zone. */
export function fmtTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** `30 min` / `1 hr 15 min`. */
export function fmtDuration(startIso: string, endIso: string): string {
  const mins = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** `Wednesday, September 16` for a date key. */
export function fmtDayHeading(dateKey: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(
    new Date(`${dateKey}T12:00:00Z`),
  );
}

/** `Sep 14 – 20, 2026` for a Monday key. */
export function fmtWeekRange(mondayKey: string): string {
  const start = new Date(`${mondayKey}T12:00:00Z`);
  const end = new Date(`${addDays(mondayKey, 6)}T12:00:00Z`);
  const month = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' }).format(d);
  const day = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', day: 'numeric' }).format(d);
  const year = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric' }).format(end);
  return month(start) === month(end)
    ? `${month(start)} ${day(start)} – ${day(end)}, ${year}`
    : `${month(start)} ${day(start)} – ${month(end)} ${day(end)}, ${year}`;
}

/** Day-of-month number for a date key (`14`). */
export function dayNumber(dateKey: string): string {
  return String(Number(dateKey.slice(8, 10)));
}
