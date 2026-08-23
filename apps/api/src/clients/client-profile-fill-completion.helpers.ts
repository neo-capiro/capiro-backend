import { asString, stableJson } from './client-profile-fill.helpers.js';

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

export type ClientProfileFillCompletionTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface ClientProfileFillCompletionTaskPlanEntry {
  taskType: ClientProfileFillCompletionTaskType;
  taskKey: string;
  dependsOn: string[];
}

export interface ClientProfileFillCompletionTaskRow {
  id: string;
  runId: string;
  tenantId: string;
  clientId: string;
  taskType: ClientProfileFillCompletionTaskType;
  taskKey: string;
  status: ClientProfileFillCompletionTaskStatus;
  dependsOn: string[];
  attempt: number;
  maxAttempts: number;
  input: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  workerId: string | null;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  nextAttemptAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientProfileFillAdvancedFindingRow {
  id: string;
  runId?: string;
  clientId?: string;
  kind: string;
  targetKey: string;
  source: string;
  factKind: string;
  currentValue: unknown;
  proposedValue: unknown;
  evidence: unknown;
  confidence: number | string;
  status: string;
  contentHash: string;
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

export const ADVANCED_FILL_FINDING_KINDS = new Set([
  'federal_footprint',
  'facility_resolution',
  'district_nexus',
  'advocacy_record',
  'advocacy_outcome',
  'profile_completion',
]);

export const NON_APPLYABLE_ADVANCED_FILL_FINDING_KINDS = new Set([
  'facility_resolution',
  'district_nexus',
  'profile_completion',
]);

export const TERMINAL_COMPLETION_TASK_STATUSES = new Set<ClientProfileFillCompletionTaskStatus>([
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

export function buildClientProfileFillCompletionPlan(): ClientProfileFillCompletionTaskPlanEntry[] {
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

export function scoreAdvocacyOutcome(
  advocacy: Record<string, unknown>,
  outcome: Record<string, unknown>,
): number {
  const advocacyTokens = meaningfulTokens(
    [advocacy.title, advocacy.summary, stableJson(advocacy.metadata)].join(' '),
  );
  const outcomeTokens = meaningfulTokens(
    [outcome.kind, outcome.notes, stableJson(outcome.evidence)].join(' '),
  );
  const intersection = [...advocacyTokens].filter((token) => outcomeTokens.has(token)).length;
  const semantic = intersection / Math.max(4, Math.min(advocacyTokens.size, outcomeTokens.size));
  const sameSource =
    asString(advocacy.sourceType) === asString(outcome.sourceType) &&
    Boolean(asString(advocacy.sourceId)) &&
    asString(advocacy.sourceId) === asString(outcome.sourceId);
  return Number(Math.min(0.99, 0.24 + semantic * 0.65 + (sameSource ? 0.55 : 0)).toFixed(3));
}

function meaningfulTokens(value: string) {
  const stop = new Set([
    'about',
    'after',
    'again',
    'also',
    'been',
    'from',
    'have',
    'into',
    'that',
    'their',
    'this',
    'with',
    'were',
    'will',
  ]);
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !stop.has(token)),
  );
}
