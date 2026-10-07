import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  plannerCalendarDate,
  plannerTimeZone,
  plannerWeekOn,
  type PlannerTimeDetails,
  type PlannerTimesheetData,
  type PlannerTimesheetAction,
} from '@capiro/strategy-verifier';
import { fail, keys, object, uuid } from './planner.validation.js';

export function plannerTimeDetails(
  value: unknown,
  fallback?: PlannerTimeDetails,
): PlannerTimeDetails {
  const d = value === undefined ? {} : object(value);
  keys(d, ['workedOn', 'timeZone', 'billable', 'projectId', 'category']);
  const result = {
    workedOn: new Date().toISOString().slice(0, 10),
    timeZone: 'UTC',
    billable: false,
    projectId: null,
    category: '',
    ...fallback,
    ...d,
  } as PlannerTimeDetails;
  if (!plannerCalendarDate(result.workedOn)) fail('A valid work date is required');
  if (!plannerTimeZone(result.timeZone)) fail('A valid time zone is required');
  if (typeof result.billable !== 'boolean') fail('Invalid billable time');
  if (result.projectId !== null) uuid(result.projectId);
  if (typeof result.category !== 'string' || result.category.length > 100)
    fail('Invalid time category');
  return result;
}
export function plannerTimesheetWeek(value: unknown): string {
  if (!plannerCalendarDate(value)) fail('A valid timesheet week is required');
  return plannerWeekOn(value as string);
}
export function plannerTimesheetActions(
  data: PlannerTimesheetData,
  userId: string,
  viewerId: string,
  process: 'simple' | 'full' = 'full',
): PlannerTimesheetAction[] {
  const owner = userId === viewerId,
    reviewer = data.reviewerId === viewerId;
  if (data.status === 'submitted')
    return [
      ...(owner ? ['recall_submission' as const] : []),
      ...(reviewer && process === 'full' ? ['approve' as const, 'reject' as const] : []),
    ];
  if (data.status === 'approved') return reviewer ? ['recall_approval'] : [];
  return (owner || reviewer) && (data.reviewerId || process === 'simple') ? ['submit'] : [];
}
export function plannerTimeEditable(
  data: PlannerTimesheetData | null,
  userId: string,
  viewerId: string,
  admin: boolean,
): boolean {
  if (viewerId !== userId && data?.reviewerId !== viewerId) return false;
  if (admin) return true;
  if (!data || data.status === 'draft' || data.status === 'rejected') return true;
  return data.status === 'submitted' && data.reviewerId === viewerId;
}
export function requirePlannerTimeEditable(
  data: PlannerTimesheetData | null,
  userId: string,
  viewerId: string,
  admin: boolean,
) {
  if (!plannerTimeEditable(data, userId, viewerId, admin))
    throw new ForbiddenException('This timesheet is locked. Recall it before changing time.');
}
export function requirePlannerTimesheetVersion(version: unknown, actual: number) {
  if (!Number.isInteger(version) || Number(version) < 0)
    fail('An expected timesheet version is required');
  if (version !== actual)
    throw new ConflictException('This timesheet changed. Refresh before saving again.');
}
