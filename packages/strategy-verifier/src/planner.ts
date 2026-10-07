/** Shared Planner contract. Dates without a time are calendar dates, never UTC instants. */
export type PlannerView = 'list' | 'board' | 'calendar' | 'timeline' | 'gantt';
export type PlannerRole = 'admin' | 'editor' | 'commenter' | 'viewer';
export type PlannerStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export interface PlannerPerson {
  id: string;
  name: string;
}
export interface PlannerSection {
  id: string;
  name: string;
}
export interface PlannerField {
  id: string;
  name: string;
  type: 'text' | 'number' | 'date' | 'select' | 'multi_select';
  options: string[];
}
export interface PlannerProjectData {
  name: string;
  description: string;
  color: string;
  privacy: 'private' | 'team';
  defaultView: PlannerView;
  sections: PlannerSection[];
  fields: PlannerField[];
  members: { userId: string; role: PlannerRole }[];
  startOn: string | null;
  dueOn: string | null;
  health: 'on_track' | 'at_risk' | 'off_track' | 'on_hold' | 'complete';
  clientId: string | null;
}
export interface PlannerProject extends PlannerProjectData {
  id: string;
  ownerId: string;
  version: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  access: PlannerRole;
}
export interface PlannerTaskData {
  name: string;
  description: string;
  status: PlannerStatus;
  priority: 'none' | 'low' | 'medium' | 'high';
  subtype: 'task' | 'milestone' | 'approval';
  approval: 'pending' | 'approved' | 'rejected' | 'changes_requested';
  startOn: string | null;
  dueOn: string | null;
  /** Wall-clock times repeat in this IANA zone, including across daylight saving changes. */
  startTime?: string | null;
  dueTime?: string | null;
  timeZone?: string | null;
  assigneeId: string | null;
  parentId: string | null;
  dependencies: string[];
  collaborators: string[];
  tags: string[];
  memberships: { projectId: string; sectionId: string | null; position: number }[];
  customValues: Record<string, string | number | string[] | null>;
  estimateMinutes: number;
  recurrence: PlannerRecurrence | null;
  clientId: string | null;
  meetingId: string | null;
}
export type PlannerRecurrence = {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'periodically';
  interval: number;
  basedOn?: 'due_date' | 'completion_date';
  /** Sunday = 0. Empty/omitted uses the due date's weekday. */
  weekdays?: number[];
  endsOn?: string | null;
  /** Preserves the original day of month and the interval's calendar week. */
  anchorOn?: string;
};
export interface PlannerTask extends PlannerTaskData {
  id: string;
  ownerId: string;
  version: number;
  archived: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  access: PlannerRole;
  actualMinutes: number;
}
export interface PlannerEvent {
  id: string;
  taskId: string | null;
  projectId: string | null;
  actorId: string;
  kind: 'created' | 'updated' | 'comment' | 'status' | 'time' | 'archived' | 'restored';
  text: string;
  minutes: number | null;
  createdAt: string;
  version?: number;
  editedAt?: string | null;
  removed?: boolean;
}
export interface PlannerInboxItem {
  id: string;
  event: PlannerEvent;
  read: boolean;
  archived: boolean;
}
export interface PlannerActivityPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface PlannerAttachment {
  id: string;
  taskId: string;
  fileName: string;
  sizeBytes: number;
  uploadedBy: string;
  archived: boolean;
  createdAt: string;
}
export interface PlannerBootstrap {
  me: PlannerPerson;
  people: PlannerPerson[];
  projects: PlannerProject[];
}
export interface PlannerTaskPage {
  items: PlannerTask[];
  nextCursor: string | null;
}
export type PlannerResourceKind =
  'portfolio' | 'goal' | 'template' | 'rule' | 'form' | 'saved_view' | 'capacity' | 'my_tasks';
export interface PlannerMyTasksData {
  sections: PlannerSection[];
  placements: { taskId: string; sectionId: string | null; position: number }[];
}
export const PLANNER_DEFAULT_MY_TASKS: PlannerMyTasksData = {
  sections: [
    { id: '51000000-0000-4000-8000-000000000001', name: 'Today' },
    { id: '51000000-0000-4000-8000-000000000002', name: 'Upcoming' },
    { id: '51000000-0000-4000-8000-000000000003', name: 'Later' },
  ],
  placements: [],
};
export interface PlannerResource {
  id: string;
  kind: PlannerResourceKind;
  projectId: string | null;
  ownerId: string;
  name: string;
  data: Record<string, unknown>;
  version: number;
  archived: boolean;
  access: PlannerRole;
  publicShared?: boolean;
}
export interface PlannerPublicForm {
  name: string;
  description: string;
  fields: PlannerFormData['fields'];
}
export interface PlannerResourceSharing {
  description: string;
  privacy: 'private' | 'team';
  members: { userId: string; role: PlannerRole }[];
}
export interface PlannerPortfolioData extends PlannerResourceSharing {
  projectIds: string[];
}
export interface PlannerGoalData extends PlannerPortfolioData {
  ownerId: string | null;
  dueOn: string | null;
  status: 'on_track' | 'at_risk' | 'off_track' | 'achieved';
  progress: 'manual' | 'task_completion';
  current: number;
  target: number;
  unit: string;
}
export interface PlannerTemplateData extends PlannerResourceSharing {
  project: PlannerProjectData;
  tasks: PlannerTaskData[];
  layout?: { sectionId: string | null; parentIndex: number | null; dependencyIndices: number[] }[];
  schedule?: {
    anchor: 'start' | 'due';
    skipWeekends: boolean;
    dates: { startOffset: number | null; dueOffset: number | null }[];
  };
}
export interface PlannerRuleData {
  enabled: boolean;
  trigger: 'created' | 'status_changed' | 'section_changed' | 'priority_changed';
  conditions: {
    status?: PlannerStatus;
    priority?: PlannerTaskData['priority'];
    sectionId?: string | null;
  };
  actions: {
    status?: PlannerStatus;
    priority?: PlannerTaskData['priority'];
    sectionId?: string | null;
    assigneeId?: string | null;
  };
}
export interface PlannerFormData {
  description: string;
  enabled: boolean;
  fields: {
    id: string;
    label: string;
    type: 'text' | 'paragraph' | 'date' | 'number' | 'select';
    required: boolean;
    options: string[];
    taskField: 'name' | 'description' | 'dueOn' | 'priority' | 'estimateMinutes';
  }[];
  defaults: Pick<PlannerTaskData, 'assigneeId' | 'priority' | 'status' | 'estimateMinutes'>;
}
export interface PlannerSavedViewData {
  scope: 'mine' | 'project';
  projectId: string | null;
  view: PlannerView;
  search: string;
  status: string;
  assigneeId: string;
  priority: string;
  sort: 'position' | 'due' | 'name' | 'priority';
  groupBy?: 'section' | 'status' | 'priority' | 'assignee' | 'none';
}
export interface PlannerCapacityData {
  userId: string;
  weeklyMinutes: number;
}
export const PLANNER_DEFAULT_PROJECT: PlannerProjectData = {
  name: '',
  description: '',
  color: '#7c6cf2',
  privacy: 'private',
  defaultView: 'list',
  sections: [],
  fields: [],
  members: [],
  startOn: null,
  dueOn: null,
  health: 'on_track',
  clientId: null,
};
export const PLANNER_DEFAULT_TASK: PlannerTaskData = {
  name: '',
  description: '',
  status: 'todo',
  priority: 'none',
  subtype: 'task',
  approval: 'pending',
  startOn: null,
  dueOn: null,
  assigneeId: null,
  startTime: null,
  dueTime: null,
  timeZone: null,
  parentId: null,
  dependencies: [],
  collaborators: [],
  tags: [],
  memberships: [],
  customValues: {},
  estimateMinutes: 0,
  recurrence: null,
  clientId: null,
  meetingId: null,
};
export const PLANNER_STATUS_LABELS: Record<PlannerStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};
export function plannerCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function nextPlannerDate(
  value: string,
  frequency: 'daily' | 'weekly' | 'monthly',
  interval: number,
): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (frequency === 'monthly') {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + interval);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last));
  } else date.setUTCDate(date.getUTCDate() + interval * (frequency === 'weekly' ? 7 : 1));
  return date.toISOString().slice(0, 10);
}
export function plannerDependencyCycle(tasks: { id: string; dependencies: string[] }[]): boolean {
  const graph = new Map(tasks.map((t) => [t.id, t.dependencies]));
  const state = new Map<string, 'active' | 'done'>();
  for (const task of tasks) {
    if (state.has(task.id)) continue;
    const stack = [{ id: task.id, next: 0 }];
    state.set(task.id, 'active');
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const edges = graph.get(frame.id) ?? [];
      if (frame.next >= edges.length) {
        state.set(frame.id, 'done');
        stack.pop();
        continue;
      }
      const id = edges[frame.next++]!;
      if (state.get(id) === 'active') return true;
      if (state.get(id) === 'done') continue;
      state.set(id, 'active');
      stack.push({ id, next: 0 });
    }
  }
  return false;
}
