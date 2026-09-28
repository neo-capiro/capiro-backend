const DAY_MS = 86_400_000;

function assertValidZone(timeZone: string): void {
  new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
}

function partsAt(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]),
  );
}

function instantForLocal(ymd: string, timeZone: string, endOfDay = false): Date {
  assertValidYmd(ymd);
  assertValidZone(timeZone);
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
  const hour = endOfDay ? 23 : 0;
  const minute = endOfDay ? 59 : 0;
  const second = endOfDay ? 59 : 0;
  const millisecond = endOfDay ? 999 : 0;
  const wanted = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let guess = wanted;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsAt(new Date(guess), timeZone);
    const represented = Date.UTC(
      actual.year!,
      actual.month! - 1,
      actual.day!,
      actual.hour!,
      actual.minute!,
      actual.second!,
      millisecond,
    );
    const adjustment = wanted - represented;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(guess);
}

function assertValidYmd(ymd: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new RangeError(`Invalid calendar date: ${ymd}`);
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
  const roundTrip = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  if (roundTrip !== ymd) throw new RangeError(`Invalid calendar date: ${ymd}`);
}

/** The YYYY-MM-DD calendar date of an instant in an IANA timezone. */
export function ymdInZone(date: Date, timeZone: string): string {
  assertValidZone(timeZone);
  const parts = partsAt(date, timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Adds calendar days without treating a DST transition as a 24-hour interval. */
export function addDaysInZone(ymd: string, days: number, timeZone: string): string {
  assertValidYmd(ymd);
  assertValidZone(timeZone);
  if (!Number.isInteger(days)) throw new RangeError('days must be an integer');
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** UTC instants bounding the named calendar day containing `now`. */
export function dayBoundsInZone(now: Date, timeZone: string): { start: Date; end: Date } {
  const ymd = ymdInZone(now, timeZone);
  return {
    start: instantForLocal(ymd, timeZone),
    end: instantForLocal(ymd, timeZone, true),
  };
}

/** Converts the end of a named calendar date in a zone to an instant. */
export function endOfDayInZone(ymd: string, timeZone: string): Date {
  return instantForLocal(ymd, timeZone, true);
}
