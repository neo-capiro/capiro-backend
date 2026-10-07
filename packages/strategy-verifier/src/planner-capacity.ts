import { plannerCalendarDate } from './planner.js';

export type PlannerCapacityRole = 'admin' | 'viewer';
export interface PlannerCapacitySharing {
  privacy: 'private' | 'team';
  members: { userId: string; role: PlannerCapacityRole }[];
}
export interface PlannerCapacityView {
  id: string;
  name: string;
  tab: 'people' | 'projects';
  zoom: 'day' | 'week' | 'month';
  unit: 'hours' | 'percent' | 'count';
  group: 'none' | 'team' | 'jobTitle' | 'health';
  search: string;
  projectId: string;
  personId: string;
  startOn: string;
}
export interface PlannerCapacityPlanData extends PlannerCapacitySharing {
  description: string;
  projectIds: string[];
  portfolioIds: string[];
  peopleIds: string[];
  teamIds: string[];
  views: PlannerCapacityView[];
}
export interface PlannerStaffTeamData extends PlannerCapacitySharing {
  peopleIds: string[];
  jobTitles: Record<string, string>;
}
export interface PlannerStaffPlaceholderData {
  teamId: string;
  jobTitle: string;
  weeklyMinutes: number;
}
export interface PlannerCapacityAllocationData {
  userId: string | null;
  placeholderId: string | null;
  startOn: string;
  endOn: string;
  effort: { unit: 'hours' | 'percent'; value: number };
}
export interface PlannerCapacityRecord<T> {
  id: string;
  name: string;
  ownerId: string;
  version: number;
  archived: boolean;
  access: PlannerCapacityRole;
  data: T;
}
export type PlannerCapacityPlan = PlannerCapacityRecord<PlannerCapacityPlanData>;
export type PlannerStaffTeam = PlannerCapacityRecord<PlannerStaffTeamData>;
export type PlannerStaffPlaceholder = PlannerCapacityRecord<PlannerStaffPlaceholderData>;
export interface PlannerCapacityAllocation extends PlannerCapacityRecord<PlannerCapacityAllocationData> {
  projectId: string;
  projectName: string;
  personName: string;
  weeklyMinutes: number;
  teamId: string | null;
  jobTitle: string;
}
export interface PlannerCapacityCatalog {
  plans: PlannerCapacityPlan[];
  teams: PlannerStaffTeam[];
  placeholders: PlannerStaffPlaceholder[];
}
export interface PlannerCapacityPage {
  plan: PlannerCapacityPlan;
  projectIds: string[];
  personIds: string[];
  allocations: PlannerCapacityAllocation[];
  matched: number;
  revision: string;
  nextCursor: string | null;
}
export interface PlannerCapacityAllocationChange {
  id: string;
  version?: number;
  duplicateId?: string;
  projectId?: string;
  data?: Partial<PlannerCapacityAllocationData>;
  shiftDays?: number;
  archived?: boolean;
}
export const PLANNER_DEFAULT_CAPACITY_PLAN: PlannerCapacityPlanData = {
  description: '',
  privacy: 'private',
  members: [],
  projectIds: [],
  portfolioIds: [],
  peopleIds: [],
  teamIds: [],
  views: [],
};
export const PLANNER_DEFAULT_CAPACITY_VIEW: PlannerCapacityView = {
  id: '',
  name: '',
  tab: 'people',
  zoom: 'week',
  unit: 'hours',
  group: 'none',
  search: '',
  projectId: '',
  personId: '',
  startOn: '',
};
export function plannerCapacityDateShift(date: string, days: number) {
  if (!plannerCalendarDate(date) || !Number.isInteger(days))
    throw new Error('Invalid capacity date');
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const shifted = d.toISOString().slice(0, 10);
  if (!plannerCalendarDate(shifted))
    throw new Error('Capacity date is outside the supported calendar');
  return shifted;
}
/** UTC is used only to enumerate calendar dates, so daylight saving cannot shift an allocation. */
export function plannerCapacityWorkdays(startOn: string, endOn: string) {
  if (!plannerCalendarDate(startOn) || !plannerCalendarDate(endOn) || startOn > endOn)
    throw new Error('Invalid capacity date range');
  const days: string[] = [];
  for (let date = startOn; date <= endOn; date = plannerCapacityDateShift(date, 1)) {
    if (
      days.length > 2600 ||
      (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${startOn}T12:00:00Z`)) / 86400000 > 3660
    )
      throw new Error('Capacity date range is too long');
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(date);
  }
  return days;
}
/** Hours are a total spread over working days. Percent uses the individual's weekly capacity. */
export function plannerCapacityMinutes(
  allocation: Pick<PlannerCapacityAllocation, 'data' | 'weeklyMinutes'>,
  startOn = allocation.data.startOn,
  endOn = allocation.data.endOn,
) {
  const days = plannerCapacityWorkdays(allocation.data.startOn, allocation.data.endOn);
  const matched = days.filter((date) => date >= startOn && date <= endOn).length;
  if (!days.length) return 0;
  return allocation.data.effort.unit === 'hours'
    ? (allocation.data.effort.value * 60 * matched) / days.length
    : (((allocation.weeklyMinutes / 5) * allocation.data.effort.value) / 100) * matched;
}
export function plannerCapacitySummary(
  allocations: PlannerCapacityAllocation[],
  startOn: string,
  endOn: string,
) {
  const active = allocations.filter(
    (a) => !a.archived && a.data.startOn <= endOn && a.data.endOn >= startOn,
  );
  return {
    minutes: active.reduce((n, a) => n + plannerCapacityMinutes(a, startOn, endOn), 0),
    people: new Set(active.map((a) => a.data.userId ?? a.data.placeholderId)).size,
    projects: new Set(active.map((a) => a.projectId)).size,
    personMonths: active.reduce(
      (n, a) => n + plannerCapacityMinutes(a, startOn, endOn) / ((2400 * 52) / 12),
      0,
    ),
  };
}
