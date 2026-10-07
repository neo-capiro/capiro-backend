import type { PlannerTimeDetails } from './planner-timesheets.js';

export type PlannerTimerDetails = Omit<PlannerTimeDetails, 'workedOn'>;
/** Server timestamps are authoritative; serverNow lets the display ignore device-clock skew. */
export interface PlannerTimer {
  id: string;
  version: number;
  status: 'running' | 'stopped' | 'discarded';
  startedAt: string;
  endedAt: string | null;
  serverNow: string;
  elapsedMilliseconds: number;
  taskId: string | null;
  taskName: string | null;
  time: PlannerTimerDetails | null;
  canStop: boolean;
  notice: string | null;
  minutes: number;
}
export interface PlannerTimerStart {
  startKey: string;
  taskId: string;
  time?: Partial<PlannerTimerDetails>;
}
export interface PlannerTimerStop {
  version: number;
  /** The captured zone is immutable. Allocation, category and billable flag can be corrected. */
  time?: Partial<Omit<PlannerTimerDetails, 'timeZone'>>;
}
