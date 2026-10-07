import {
  plannerDueTimestamp,
  plannerScheduledInstant,
  shiftPlannerCalendarDate,
  type PlannerDateRule,
  type PlannerTaskData,
} from '@capiro/strategy-verifier';
import { createHash } from 'node:crypto';

export function plannerScheduleHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Calendar offsets preserve wall-clock time across DST. Date-only work starts
 * approaching at midnight; it becomes overdue after its local due day ends. */
export function plannerDateRuleReady(
  task: PlannerTaskData,
  rule: PlannerDateRule,
  now: Date,
): boolean {
  if (!task.dueOn || task.status === 'done') return false;
  const zone = task.timeZone ?? 'UTC';
  const deadline = plannerDueTimestamp({ ...task, timeZone: zone });
  const direction = rule.trigger === 'due_approaching' ? -1 : 1;
  let threshold: number;
  if (rule.schedule.unit === 'days') {
    const days =
      direction * rule.schedule.amount + (rule.trigger === 'overdue' && !task.dueTime ? 1 : 0);
    threshold = plannerScheduledInstant(
      shiftPlannerCalendarDate(task.dueOn, days),
      task.dueTime ?? '00:00',
      zone,
    ).getTime();
  } else {
    const minutes = rule.schedule.amount * (rule.schedule.unit === 'hours' ? 60 : 1);
    threshold = deadline + direction * minutes * 60_000;
  }
  // A zero-offset timed trigger has no before-deadline window. Treat that
  // instant as a durable due trigger so polling/cursor delays cannot miss it.
  const dueInstant = rule.trigger === 'due_approaching' && threshold === deadline;
  return (
    now.getTime() >= threshold &&
    (rule.trigger === 'overdue' || dueInstant || now.getTime() <= deadline)
  );
}
