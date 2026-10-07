import { ForbiddenException } from '@nestjs/common';
import {
  PLANNER_DEFAULT_TIME_OPTIONS,
  plannerTimeDateBounds,
  plannerTimeZone,
  plannerBudgetCurrency,
  type PlannerTimeDetails,
  type PlannerTimeOptions,
} from '@capiro/strategy-verifier';
import { fail, keys, object } from './planner.validation.js';

export function plannerTimeOptions(
  value: unknown,
  previous = PLANNER_DEFAULT_TIME_OPTIONS,
): PlannerTimeOptions {
  const patch = value === undefined ? {} : object(value);
  keys(patch, Object.keys(PLANNER_DEFAULT_TIME_OPTIONS));
  const result = { ...previous, ...patch } as PlannerTimeOptions;
  for (const key of [
    'timeTrackingEnabled',
    'billableEnabled',
    'billableDefault',
    'generalWorkEnabled',
  ] as const)
    if (typeof result[key] !== 'boolean') fail('Invalid time setting');
  if (!['simple', 'full'].includes(result.approvalProcess))
    fail('Invalid timesheet approval process');
  for (const key of ['pastLockWeeks', 'futureWeeks'] as const)
    if (
      result[key] !== null &&
      (!Number.isInteger(result[key]) || result[key]! < 0 || result[key]! > 520)
    )
      fail('Time limits require 0–520 weeks or no limit');
  if (!plannerTimeZone(result.timeZone)) fail('Choose a valid time rules zone');
  if (!plannerBudgetCurrency(result.budgetCurrency ?? 'USD'))
    fail('Choose a supported budget currency');
  if (result.submissionReminder != null) {
    const reminder = object(result.submissionReminder);
    keys(reminder, ['weekday', 'time', 'week']);
    if (
      !Number.isInteger(reminder.weekday) ||
      Number(reminder.weekday) < 1 ||
      Number(reminder.weekday) > 7 ||
      typeof reminder.time !== 'string' ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reminder.time) ||
      !['current', 'previous'].includes(String(reminder.week))
    )
      fail('Choose a reminder weekday, valid time and timesheet week');
  }
  if (
    !Array.isArray(result.categories) ||
    result.categories.length > 100 ||
    result.categories.some((v) => typeof v !== 'string' || !v.trim() || v.trim().length > 100)
  )
    fail('Time categories require at most 100 labels of 1–100 characters');
  const categories = result.categories.map((v) => v.trim());
  if (new Set(categories.map((v) => v.toLowerCase())).size !== categories.length)
    fail('Time category labels must be unique');
  return { ...result, categories };
}
export function plannerTimeDateNotice(
  date: string,
  options: PlannerTimeOptions,
  admin: boolean,
  now = new Date(),
): string | null {
  if (!options.timeTrackingEnabled)
    return 'Time tracking is disabled for this organization. Existing history remains available.';
  const bounds = plannerTimeDateBounds(options, admin, now);
  if (bounds.minOn && date < bounds.minOn)
    return `Time before ${bounds.minOn} is locked in ${options.timeZone}. An organization admin can correct past entries.`;
  if (bounds.maxOn && date > bounds.maxOn)
    return `Time after ${bounds.maxOn} is outside the future logging limit in ${options.timeZone}.`;
  return null;
}
export function requirePlannerTimePolicy(
  time: PlannerTimeDetails,
  options: PlannerTimeOptions,
  admin: boolean,
  previous?: PlannerTimeDetails,
) {
  for (const date of new Set([previous?.workedOn, time.workedOn].filter((v): v is string => !!v))) {
    const notice = plannerTimeDateNotice(date, options, admin);
    if (notice) throw new ForbiddenException(notice);
  }
  if (!options.billableEnabled && time.billable && !previous?.billable)
    throw new ForbiddenException('Marking new billable time is disabled for this organization');
  if (
    time.category &&
    time.category !== previous?.category &&
    options.categories.length &&
    !options.categories.includes(time.category)
  )
    fail('Choose a configured time category');
}
