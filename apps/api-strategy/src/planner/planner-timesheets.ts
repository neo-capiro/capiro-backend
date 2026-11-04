import { ForbiddenException } from '@nestjs/common';
import {
  plannerCalendarDate,
  plannerTimeZone,
  type PlannerTimeDetails,
  type PlannerTimesheetData,
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
