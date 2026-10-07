import {
  PLANNER_DEFAULT_TIME_REVIEW,
  plannerTimeToday,
  plannerWeekOn,
  plannerWeekDate,
  plannerScheduledInstant,
  type PlannerTimeOptions,
  type PlannerTimeReviewView,
  type PlannerTimesheet,
} from '@capiro/strategy-verifier';
import { fail, keys, object } from './planner.validation.js';

export function plannerTimeReviewView(raw: unknown): PlannerTimeReviewView {
  const patch = raw === undefined ? {} : object(raw);
  keys(patch, Object.keys(PLANNER_DEFAULT_TIME_REVIEW));
  const view = { ...PLANNER_DEFAULT_TIME_REVIEW, ...patch } as PlannerTimeReviewView;
  if (
    !Array.isArray(view.people) ||
    view.people.length > 100 ||
    view.people.some((id) => typeof id !== 'string' || !id || id.length > 200) ||
    new Set(view.people).size !== view.people.length
  )
    fail('Choose at most 100 distinct time submitters');
  if (
    !Array.isArray(view.statuses) ||
    view.statuses.some((s) => !['draft', 'submitted', 'approved', 'rejected'].includes(s)) ||
    new Set(view.statuses).size !== view.statuses.length ||
    !['name', 'total', 'billable'].includes(view.sort) ||
    !['asc', 'desc'].includes(view.direction)
  )
    fail('Choose valid review statuses and ordering');
  return { ...view, people: [...view.people].sort(), statuses: [...view.statuses].sort() };
}
export function plannerTimeReviewRows(
  rows: PlannerTimesheet[],
  view: PlannerTimeReviewView,
  names: Map<string, string>,
) {
  return rows
    .filter(
      (row) =>
        (!view.people.length || view.people.includes(row.userId)) &&
        (!view.statuses.length || view.statuses.includes(row.status)),
    )
    .sort((a, b) => {
      const value =
        view.sort === 'total'
          ? a.totalMinutes - b.totalMinutes
          : view.sort === 'billable'
            ? a.billableMinutes - b.billableMinutes
            : (names.get(a.userId) ?? '').localeCompare(names.get(b.userId) ?? '');
      return value * (view.direction === 'desc' ? -1 : 1) || a.userId.localeCompare(b.userId);
    });
}
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
