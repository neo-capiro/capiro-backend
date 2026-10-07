import {
  PLANNER_DEFAULT_CAPACITY_PLAN,
  PLANNER_DEFAULT_CAPACITY_VIEW,
  plannerCalendarDate,
  plannerCapacityWorkdays,
  type PlannerCapacityPlanData,
  type PlannerCapacityAllocationData,
  type PlannerStaffTeamData,
  type PlannerStaffPlaceholderData,
} from '@capiro/strategy-verifier';
import { fail, object, keys, uuid } from './planner.validation.js';
export const CAPACITY_KINDS = [
  'capacity_plan',
  'capacity_team',
  'capacity_placeholder',
  'capacity_allocation',
] as const;
export type CapacityKind = (typeof CAPACITY_KINDS)[number];
function text(value: unknown, max: number, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    fail('Invalid staffing text');
  return value as string;
}
function list(value: unknown, ids = true) {
  if (!Array.isArray(value) || value.length > 1000 || new Set(value).size !== value.length)
    fail('Choose distinct staffing references');
  for (const v of value) ids ? uuid(v) : text(v, 200, true);
  return value as string[];
}
function sharing(data: Record<string, unknown>) {
  if (!['private', 'team'].includes(String(data.privacy))) fail('Invalid staffing privacy');
  if (!Array.isArray(data.members) || data.members.length > 1000) fail('Invalid staffing members');
  const seen = new Set<string>();
  for (const raw of data.members) {
    const m = object(raw);
    keys(m, ['userId', 'role']);
    const id = text(m.userId, 200, true);
    if (seen.has(id) || !['admin', 'viewer'].includes(String(m.role)))
      fail('Use distinct staffing admins or viewers');
    seen.add(id);
  }
}
export function capacityRecordData(kind: CapacityKind, raw: unknown) {
  const data = object(raw);
  if (kind === 'capacity_plan') {
    keys(data, Object.keys(PLANNER_DEFAULT_CAPACITY_PLAN));
    sharing(data);
    text(data.description, 50000);
    for (const key of ['projectIds', 'portfolioIds', 'teamIds']) list(data[key]);
    list(data.peopleIds, false);
    if (!Array.isArray(data.views) || data.views.length > 30)
      fail('Choose at most 30 capacity views');
    const seen = new Set<string>();
    for (const raw of data.views) {
      const v = object(raw);
      keys(v, Object.keys(PLANNER_DEFAULT_CAPACITY_VIEW));
      const id = uuid(v.id);
      if (seen.has(id)) fail('Duplicate capacity view');
      seen.add(id);
      text(v.name, 200, true);
      text(v.search, 200);
      text(v.personId, 200);
      if (v.projectId) uuid(v.projectId);
      if (v.startOn && !plannerCalendarDate(v.startOn)) fail('Invalid view start date');
      for (const [key, values] of Object.entries({
        tab: ['people', 'projects'],
        zoom: ['day', 'week', 'month'],
        unit: ['hours', 'percent', 'count'],
        group: ['none', 'team', 'jobTitle', 'health'],
      }))
        if (!values.includes(String(v[key]))) fail('Invalid capacity view');
    }
    return data as unknown as PlannerCapacityPlanData;
  }
  if (kind === 'capacity_team') {
    keys(data, ['privacy', 'members', 'peopleIds', 'jobTitles']);
    sharing(data);
    list(data.peopleIds, false);
    const titles = object(data.jobTitles);
    if (Object.keys(titles).some((id) => !(data.peopleIds as string[]).includes(id)))
      fail('Job titles require a team member');
    for (const value of Object.values(titles)) text(value, 200);
    return data as unknown as PlannerStaffTeamData;
  }
  if (kind === 'capacity_placeholder') {
    keys(data, ['teamId', 'jobTitle', 'weeklyMinutes']);
    uuid(data.teamId);
    text(data.jobTitle, 200);
    if (
      !Number.isInteger(data.weeklyMinutes) ||
      Number(data.weeklyMinutes) < 0 ||
      Number(data.weeklyMinutes) > 10080
    )
      fail('Weekly capacity must be between 0 and 168 hours');
    return data as unknown as PlannerStaffPlaceholderData;
  }
  return capacityAllocationData(data);
}
export function capacityAllocationData(raw: unknown): PlannerCapacityAllocationData {
  const data = object(raw);
  keys(data, ['userId', 'placeholderId', 'startOn', 'endOn', 'effort']);
  if ((data.userId === null) === (data.placeholderId === null))
    fail('Choose one person or placeholder');
  if (data.userId !== null) text(data.userId, 200, true);
  if (data.placeholderId !== null) uuid(data.placeholderId);
  if (
    !plannerCalendarDate(data.startOn) ||
    !plannerCalendarDate(data.endOn) ||
    String(data.startOn) > String(data.endOn)
  )
    fail('Invalid allocation date range');
  let days: string[];
  try {
    days = plannerCapacityWorkdays(String(data.startOn), String(data.endOn));
  } catch {
    fail('Use an allocation of at most ten years');
  }
  if (!days!.length) fail('An allocation needs at least one working day');
  const effort = object(data.effort);
  keys(effort, ['unit', 'value']);
  if (
    !['hours', 'percent'].includes(String(effort.unit)) ||
    typeof effort.value !== 'number' ||
    !Number.isFinite(effort.value) ||
    effort.value <= 0 ||
    effort.value > (effort.unit === 'percent' ? 1000 : 1000000)
  )
    fail('Choose positive hours or a percentage up to 1000');
  return data as unknown as PlannerCapacityAllocationData;
}
