import {
  plannerScheduledInstant,
  plannerTimeToday,
  shiftPlannerCalendarDate,
  type PlannerTimerDetails,
} from '@capiro/strategy-verifier';
import { fail } from './planner.validation.js';

export interface PlannerTimerData {
  taskId: string;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'stopped' | 'discarded';
  time: PlannerTimerDetails;
  startHash: string;
  stopHash: string | null;
  elapsedMilliseconds: number;
  minutes: number;
  eventIds: string[];
}
/** Round the elapsed total once, then distribute its whole minutes by local calendar day.
 * Largest remainders avoid adding a rounded minute at every midnight boundary. */
export function plannerTimerDays(start: Date, end: Date, zone: string) {
  const elapsed = end.getTime() - start.getTime();
  if (!Number.isSafeInteger(elapsed) || elapsed < 0)
    fail('The timer end must not precede its start');
  const minutes = Math.ceil(elapsed / 60_000);
  if (minutes > 1_000_000) fail('Timer sessions cannot exceed 1,000,000 minutes');
  const days: { workedOn: string; milliseconds: number; minutes: number }[] = [];
  let cursor = start.getTime();
  while (cursor < end.getTime()) {
    const workedOn = plannerTimeToday(zone, new Date(cursor));
    const midnight = plannerScheduledInstant(
      shiftPlannerCalendarDate(workedOn, 1),
      '00:00',
      zone,
    ).getTime();
    const next = Math.min(midnight, end.getTime());
    if (next <= cursor || days.length >= 2000) fail('The timer calendar boundary is invalid');
    const milliseconds = next - cursor;
    days.push({ workedOn, milliseconds, minutes: Math.floor(milliseconds / 60_000) });
    cursor = next;
  }
  const remaining = minutes - days.reduce((n, day) => n + day.minutes, 0);
  const order = days
    .map((day, index) => ({ index, remainder: day.milliseconds % 60_000 }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remaining; i++) days[order[i]!.index]!.minutes++;
  return days.filter((day) => day.minutes > 0);
}
