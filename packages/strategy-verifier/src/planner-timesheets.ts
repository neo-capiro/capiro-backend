import type { PlannerEvent } from './planner.js';

export interface PlannerTimeDetails {
  workedOn: string;
  timeZone: string;
  billable: boolean;
  projectId: string | null;
  category: string;
}
export type PlannerTimesheetStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type PlannerTimesheetAction =
  'submit' | 'recall_submission' | 'approve' | 'reject' | 'recall_approval';
export interface PlannerTimesheetData {
  weekOn: string;
  reviewerId: string | null;
  status: PlannerTimesheetStatus;
  notes: string;
  correctedAfterApproval: boolean;
}
export interface PlannerTimeEntry extends PlannerEvent {
  time: PlannerTimeDetails;
  taskName: string | null;
  projectName: string | null;
  canEdit: boolean;
}
export interface PlannerTimesheet {
  id: string | null;
  userId: string;
  weekOn: string;
  throughOn: string;
  reviewerId: string | null;
  status: PlannerTimesheetStatus;
  version: number;
  revision: string;
  notes: string;
  correctedAfterApproval: boolean;
  totalMinutes: number;
  billableMinutes: number;
  days: { date: string; totalMinutes: number; billableMinutes: number }[];
  matched: number;
  unavailableEntries: boolean;
  items: PlannerTimeEntry[];
  nextCursor: string | null;
  actions: PlannerTimesheetAction[];
  history: PlannerEvent[];
}
export interface PlannerTimeSettings {
  version: number;
  canManage: boolean;
  reviewers: Record<string, string>;
}
/** Calendar arithmetic deliberately stays independent of the viewer's zone. */
export function plannerWeekOn(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export function plannerWeekDate(weekOn: string, days: number): string {
  const d = new Date(`${weekOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
