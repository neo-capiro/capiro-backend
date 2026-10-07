import { nextPlannerDate, plannerCalendarDate, type PlannerTaskData } from './planner.js';

export function plannerTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
export function plannerTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
export function plannerDateInZone(instant: Date, timeZone: string): string {
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
export function plannerScheduledInstant(date: string, time: string, timeZone: string): Date {
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
export function plannerTaskOverdue(
  task: Pick<PlannerTaskData, 'dueOn' | 'dueTime' | 'timeZone' | 'status'>,
  now = new Date(),
): boolean {
  if (!task.dueOn || task.status === 'done') return false;
  const zone = task.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return task.dueTime
    ? plannerScheduledInstant(task.dueOn, task.dueTime, zone).getTime() < now.getTime()
    : task.dueOn < plannerDateInZone(now, zone);
}
export function plannerDueTimestamp(
  task: Pick<PlannerTaskData, 'dueOn' | 'dueTime' | 'timeZone'>,
): number {
  if (!task.dueOn) return Number.POSITIVE_INFINITY;
  const zone = task.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    plannerScheduledInstant(task.dueOn, task.dueTime ?? '23:59', zone).getTime() +
    (task.dueTime ? 0 : 59_999)
  );
}
export function shiftPlannerCalendarDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A repeat creates one successor when completed. Calendar repeats preserve their anchor. */
export function nextPlannerSchedule(
  task: PlannerTaskData,
  completedAt: Date,
): {
  dueOn: string;
  startOn: string | null;
  recurrence: NonNullable<PlannerTaskData['recurrence']>;
} | null {
  if (!task.dueOn || !task.recurrence) return null;
  const recurrence = task.recurrence;
  const fromCompletion =
    recurrence.frequency === 'periodically' || recurrence.basedOn === 'completion_date';
  const base = fromCompletion ? plannerDateInZone(completedAt, task.timeZone ?? 'UTC') : task.dueOn;
  const anchor = fromCompletion ? base : (recurrence.anchorOn ?? task.dueOn);
  let dueOn: string;
  if (recurrence.frequency === 'weekly' && recurrence.weekdays?.length) {
    const startOfWeek = (date: string) => {
      const value = new Date(`${date}T12:00:00Z`);
      return value.getTime() - value.getUTCDay() * 86_400_000;
    };
    const anchorWeek = startOfWeek(anchor);
    dueOn = base;
    for (let days = 1; days <= recurrence.interval * 7 + 7; days++) {
      const candidate = shiftPlannerCalendarDate(base, days);
      const weekday = new Date(`${candidate}T12:00:00Z`).getUTCDay();
      const week = Math.round((startOfWeek(candidate) - anchorWeek) / 604_800_000);
      if (recurrence.weekdays.includes(weekday) && week % recurrence.interval === 0) {
        dueOn = candidate;
        break;
      }
    }
  } else if (recurrence.frequency === 'monthly' || recurrence.frequency === 'yearly') {
    const monthInterval = recurrence.interval * (recurrence.frequency === 'yearly' ? 12 : 1);
    const advanced = nextPlannerDate(base, 'monthly', monthInterval);
    const date = new Date(`${advanced}T12:00:00Z`);
    const anchorDate = new Date(`${anchor}T12:00:00Z`).getUTCDate();
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(anchorDate, last));
    dueOn = date.toISOString().slice(0, 10);
  } else {
    dueOn = nextPlannerDate(
      base,
      recurrence.frequency === 'weekly' ? 'weekly' : 'daily',
      recurrence.interval,
    );
  }
  if (
    !plannerCalendarDate(dueOn) ||
    dueOn <= base ||
    (recurrence.endsOn && dueOn > recurrence.endsOn)
  )
    return null;
  const duration = task.startOn
    ? Math.round(
        (new Date(`${task.dueOn}T12:00:00Z`).getTime() -
          new Date(`${task.startOn}T12:00:00Z`).getTime()) /
          86_400_000,
      )
    : 0;
  return {
    dueOn,
    startOn: task.startOn ? shiftPlannerCalendarDate(dueOn, -duration) : null,
    recurrence: { ...recurrence, anchorOn: recurrence.anchorOn ?? task.dueOn },
  };
}
