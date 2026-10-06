import type { MeriCitation } from '@capiro/shared';
import type { ResearchPlanScopeV1, ResearchPlanV1 } from './meri-research-plan.js';
import { researchMetadata, type ResearchRunState } from './meri-research-run-state.js';

export const RESEARCH_CHILD_TASK_VERSION = 1 as const;
export const RESEARCH_CHILD_ROLE_VERSION = 'meri-research-child-v1' as const;
export const MAX_RESEARCH_CHILDREN = 2;
export const MAX_RESEARCH_CHILD_GENERATION = 1;
export const MAX_RESEARCH_CHILD_OUTPUT_BYTES = 32_000;
const MAX_FINDINGS = 12;
const MAX_LIMITATIONS = 12;
const MAX_HANDLES = 48;
const MAX_TEXT = 2_000;
const MAX_ID = 256;
const TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,255}$/;
const CAPABILITY_RE = /^[a-z][a-z0-9_]{0,159}$/;
const FINDING_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const HANDLE_RE = /^[a-z][a-z0-9_]{0,159}:[^\s:][^\s]{0,254}$/;

export type ResearchChildRole = 'evidence_reviewer' | 'scope_analyst';
export type ResearchChildReasoningMode = 'fast' | 'standard' | 'deep' | 'max';
export type ResearchChildTaskStatus =
  'pending' | 'completed' | 'failed' | 'cancelled' | 'superseded';

export interface ResearchChildModelConfigV1 {
  policy: 'current_approved_research_model';
  provider: 'openai';
  modelSelection: 'server_resolved';
  reasoningMode: ResearchChildReasoningMode;
  allowProviderFallback: false;
}

export interface ResearchChildFindingV1 {
  id: string;
  statement: string;
  evidenceHandles: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface ResearchChildStructuredOutputV1 {
  version: 1;
  goalRevision: number;
  findings: ResearchChildFindingV1[];
  limitations: string[];
}

export interface ResearchChildResultV1 extends ResearchChildStructuredOutputV1 {
  taskId: string;
  model: string;
  provider: 'openai';
  evidenceHandles: string[];
  completedAt: string;
}

export interface ResearchChildFailureV1 {
  code:
    | 'cancelled'
    | 'deadline_exceeded'
    | 'provider_failed'
    | 'schema_invalid'
    | 'source_not_current'
    | 'superseded_goal_revision';
  message: string;
  failedAt: string;
}

export interface ResearchChildTaskV1 {
  version: 1;
  id: string;
  parentRunId: string;
  leaseEpoch: number;
  role: ResearchChildRole;
  roleVersion: typeof RESEARCH_CHILD_ROLE_VERSION;
  scope: ResearchPlanScopeV1;
  evidenceHandles: string[];
  goalRevision: number;
  goal: string;
  allowedCapabilities: string[];
  modelConfig: ResearchChildModelConfigV1;
  budgetRefs: {
    tool: 'researchToolBudget';
    provider: 'researchProviderBudget';
  };
  attempt: number;
  deadlineAt: string;
  generation: 1;
  delegationAllowed: false;
  status: ResearchChildTaskStatus;
  result: ResearchChildResultV1 | null;
  failure: ResearchChildFailureV1 | null;
}

export interface ResearchChildTaskSpec {
  id: string;
  role: ResearchChildRole;
  goal: string;
  allowedCapabilities: string[];
}

const TASK_KEYS = [
  'version',
  'id',
  'parentRunId',
  'leaseEpoch',
  'role',
  'roleVersion',
  'scope',
  'evidenceHandles',
  'goalRevision',
  'goal',
  'allowedCapabilities',
  'modelConfig',
  'budgetRefs',
  'attempt',
  'deadlineAt',
  'generation',
  'delegationAllowed',
  'status',
  'result',
  'failure',
] as const;
const SCOPE_KEYS = ['sessionId', 'tenantId', 'actorId', 'clientId', 'conversationId'] as const;
const MODEL_KEYS = [
  'policy',
  'provider',
  'modelSelection',
  'reasoningMode',
  'allowProviderFallback',
] as const;
const BUDGET_REF_KEYS = ['tool', 'provider'] as const;
const OUTPUT_KEYS = ['version', 'goalRevision', 'findings', 'limitations'] as const;
const FINDING_KEYS = ['id', 'statement', 'evidenceHandles', 'confidence'] as const;
const RESULT_KEYS = [
  ...OUTPUT_KEYS,
  'taskId',
  'model',
  'provider',
  'evidenceHandles',
  'completedAt',
] as const;
const FAILURE_KEYS = ['code', 'message', 'failedAt'] as const;

export class ResearchChildTaskError extends Error {
  constructor(
    readonly code: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length ? `${code}:${issues.join(';')}` : code);
    this.name = 'ResearchChildTaskError';
  }
}

export function currentResearchGoalRevision(metadata: unknown): number {
  const raw = researchMetadata(metadata).durableCoordinator;
  if (raw === undefined) return 0;
  const coordinator = record(raw);
  if (!coordinator || !nonNegativeInteger(coordinator.goalRevision)) {
    throw new ResearchChildTaskError('research_child_goal_revision_unavailable');
  }
  return coordinator.goalRevision;
}

export function createResearchChildTaskBatch(input: {
  specs: ResearchChildTaskSpec[];
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>;
  scope: ResearchPlanScopeV1;
  parentPlan: ResearchPlanV1;
  parentAllowedReadCapabilities: readonly string[];
  evidenceHandles: string[];
  goalRevision: number;
  modelConfig: ResearchChildModelConfigV1;
  deadlineAt: string;
}): ResearchChildTaskV1[] {
  if (input.specs.length !== MAX_RESEARCH_CHILDREN) invalid('research_child_batch_size_invalid');
  if (!nonNegativeInteger(input.goalRevision)) invalid('research_child_goal_revision_invalid');
  if (!validTimestamp(input.deadlineAt)) invalid('research_child_deadline_invalid');
  parseScope(input.scope);
  parseModelConfig(input.modelConfig);
  const parentCapabilities = new Set(input.parentAllowedReadCapabilities);
  const planReadCapabilities = new Set(
    input.parentPlan.steps
      .filter((step) => step.effect === 'read')
      .flatMap((step) => step.allowedCapabilities),
  );
  const evidenceHandles = uniqueStrings(input.evidenceHandles, MAX_HANDLES, HANDLE_RE);
  const ids = new Set<string>();
  return input.specs.map((spec) => {
    if (!TASK_ID_RE.test(spec.id) || ids.has(spec.id)) invalid('research_child_identity_invalid');
    ids.add(spec.id);
    if (!['evidence_reviewer', 'scope_analyst'].includes(spec.role))
      invalid('research_child_role_invalid');
    const goal = boundedText(spec.goal, MAX_TEXT, 'research_child_goal_invalid');
    const allowedCapabilities = uniqueStrings(spec.allowedCapabilities, 12, CAPABILITY_RE).sort();
    if (
      allowedCapabilities.length < 1 ||
      allowedCapabilities.some(
        (capability) =>
          !parentCapabilities.has(capability) || !planReadCapabilities.has(capability),
      )
    ) {
      invalid('research_child_capability_expansion_denied');
    }
    return {
      version: 1,
      id: spec.id,
      parentRunId: input.run.id,
      leaseEpoch: input.run.leaseEpoch,
      role: spec.role,
      roleVersion: RESEARCH_CHILD_ROLE_VERSION,
      scope: { ...input.scope },
      evidenceHandles: [...evidenceHandles],
      goalRevision: input.goalRevision,
      goal,
      allowedCapabilities,
      modelConfig: { ...input.modelConfig },
      budgetRefs: { tool: 'researchToolBudget', provider: 'researchProviderBudget' },
      attempt: 1,
      deadlineAt: input.deadlineAt,
      generation: 1,
      delegationAllowed: false,
      status: 'pending',
      result: null,
      failure: null,
    };
  });
}

/** A child goal fits the task contract: at most the text limit, never ending in whitespace. */
export function boundResearchChildGoal(goal: string): string {
  return goal.length <= MAX_TEXT ? goal.trim() : goal.slice(0, MAX_TEXT).trim();
}

export function readResearchChildTasks(metadata: unknown): ResearchChildTaskV1[] {
  const raw = researchMetadata(metadata).researchChildTasks;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_RESEARCH_CHILDREN)
    invalid('research_child_records_malformed');
  const tasks = raw.map(parseTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
    invalid('research_child_records_malformed');
  return tasks;
}

export function persistResearchChildTaskBatch(input: {
  metadata: unknown;
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>;
  tasks: ResearchChildTaskV1[];
}): Record<string, unknown> {
  const metadata = researchMetadata(input.metadata);
  const existing = readResearchChildTasks(metadata);
  if (input.tasks.length !== MAX_RESEARCH_CHILDREN) invalid('research_child_batch_size_invalid');
  const parsed = input.tasks.map(parseTask);
  if (existing.length) {
    if (JSON.stringify(existing) !== JSON.stringify(input.tasks)) {
      if (
        existing.some(
          (task) => task.parentRunId === input.run.id && task.leaseEpoch === input.run.leaseEpoch,
        )
      ) {
        invalid('research_child_batch_already_exists');
      } else {
        if (
          parsed.some(
            (task) =>
              task.parentRunId !== input.run.id ||
              task.leaseEpoch !== input.run.leaseEpoch ||
              task.status !== 'pending',
          )
        ) {
          invalid('research_child_parent_binding_invalid');
        }
        const priorHistory = Array.isArray(metadata.researchChildTaskHistory)
          ? metadata.researchChildTaskHistory
          : [];
        return {
          ...metadata,
          researchChildTaskHistory: [
            ...priorHistory,
            { supersededAt: new Date().toISOString(), tasks: existing },
          ].slice(-8),
          researchChildTasks: parsed,
        };
      }
    }
    return metadata;
  }
  if (
    parsed.some(
      (task) =>
        task.parentRunId !== input.run.id ||
        task.leaseEpoch !== input.run.leaseEpoch ||
        task.status !== 'pending',
    )
  ) {
    invalid('research_child_parent_binding_invalid');
  }
  return { ...metadata, researchChildTasks: parsed };
}

export function completeResearchChildTask(input: {
  metadata: unknown;
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>;
  goalRevision: number;
  taskId: string;
  output: ResearchChildStructuredOutputV1;
  model: string;
  provider: 'openai';
  allowedEvidenceHandles: readonly string[];
  now?: Date;
}): Record<string, unknown> {
  const metadata = researchMetadata(input.metadata);
  const tasks = readResearchChildTasks(metadata);
  const index = tasks.findIndex((task) => task.id === input.taskId);
  if (index < 0) invalid('research_child_not_found');
  const task = tasks[index]!;
  assertCurrentTask(task, input.run, input.goalRevision);
  const output = validateResearchChildOutput(input.output, {
    goalRevision: task.goalRevision,
    allowedEvidenceHandles: input.allowedEvidenceHandles,
  });
  const result: ResearchChildResultV1 = {
    ...output,
    taskId: task.id,
    model: boundedText(input.model, 160, 'research_child_model_invalid'),
    provider: input.provider,
    evidenceHandles: [
      ...new Set(output.findings.flatMap((finding) => finding.evidenceHandles)),
    ].sort(),
    completedAt: task.result?.completedAt ?? (input.now ?? new Date()).toISOString(),
  };
  if (task.status === 'completed') {
    if (JSON.stringify(task.result) !== JSON.stringify(result))
      invalid('research_child_completion_changed');
    return metadata;
  }
  if (task.status !== 'pending') invalid('research_child_not_pending');
  if ((input.now ?? new Date()).getTime() >= Date.parse(task.deadlineAt))
    invalid('research_child_deadline_exceeded');
  const next = [...tasks];
  next[index] = { ...task, status: 'completed', result, failure: null };
  return { ...metadata, researchChildTasks: next };
}

export function failResearchChildTask(input: {
  metadata: unknown;
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>;
  goalRevision: number;
  taskId: string;
  failure: Omit<ResearchChildFailureV1, 'failedAt'> & { failedAt?: string };
  status?: Extract<ResearchChildTaskStatus, 'failed' | 'cancelled' | 'superseded'>;
  now?: Date;
}): Record<string, unknown> {
  const metadata = researchMetadata(input.metadata);
  const tasks = readResearchChildTasks(metadata);
  const index = tasks.findIndex((task) => task.id === input.taskId);
  if (index < 0) invalid('research_child_not_found');
  const task = tasks[index]!;
  assertCurrentTask(task, input.run, input.goalRevision);
  const mayRevokeCompletedSource =
    task.status === 'completed' && input.failure.code === 'source_not_current';
  if (task.status !== 'pending' && !mayRevokeCompletedSource) {
    if (task.status === (input.status ?? 'failed') && task.failure?.code === input.failure.code)
      return metadata;
    invalid('research_child_not_pending');
  }
  const failure = parseFailure({
    ...input.failure,
    failedAt: input.failure.failedAt ?? (input.now ?? new Date()).toISOString(),
  });
  const next = [...tasks];
  next[index] = {
    ...task,
    status: input.status ?? 'failed',
    result: null,
    failure,
  };
  return { ...metadata, researchChildTasks: next };
}

export function validateResearchChildOutput(
  raw: unknown,
  expected: { goalRevision: number; allowedEvidenceHandles: readonly string[] },
): ResearchChildStructuredOutputV1 {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESEARCH_CHILD_OUTPUT_BYTES)
      invalid('research_child_output_too_large');
    if (duplicateJsonObjectKeys(raw).length)
      invalid('research_child_output_malformed', ['duplicate_object_key']);
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      invalid('research_child_output_malformed', ['invalid_json']);
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid('research_child_output_malformed', ['not_json_serializable']);
  }
  if (Buffer.byteLength(serialized!, 'utf8') > MAX_RESEARCH_CHILD_OUTPUT_BYTES)
    invalid('research_child_output_too_large');
  const output = parseOutput(value);
  if (output.goalRevision !== expected.goalRevision)
    invalid('research_child_goal_revision_mismatch');
  const allowed = new Set(expected.allowedEvidenceHandles);
  for (const finding of output.findings) {
    if (finding.evidenceHandles.some((handle) => !allowed.has(handle)))
      invalid('research_child_evidence_handle_unavailable');
  }
  return output;
}

export function researchChildEvidenceHandles(citations: readonly MeriCitation[]): string[] {
  const handles = citations.flatMap((citation) => {
    const id = citation.id || citation.stableId;
    return id && CAPABILITY_RE.test(citation.tool) ? [`${citation.tool}:${id}`] : [];
  });
  return uniqueStrings(handles, MAX_HANDLES, HANDLE_RE).sort();
}

export function researchChildOutputContract(goalRevision: number): string {
  return JSON.stringify({
    version: 1,
    goalRevision,
    findings: [
      {
        id: 'lowercase-stable-id',
        statement: 'Evidence-grounded finding',
        evidenceHandles: ['tool_name:record-id'],
        confidence: 'low|medium|high',
      },
    ],
    limitations: ['Material gap or uncertainty'],
  });
}

function parseTask(value: unknown): ResearchChildTaskV1 {
  const task = record(value);
  if (!task || !exactKeys(task, TASK_KEYS)) invalid('research_child_records_malformed');
  if (
    task.version !== 1 ||
    !boundedId(task.id) ||
    !boundedId(task.parentRunId) ||
    !nonNegativeInteger(task.leaseEpoch) ||
    !['evidence_reviewer', 'scope_analyst'].includes(String(task.role)) ||
    task.roleVersion !== RESEARCH_CHILD_ROLE_VERSION ||
    !nonNegativeInteger(task.goalRevision) ||
    typeof task.goal !== 'string' ||
    task.goal.length < 1 ||
    task.goal.length > MAX_TEXT ||
    !positiveInteger(task.attempt) ||
    !validTimestamp(task.deadlineAt) ||
    task.generation !== 1 ||
    task.delegationAllowed !== false ||
    !['pending', 'completed', 'failed', 'cancelled', 'superseded'].includes(String(task.status))
  ) {
    invalid('research_child_records_malformed');
  }
  const scope = parseScope(task.scope);
  const modelConfig = parseModelConfig(task.modelConfig);
  const budgetRefs = record(task.budgetRefs);
  if (
    !budgetRefs ||
    !exactKeys(budgetRefs, BUDGET_REF_KEYS) ||
    budgetRefs.tool !== 'researchToolBudget' ||
    budgetRefs.provider !== 'researchProviderBudget'
  ) {
    invalid('research_child_records_malformed');
  }
  const evidenceHandles = uniqueStrings(task.evidenceHandles, MAX_HANDLES, HANDLE_RE);
  const allowedCapabilities = uniqueStrings(task.allowedCapabilities, 12, CAPABILITY_RE);
  if (!allowedCapabilities.length) invalid('research_child_records_malformed');
  const result = task.result === null ? null : parseResult(task.result);
  const failure = task.failure === null ? null : parseFailure(task.failure);
  if (
    (task.status === 'pending' && (result || failure)) ||
    (task.status === 'completed' && (!result || failure)) ||
    (['failed', 'cancelled', 'superseded'].includes(String(task.status)) && (result || !failure))
  ) {
    invalid('research_child_records_malformed');
  }
  return {
    version: 1,
    id: task.id as string,
    parentRunId: task.parentRunId as string,
    leaseEpoch: task.leaseEpoch as number,
    role: task.role as ResearchChildRole,
    roleVersion: RESEARCH_CHILD_ROLE_VERSION,
    scope,
    evidenceHandles,
    goalRevision: task.goalRevision as number,
    goal: task.goal as string,
    allowedCapabilities,
    modelConfig,
    budgetRefs: { tool: 'researchToolBudget', provider: 'researchProviderBudget' },
    attempt: task.attempt as number,
    deadlineAt: task.deadlineAt as string,
    generation: 1,
    delegationAllowed: false,
    status: task.status as ResearchChildTaskStatus,
    result,
    failure,
  };
}

function parseOutput(value: unknown): ResearchChildStructuredOutputV1 {
  const output = record(value);
  if (
    !output ||
    !exactKeys(output, OUTPUT_KEYS) ||
    output.version !== 1 ||
    !nonNegativeInteger(output.goalRevision) ||
    !Array.isArray(output.findings) ||
    output.findings.length < 1 ||
    output.findings.length > MAX_FINDINGS
  ) {
    invalid('research_child_output_schema_invalid');
  }
  const ids = new Set<string>();
  const findings = output.findings.map((candidate) => {
    const finding = record(candidate);
    if (
      !finding ||
      !exactKeys(finding, FINDING_KEYS) ||
      typeof finding.id !== 'string' ||
      !FINDING_ID_RE.test(finding.id) ||
      ids.has(finding.id) ||
      !['low', 'medium', 'high'].includes(String(finding.confidence))
    ) {
      invalid('research_child_output_schema_invalid');
    }
    ids.add(finding.id);
    const evidenceHandles = uniqueStrings(finding.evidenceHandles, 12, HANDLE_RE);
    if (!evidenceHandles.length) invalid('research_child_output_schema_invalid');
    return {
      id: finding.id,
      statement: boundedText(finding.statement, MAX_TEXT, 'research_child_output_schema_invalid'),
      evidenceHandles,
      confidence: finding.confidence as ResearchChildFindingV1['confidence'],
    };
  });
  const limitations = uniqueTextArray(output.limitations, MAX_LIMITATIONS, MAX_TEXT);
  return {
    version: 1,
    goalRevision: output.goalRevision,
    findings,
    limitations,
  };
}

function parseResult(value: unknown): ResearchChildResultV1 {
  const result = record(value);
  if (!result || !exactKeys(result, RESULT_KEYS)) invalid('research_child_records_malformed');
  const output = parseOutput({
    version: result.version,
    goalRevision: result.goalRevision,
    findings: result.findings,
    limitations: result.limitations,
  });
  if (
    !boundedId(result.taskId) ||
    !boundedId(result.model) ||
    result.provider !== 'openai' ||
    !validTimestamp(result.completedAt)
  ) {
    invalid('research_child_records_malformed');
  }
  return {
    ...output,
    taskId: result.taskId,
    model: result.model,
    provider: 'openai',
    evidenceHandles: uniqueStrings(result.evidenceHandles, MAX_HANDLES, HANDLE_RE),
    completedAt: result.completedAt,
  };
}

function parseFailure(value: unknown): ResearchChildFailureV1 {
  const failure = record(value);
  if (
    !failure ||
    !exactKeys(failure, FAILURE_KEYS) ||
    ![
      'cancelled',
      'deadline_exceeded',
      'provider_failed',
      'schema_invalid',
      'source_not_current',
      'superseded_goal_revision',
    ].includes(String(failure.code)) ||
    !validTimestamp(failure.failedAt)
  ) {
    invalid('research_child_records_malformed');
  }
  return {
    code: failure.code as ResearchChildFailureV1['code'],
    message: boundedText(failure.message, 600, 'research_child_records_malformed'),
    failedAt: failure.failedAt,
  };
}

function assertCurrentTask(
  task: ResearchChildTaskV1,
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>,
  goalRevision: number,
): void {
  if (task.parentRunId !== run.id || task.leaseEpoch !== run.leaseEpoch)
    invalid('research_child_stale_owner');
  if (task.goalRevision !== goalRevision) invalid('research_child_goal_revision_mismatch');
}

function parseScope(value: unknown): ResearchPlanScopeV1 {
  const scope = record(value);
  if (!scope || !exactKeys(scope, SCOPE_KEYS)) invalid('research_child_scope_invalid');
  if (
    !boundedId(scope.sessionId) ||
    !boundedId(scope.tenantId) ||
    !boundedId(scope.actorId) ||
    !(scope.clientId === null || boundedId(scope.clientId)) ||
    !(scope.conversationId === null || boundedId(scope.conversationId))
  ) {
    invalid('research_child_scope_invalid');
  }
  return {
    sessionId: scope.sessionId,
    tenantId: scope.tenantId,
    actorId: scope.actorId,
    clientId: scope.clientId,
    conversationId: scope.conversationId,
  };
}

function parseModelConfig(value: unknown): ResearchChildModelConfigV1 {
  const config = record(value);
  if (
    !config ||
    !exactKeys(config, MODEL_KEYS) ||
    config.policy !== 'current_approved_research_model' ||
    config.provider !== 'openai' ||
    config.modelSelection !== 'server_resolved' ||
    !['fast', 'standard', 'deep', 'max'].includes(String(config.reasoningMode)) ||
    config.allowProviderFallback !== false
  ) {
    invalid('research_child_model_config_invalid');
  }
  return {
    policy: 'current_approved_research_model',
    provider: 'openai',
    modelSelection: 'server_resolved',
    reasoningMode: config.reasoningMode as ResearchChildReasoningMode,
    allowProviderFallback: false,
  };
}

function uniqueStrings(value: unknown, max: number, pattern: RegExp): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((item) => typeof item !== 'string' || !pattern.test(item)) ||
    new Set(value).size !== value.length
  ) {
    invalid('research_child_array_invalid');
  }
  return [...value] as string[];
}

function uniqueTextArray(value: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(value) || value.length > max) invalid('research_child_array_invalid');
  const values = value.map((item) => boundedText(item, maxChars, 'research_child_array_invalid'));
  if (new Set(values).size !== values.length) invalid('research_child_array_invalid');
  return values;
}

function boundedText(value: unknown, max: number, code: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    value.trim() !== value
  ) {
    invalid(code);
  }
  return value;
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(code: string, issues: string[] = []): never {
  throw new ResearchChildTaskError(code, issues);
}

function duplicateJsonObjectKeys(raw: string): string[] {
  const duplicates: string[] = [];
  const stack: Array<
    { kind: 'object'; keys: Set<string>; expectingKey: boolean } | { kind: 'array' }
  > = [];
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        const frame = stack.at(-1);
        if (frame?.kind === 'object' && frame.expectingKey) {
          let key = '';
          try {
            key = JSON.parse(raw.slice(stringStart, index + 1)) as string;
          } catch {
            continue;
          }
          if (frame.keys.has(key)) duplicates.push(key);
          frame.keys.add(key);
          frame.expectingKey = false;
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      stringStart = index;
    } else if (char === '{') {
      stack.push({ kind: 'object', keys: new Set<string>(), expectingKey: true });
    } else if (char === '[') {
      stack.push({ kind: 'array' });
    } else if (char === '}' || char === ']') {
      stack.pop();
    } else if (char === ',') {
      const frame = stack.at(-1);
      if (frame?.kind === 'object') frame.expectingKey = true;
    }
  }
  return duplicates;
}
