import type { PlannerResourceSharing } from './planner.js';

export type PlannerReportEntity = 'tasks' | 'projects' | 'goals' | 'portfolios';
export const PLANNER_REPORT_OPTIONS = {
  tasks: {
    metrics: ['count', 'estimated_minutes', 'actual_minutes', 'custom_number'],
    groups: [
      'none',
      'status',
      'assignee',
      'owner',
      'priority',
      'type',
      'project',
      'tag',
      'custom',
      'created',
      'due',
      'completed',
    ],
    statuses: ['todo', 'in_progress', 'blocked', 'done'],
    types: ['task', 'milestone', 'approval'],
  },
  projects: {
    metrics: ['count', 'estimated_minutes', 'actual_minutes', 'progress'],
    groups: ['none', 'status', 'owner', 'created', 'due'],
    statuses: ['on_track', 'at_risk', 'off_track', 'on_hold', 'complete'],
    types: [],
  },
  goals: {
    metrics: ['count', 'progress'],
    groups: ['none', 'status', 'owner', 'type', 'period', 'created', 'due'],
    statuses: ['on_track', 'at_risk', 'off_track', 'achieved', 'partial', 'missed', 'dropped'],
    types: ['company', 'team', 'individual'],
  },
  portfolios: {
    metrics: ['count', 'project_count'],
    groups: ['none', 'owner', 'created'],
    statuses: [],
    types: [],
  },
} as const;
export type PlannerReportMetric =
  'count' | 'estimated_minutes' | 'actual_minutes' | 'progress' | 'project_count' | 'custom_number';
export type PlannerReportGroup =
  | 'none'
  | 'status'
  | 'owner'
  | 'assignee'
  | 'priority'
  | 'type'
  | 'project'
  | 'tag'
  | 'custom'
  | 'created'
  | 'due'
  | 'completed'
  | 'period';
export type PlannerReportSource = {
  kind: 'all' | 'projects' | 'portfolios';
  ids: string[];
};
export interface PlannerReportFilters {
  source: PlannerReportSource;
  statuses: string[];
  personIds: string[];
  priorities: string[];
  types: string[];
  tags: string[];
  includeSubtasks: boolean;
  dateField: 'created' | 'start' | 'due' | 'completed';
  from: string | null;
  through: string | null;
  timeZone: string;
  custom: { fieldId: string; values: (string | number)[] }[];
}
export interface PlannerReportChart {
  entity: PlannerReportEntity;
  metric: PlannerReportMetric;
  group: PlannerReportGroup;
  groupFieldId: string | null;
  metricFieldId: string | null;
  granularity: 'day' | 'week' | 'month' | 'quarter' | 'year';
  filters: PlannerReportFilters;
}
export type PlannerReportWidget =
  | { id: string; kind: 'text'; title: string; text: string }
  | {
      id: string;
      kind: 'chart';
      title: string;
      style: 'bar' | 'donut' | 'line' | 'number';
      labels: boolean;
      chart: PlannerReportChart;
    };
export interface PlannerDashboardData extends PlannerResourceSharing {
  description: string;
  widgets: PlannerReportWidget[];
}
export interface PlannerReportBucket {
  key: string;
  label: string;
  value: number;
  count: number;
}
export interface PlannerReportResult {
  buckets: PlannerReportBucket[];
  total: number | null;
  matched: number | null;
  unit: 'items' | 'minutes' | 'percent' | 'number';
  /** Multi-project/tag/select grouping can place an item in several buckets. */
  overlapping: boolean;
  /** Current access may exclude saved sources; missing references never broaden scope. */
  unavailableSources: boolean;
  /** An inaccessible field cannot be evaluated as zero or an unset category. */
  unavailableFields: boolean;
}
export interface PlannerReportRow {
  id: string;
  entity: PlannerReportEntity;
  name: string;
  status: string | null;
  personName: string | null;
  dueOn: string | null;
  value: number;
}
export interface PlannerReportResponse extends PlannerReportResult {
  dashboardVersion: number;
  /** An opaque revision binds drill-down pages to the same authorized work. */
  revision: string;
  items?: PlannerReportRow[];
  nextCursor?: string | null;
}
export const PLANNER_DEFAULT_REPORT_CHART: PlannerReportChart = {
  entity: 'tasks',
  metric: 'count',
  group: 'status',
  groupFieldId: null,
  metricFieldId: null,
  granularity: 'month',
  filters: {
    source: { kind: 'all', ids: [] },
    statuses: [],
    personIds: [],
    priorities: [],
    types: [],
    tags: [],
    includeSubtasks: true,
    dateField: 'due',
    from: null,
    through: null,
    timeZone: 'UTC',
    custom: [],
  },
};
