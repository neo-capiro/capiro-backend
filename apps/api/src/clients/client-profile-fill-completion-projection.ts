import { asString } from './client-profile-fill.helpers.js';
import { TERMINAL_TASK_STATUSES } from './client-profile-fill-completion-runtime.shared.js';

export const CLIENT_PROFILE_FILL_COMPLETION_TASK_TYPES = [
  'federal_market',
  'facility_resolution',
  'district_nexus',
  'advocacy_history',
  'lifecycle_outcomes',
  'reconciliation',
  'completion_audit',
] as const;

export type ClientProfileFillCompletionTaskType =
  (typeof CLIENT_PROFILE_FILL_COMPLETION_TASK_TYPES)[number];
interface CompletionTaskPlanEntry {
  taskType: ClientProfileFillCompletionTaskType;
  taskKey: string;
  dependsOn: string[];
}
export interface ProfileCompletionInput {
  federalIdentity: boolean;
  website: boolean;
  overview: boolean;
  governmentIdentity: boolean;
  capabilities: boolean;
  relationships: boolean;
  facilities: boolean;
  districtNexus: boolean;
  federalMarket: boolean;
  lobbyingHistory: boolean;
  advocacyHistory: boolean;
  programElements: boolean;
  bills: boolean;
}

export interface ProfileCompletionResult {
  score: number;
  completed: string[];
  missing: string[];
}
export function buildClientProfileFillCompletionPlan(): CompletionTaskPlanEntry[] {
  return [
    { taskType: 'federal_market', taskKey: 'federal_market', dependsOn: [] },
    { taskType: 'facility_resolution', taskKey: 'facility_resolution', dependsOn: [] },
    {
      taskType: 'district_nexus',
      taskKey: 'district_nexus',
      dependsOn: ['facility_resolution'],
    },
    { taskType: 'advocacy_history', taskKey: 'advocacy_history', dependsOn: [] },
    {
      taskType: 'lifecycle_outcomes',
      taskKey: 'lifecycle_outcomes',
      dependsOn: ['advocacy_history', 'federal_market'],
    },
    {
      taskType: 'reconciliation',
      taskKey: 'reconciliation',
      dependsOn: [
        'federal_market',
        'facility_resolution',
        'district_nexus',
        'advocacy_history',
        'lifecycle_outcomes',
      ],
    },
    {
      taskType: 'completion_audit',
      taskKey: 'completion_audit',
      dependsOn: ['reconciliation'],
    },
  ];
}

export function mergeFillProgress(tasks: ReadonlyArray<{ status?: unknown }>) {
  const statusOf = (task: { status?: unknown }) => asString(task.status) ?? '';
  return {
    total: tasks.length,
    queued: tasks.filter((task) => statusOf(task) === 'queued').length,
    running: tasks.filter((task) => statusOf(task) === 'running').length,
    completed: tasks.filter((task) => statusOf(task) === 'completed').length,
    failed: tasks.filter((task) => statusOf(task) === 'failed').length,
    cancelled: tasks.filter((task) => statusOf(task) === 'cancelled').length,
  };
}

/** Projects the existing Core and extension task state without reading or changing a run. */
export function projectFillRunState(
  coreStatus: unknown,
  coreTasks: ReadonlyArray<{ status?: unknown }>,
  extensionTasks: ReadonlyArray<{ status?: unknown; taskType?: unknown }>,
) {
  const allTasks = [...coreTasks, ...extensionTasks];
  const progress = mergeFillProgress(allTasks);
  const pending =
    coreStatus !== 'cancelled' &&
    allTasks.some((task) => task.status === 'queued' || task.status === 'running');
  const allTerminal =
    allTasks.length > 0 &&
    allTasks.every((task) => TERMINAL_TASK_STATUSES.has(String(task.status)));
  const anyFailed = allTasks.some((task) => task.status === 'failed');
  const anyCompleted = allTasks.some(
    (task) => task.status === 'completed' || task.status === 'skipped',
  );
  const status =
    coreStatus === 'cancelled'
      ? 'cancelled'
      : pending
        ? 'running'
        : allTerminal
          ? anyFailed
            ? anyCompleted
              ? 'partial'
              : 'failed'
            : 'completed'
          : coreStatus;
  const stage = pending
    ? extensionTasks.some(
        (task) =>
          task.status === 'running' &&
          (task.taskType === 'reconciliation' || task.taskType === 'completion_audit'),
      )
      ? 'reconciliation'
      : 'research'
    : status === 'failed'
      ? 'failed'
      : status === 'cancelled'
        ? 'cancelled'
        : 'review_ready';
  return { status, stage, pending, progress };
}

export function calculateProfileCompletion(input: ProfileCompletionInput): ProfileCompletionResult {
  const labels: Array<[keyof ProfileCompletionInput, string]> = [
    ['federalIdentity', 'Federal identity'],
    ['website', 'Company website'],
    ['overview', 'Company overview'],
    ['governmentIdentity', 'Government identifiers'],
    ['capabilities', 'Capabilities'],
    ['relationships', 'Relationships and history'],
    ['facilities', 'Facilities'],
    ['districtNexus', 'District Nexus'],
    ['federalMarket', 'Federal Market footprint'],
    ['lobbyingHistory', 'Lobbying history'],
    ['advocacyHistory', 'Advocacy history'],
    ['programElements', 'Program Elements'],
    ['bills', 'Bill recommendations'],
  ];
  const completed = labels.filter(([key]) => input[key]).map(([, label]) => label);
  const missing = labels.filter(([key]) => !input[key]).map(([, label]) => label);
  return {
    score: Math.round((completed.length / labels.length) * 100),
    completed,
    missing,
  };
}
