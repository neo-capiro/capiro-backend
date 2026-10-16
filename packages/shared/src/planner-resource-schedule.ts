/**
 * Planner runtime scheduling subset, matching strategy-verifier/planner-schedule.
 * Shared cannot import strategy-verifier (Core does not depend on that package).
 * Keep the verifier's compatibility implementation covered by equivalence fixtures.
 */
export interface PlannerResourceSchedule {
  dueOn: string | null;
  dueTime?: string | null;
  timeZone?: string | null;
}
export function plannerResourceTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
export function plannerResourceTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
export function plannerResourceCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function plannerResourceDateInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Like native local Date: earlier occurrence in a fold; shift forward across a gap. */
export function plannerResourceScheduledInstant(
  date: string,
  time: string,
  timeZone: string,
): Date {
  const wall = new Date(`${date}T${time}:00Z`).getTime();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const localEpoch = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
  };
  const offsets = new Set(
    [-48, -24, 0, 24, 48].map((hours) => {
      const sample = wall + hours * 3_600_000;
      return localEpoch(sample) - sample;
    }),
  );
  const candidates = [...offsets].map((offset) => wall - offset);
  const exact = candidates.filter((candidate) => localEpoch(candidate) === wall);
  if (exact.length) return new Date(Math.min(...exact));
  const later = candidates
    .filter((candidate) => localEpoch(candidate) > wall)
    .sort((a, b) => localEpoch(a) - localEpoch(b));
  return new Date(later[0] ?? Math.min(...candidates));
}
export function plannerResourceTaskOverdue(
  task: PlannerResourceSchedule & { status: string },
  now = new Date(),
): boolean {
  if (!task.dueOn || task.status === 'done') return false;
  const zone = task.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return task.dueTime
    ? plannerResourceScheduledInstant(task.dueOn, task.dueTime, zone).getTime() < now.getTime()
    : task.dueOn < plannerResourceDateInZone(now, zone);
}
export function plannerResourceDueTimestamp(task: PlannerResourceSchedule): number {
  if (!task.dueOn) return Number.POSITIVE_INFINITY;
  const zone = task.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    plannerResourceScheduledInstant(task.dueOn, task.dueTime ?? '23:59', zone).getTime() +
    (task.dueTime ? 0 : 59_999)
  );
}
