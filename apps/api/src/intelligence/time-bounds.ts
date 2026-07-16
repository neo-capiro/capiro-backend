/**
 * Day-bound helpers for IANA-timezone-aware queries.
 *
 * Postgres `@db.Date` columns return Prisma values at UTC midnight regardless of
 * the original timezone. Filtering them with "ET-midnight as a UTC instant"
 * (04:00–05:00 UTC) excludes rows on the boundary day. Use `dateBoundsInZone`
 * for those columns and `dayBoundsInZone` for true timestamp columns
 * (`@db.Timestamp` / `@db.Timestamptz`).
 */

/**
 * Returns the UTC instants for the start and end of `now`'s calendar day as it
 * appears in the given IANA timezone. Use for filtering Timestamp/Timestamptz
 * columns (e.g. `intelligence_change.detected_at`).
 */
export function dayBoundsInZone(now: Date, timeZone: string): { start: Date; end: Date } {
  const ymd = formatYMD(now, timeZone);
  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(now);
  const offsetRaw = offsetParts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  const offsetMatch = offsetRaw.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const offset = offsetMatch
    ? `${offsetMatch[1]}${offsetMatch[2]}:${offsetMatch[3] ?? '00'}`
    : '-05:00';
  return {
    start: new Date(`${ymd}T00:00:00${offset}`),
    end: new Date(`${ymd}T23:59:59.999${offset}`),
  };
}

/**
 * Returns UTC-midnight Date bounds for the calendar day as it appears in the
 * given IANA timezone. Use for filtering `@db.Date` columns whose values come
 * back at UTC midnight regardless of intended timezone, without this, the
 * row is excluded by ET-midnight-UTC bounds (which sit 4-5h after UTC midnight).
 */
export function dateBoundsInZone(now: Date, timeZone: string): { start: Date; end: Date } {
  const ymd = formatYMD(now, timeZone);
  return {
    start: new Date(`${ymd}T00:00:00.000Z`),
    end: new Date(`${ymd}T23:59:59.999Z`),
  };
}

/** Returns UTC-midnight Date N days from `base`'s zone day. Use for `@db.Date` queries. */
export function addDateInZone(base: Date, days: number, timeZone: string): Date {
  const { start } = dateBoundsInZone(base, timeZone);
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The `YYYY-MM-DD` calendar date of `now` as it appears in the given IANA
 * timezone (GAI-09). Exported so daily-brief labels/comparisons stay on the
 * SAME zone as the ET-anchored filters — a server-local `toDateString()` on a
 * UTC Fargate host disagrees with the ET filters after ~20:00 ET.
 *
 * For a `@db.Date` value (UTC midnight), pass timeZone:'UTC' to read back the
 * intended calendar date without shifting it a day earlier.
 */
export function ymdInZone(now: Date, timeZone: string): string {
  return formatYMD(now, timeZone);
}

function formatYMD(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
