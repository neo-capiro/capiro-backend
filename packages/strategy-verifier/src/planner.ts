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
  resourceId?: string | null;
  goalSnapshot?: PlannerGoalSnapshot;
  goalUpdate?: { title: string; sections: PlannerGoalUpdateSection[] };
  actorId: string;
  kind:
    | 'created'
    | 'updated'
    | 'comment'
    | 'status'
    | 'time'
    | 'archived'
    | 'restored'
    | 'reminder'
    | 'goal_status'
    | 'goal_progress';
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
export interface PlannerBellItem extends PlannerInboxItem {
  title: string;
  deepLink: string;
}
export interface PlannerBellFeed {
  items: PlannerBellItem[];
  /** Current authorized, unarchived unread total, independent of the row limit. */
  unread: number;
}
export interface PlannerActivityPage<T> {
  goalContext?: { audienceCount: number; following: boolean };
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
  | 'portfolio'
  | 'goal'
  | 'template'
  | 'rule'
  | 'form'
  | 'saved_view'
  | 'capacity'
  | 'my_tasks'
  | 'dashboard';
export interface PlannerMyTasksData {
  sections: PlannerSection[];
  placements: { taskId: string; sectionId: string | null; position: number }[];
  rules?: PlannerPersonalRule[];
}
export interface PlannerDateRule {
  trigger: 'due_approaching' | 'overdue';
  schedule: { amount: number; unit: 'days' | 'hours' | 'minutes' };
}
export interface PlannerPersonalRule extends PlannerDateRule {
  id: string;
  name: string;
  enabled: boolean;
  sectionId?: string | null;
  notify: boolean;
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
  goalProgress?: PlannerGoalProgress;
  parentGoalIds?: string[];
  reportWarnings?: { widgetId: string; unavailableSources: boolean; unavailableFields: boolean }[];
}
export interface PlannerPublicForm {
  name: string;
  description: string;
  fields: PlannerFormQuestion[];
  confirmationMessage?: string;
  allowAnotherSubmission?: boolean;
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
  status: 'on_track' | 'at_risk' | 'off_track' | 'achieved' | 'partial' | 'missed' | 'dropped';
  progress:
    | 'manual'
    | 'task_completion'
    | 'project_task_completion'
    | 'project_milestone_completion'
    | 'task_list_completion'
    | 'subgoal_percentage'
    | 'subgoal_total';
  current: number;
  target: number;
  unit: string;
  startValue?: number;
  direction?: 'increase' | 'decrease';
  followers?: string[];
  reminder?: PlannerGoalReminder | null;
  timeZone?: string;
  subgoalIds?: string[];
  taskIds?: string[];
  startOn?: string | null;
  timePeriod?: string;
  goalType?: 'company' | 'team' | 'individual';
  weightMode?: 'equal' | 'custom';
  weights?: { sourceId: string; weight: number }[];
}
export interface PlannerGoalUpdateSection {
  id: string;
  title: string;
  text: string;
}
export interface PlannerGoalReminder {
  cadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly';
  anchorOn: string;
  time: string;
  timeZone: string;
}
/** Historical numeric values are present only when current access covers every captured source. */
export interface PlannerGoalSnapshot {
  status: PlannerGoalData['status'];
  measurement: PlannerGoalData['progress'];
  target: number;
  startValue: number;
  direction: 'increase' | 'decrease';
  unit: string;
  value?: number;
  percentage?: number;
}
export interface PlannerGoalProgress {
  value: number;
  percentage: number;
  sources: {
    id: string;
    kind: 'goal' | 'project' | 'task';
    value: number;
    percentage: number;
    weight: number;
  }[];
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
  trigger:
    | 'created'
    | 'status_changed'
    | 'section_changed'
    | 'priority_changed'
    | PlannerDateRule['trigger'];
  schedule?: PlannerDateRule['schedule'];
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
    notify?: boolean;
  };
}
export interface PlannerFormQuestion {
  id: string;
  label: string;
  description?: string;
  type:
    'text' | 'paragraph' | 'email' | 'date' | 'number' | 'select' | 'multi_select' | 'attachment';
  required: boolean;
  options: string[];
  /** A branch is visible if its visible parent contains any selected response. */
  showWhen?: { questionId: string; values: string[] };
  multiple?: boolean;
  maxLength?: number;
}
export interface PlannerFormField extends PlannerFormQuestion {
  taskField:
    | 'name'
    | 'description'
    | 'startOn'
    | 'dueOn'
    | 'priority'
    | 'estimateMinutes'
    | 'custom'
    | 'attachments'
    | null;
  customFieldId?: string;
}
export interface PlannerFormData {
  description: string;
  enabled: boolean;
  fields: PlannerFormField[];
  defaults: Pick<PlannerTaskData, 'assigneeId' | 'priority' | 'status' | 'estimateMinutes'>;
  sectionId?: string | null;
  titleFieldId?: string | null;
  copyAnswersToDescription?: boolean;
  confirmationMessage?: string;
  allowAnotherSubmission?: boolean;
  addSubmitterAsCollaborator?: boolean;
  audience?: 'organization' | 'public';
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
