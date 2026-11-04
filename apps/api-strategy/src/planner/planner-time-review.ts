import {
  plannerTimeToday,
  plannerWeekOn,
  plannerWeekDate,
  plannerScheduledInstant,
  type PlannerTimeOptions,
} from '@capiro/strategy-verifier';

/** A catch-up delivery is limited to the current organization calendar week. */
export function plannerTimeSubmissionDue(options: PlannerTimeOptions, now = new Date()) {
  const reminder = options.submissionReminder;
  if (!options.timeTrackingEnabled || !reminder) return null;
  const currentWeek = plannerWeekOn(plannerTimeToday(options.timeZone, now));
  const scheduledOn = plannerWeekDate(currentWeek, reminder.weekday - 1);
  const instant = plannerScheduledInstant(scheduledOn, reminder.time, options.timeZone);
  if (now.getTime() < instant.getTime()) return null;
  return {
    weekOn: reminder.week === 'previous' ? plannerWeekDate(currentWeek, -7) : currentWeek,
    scheduledOn,
    deadlineAt: instant.toISOString(),
  };
}
