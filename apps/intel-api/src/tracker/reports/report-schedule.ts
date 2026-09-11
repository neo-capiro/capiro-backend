import { BadRequestException } from '@nestjs/common';
import { dateOnly } from './report-domain.js';

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let f = formatters.get(timezone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      throw new BadRequestException('IANA_TIMEZONE_REQUIRED');
    }
    formatters.set(timezone, f);
  }
  return f;
}
export function localTime(at: Date, timezone: string) {
  const p = Object.fromEntries(
    formatter(timezone)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
export function validateSchedule(timezone: unknown, minutes: unknown) {
  if (typeof timezone !== 'string' || (!timezone.includes('/') && timezone !== 'UTC'))
    throw new BadRequestException('IANA_TIMEZONE_REQUIRED');
  formatter(timezone);
  if (!Number.isInteger(minutes) || Number(minutes) < 0 || Number(minutes) > 1439)
    throw new BadRequestException('LOCAL_TIME_REQUIRED');
  return { timezone, localMinutes: Number(minutes) };
}
/** Earliest UTC occurrence. Missing local minutes move to the next valid time;
 * repeated minutes execute once. No timezone-less input is parsed as an instant.
 */
export function localOccurrence(day: string, minutes: number, timezone: string): Date {
  dateOnly(day);
  validateSchedule(timezone, minutes);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  let next: { time: number; minutes: number } | undefined;
  for (let t = midnight - 14 * 3600000; t <= midnight + 38 * 3600000; t += 60000) {
    const p = localTime(new Date(t), timezone);
    if (p.date !== day || p.minutes < minutes) continue;
    if (!next || p.minutes < next.minutes) next = { time: t, minutes: p.minutes };
    if (p.minutes === minutes) return new Date(t);
  }
  if (!next) throw new BadRequestException('LOCAL_BUSINESS_DATE_UNAVAILABLE');
  return new Date(next.time);
}
export function nextOccurrence(after: Date, timezone: string, minutes: number) {
  let day = localTime(after, timezone).date;
  for (let i = 0; i < 3; i++) {
    const due = localOccurrence(day, minutes, timezone);
    if (due > after) return due;
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    day = d.toISOString().slice(0, 10);
  }
  throw new BadRequestException('NEXT_LOCAL_OCCURRENCE_UNAVAILABLE');
}
