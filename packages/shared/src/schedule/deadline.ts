import { endOfDayInZone, ymdInZone } from './time-zone';

const DAY_MS = 86_400_000;
export const FEDERAL_DEADLINE_TIME_ZONE = 'America/New_York';

export interface NormalizedDeadline {
  at: string | null;
  dateOnly: string | null;
  timeZone: string | null;
  basis: 'explicit_datetime' | 'date_only_end_of_day' | 'unknown';
}

export function normalizeDeadline(input: {
  value: string | Date | null;
  kind: 'date' | 'datetime';
  timeZone?: string;
  source: string;
}): NormalizedDeadline {
  if (input.value == null) return unknownDeadline();
  if (input.kind === 'date') {
    const dateOnly =
      input.value instanceof Date
        ? ymdInZone(input.value, 'UTC')
        : /^\d{4}-\d{2}-\d{2}/.test(input.value)
          ? input.value.slice(0, 10)
          : null;
    if (dateOnly == null) return unknownDeadline();
    const timeZone = input.timeZone ?? FEDERAL_DEADLINE_TIME_ZONE;
    try {
      return {
        at: endOfDayInZone(dateOnly, timeZone).toISOString(),
        dateOnly,
        timeZone,
        basis: 'date_only_end_of_day',
      };
    } catch {
      return unknownDeadline();
    }
  }

  const parsed = input.value instanceof Date ? input.value : new Date(input.value);
  if (Number.isNaN(parsed.getTime())) return unknownDeadline();
  const timeZone = input.timeZone ?? null;
  return {
    at: parsed.toISOString(),
    dateOnly: timeZone ? ymdInZone(parsed, timeZone) : parsed.toISOString().slice(0, 10),
    timeZone,
    basis: 'explicit_datetime',
  };
}

export function daysUntil(asOfIso: string, deadline: NormalizedDeadline): number | null {
  if (deadline.at == null) return null;
  const asOf = new Date(asOfIso);
  const at = new Date(deadline.at);
  if (Number.isNaN(asOf.getTime()) || Number.isNaN(at.getTime())) return null;
  return Math.ceil((at.getTime() - asOf.getTime()) / DAY_MS);
}

export function deadlineStatus(
  asOfIso: string,
  deadline: NormalizedDeadline,
): 'open' | 'closed' | 'unknown' {
  if (deadline.at == null) return 'unknown';
  const asOf = new Date(asOfIso).getTime();
  const at = new Date(deadline.at).getTime();
  if (Number.isNaN(asOf) || Number.isNaN(at)) return 'unknown';
  return asOf <= at ? 'open' : 'closed';
}

function unknownDeadline(): NormalizedDeadline {
  return { at: null, dateOnly: null, timeZone: null, basis: 'unknown' };
}
