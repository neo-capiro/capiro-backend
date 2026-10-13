import { asString } from './client-profile-fill.helpers.js';

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
