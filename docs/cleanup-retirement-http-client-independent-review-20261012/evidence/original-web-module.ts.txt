export const MERI_DURABLE_RESEARCH_VERSION = 1 as const;

export type MeriDurableRunStatus =
  | 'running'
  | 'cancel_requested'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'partial'
  | 'awaiting_clarification';

export interface MeriDurableResearchRun {
  id: string;
  leaseEpoch: number;
  eventSequence: number;
  phase: 'plan' | 'research';
  status: MeriDurableRunStatus;
  stage: string;
  startedAt: string;
  heartbeatAt: string;
  deadlineAt?: string;
  finishedAt?: string;
  failureReason?: string;
  readyToStart?: boolean;
}

export type MeriDurableStepOutcome =
  | 'pending'
  | 'reserved'
  | 'completed'
  | 'retryable_failure'
  | 'waiting_for_approval'
  | 'uncertain_effect'
  | 'superseded'
  | 'cancelled';

export interface MeriDurableResearchStep {
  id: string;
  objective: string;
  dependsOn: string[];
  goalRevision: number;
  effect: 'safe_read' | 'approval_required';
  attempt: number;
  deadlineAt: string | null;
  outcome: MeriDurableStepOutcome;
  sourceRefs: string[];
  operationRefs: string[];
  leaseEpoch: number;
  completedAt: string | null;
  failureCode: string | null;
}

export interface MeriDurableResearchEvent {
  version: 1;
  sequence: number;
  type:
    | 'plan_admitted'
    | 'step_reserved'
    | 'step_completed'
    | 'step_failed'
    | 'steering_accepted'
    | 'steering_applied'
    | 'cancel_requested'
    | 'cancelled';
  goalRevision: number;
  planVersion: number;
  stepId: string | null;
  createdAt: string;
  detail?: string;
}

export interface MeriDurableResearchCoordinator {
  version: 1;
  planVersion: number;
  goalRevision: number;
  goal: { objective: string; constraints: string[]; deliverables: string[] };
  deadlineAt: string | null;
  leaseEpoch: number;
  aggregateBudgetRef: 'researchToolBudget';
  cancellation:
    | { state: 'none' }
    | {
        state: 'requested' | 'observed';
        requestId: string;
        reason: string;
        requestedAt: string;
        observedAt: string | null;
      };
  steps: MeriDurableResearchStep[];
}

export interface MeriDurableResearchSnapshot {
  version: 1;
  researchId: string;
  // The API serializer returns null when terminal/legacy metadata no longer has
  // a readable run. The coordinator remains the authoritative retained record.
  run: MeriDurableResearchRun | null;
  coordinator: MeriDurableResearchCoordinator;
  events: MeriDurableResearchEvent[];
  nextSequence: number;
  cursorResetRequired?: true;
}

export interface MeriDurableSteeringReceipt {
  requestId: string;
  sequence: number;
  previousGoalRevision: number;
  goalRevision: number;
  message: string;
  acceptedAt: string;
  state: 'pending_safe_boundary' | 'applied';
  appliedAt?: string | null;
}

export interface MeriDurableSteeringResponse {
  version: 1;
  accepted: true;
  idempotentReplay: boolean;
  receipt: MeriDurableSteeringReceipt;
}

export class MeriDurableResearchHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Durable research request failed (HTTP ${status}).`);
    this.name = 'MeriDurableResearchHttpError';
  }
}

const TERMINAL = new Set<MeriDurableRunStatus>(['complete', 'failed', 'cancelled', 'partial']);
const EVENT_TYPES = new Set<MeriDurableResearchEvent['type']>([
  'plan_admitted',
  'step_reserved',
  'step_completed',
  'step_failed',
  'steering_accepted',
  'steering_applied',
  'cancel_requested',
  'cancelled',
]);
const MAX_EVENT_HISTORY = 200;
const RUN_STATUSES = new Set<MeriDurableRunStatus>([
  'running',
  'cancel_requested',
  'complete',
  'failed',
  'cancelled',
  'interrupted',
  'partial',
  'awaiting_clarification',
]);
const STEP_OUTCOMES = new Set<MeriDurableStepOutcome>([
  'pending',
  'reserved',
  'completed',
  'retryable_failure',
  'waiting_for_approval',
  'uncertain_effect',
  'superseded',
  'cancelled',
]);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

function readRun(value: unknown): MeriDurableResearchRun | null {
  const run = record(value);
  if (
    !run ||
    typeof run.id !== 'string' ||
    !nonNegativeInteger(run.leaseEpoch) ||
    !nonNegativeInteger(run.eventSequence) ||
    !['plan', 'research'].includes(String(run.phase)) ||
    !RUN_STATUSES.has(run.status as MeriDurableRunStatus) ||
    typeof run.stage !== 'string' ||
    typeof run.startedAt !== 'string' ||
    typeof run.heartbeatAt !== 'string'
  )
    return null;
  return {
    id: run.id,
    leaseEpoch: run.leaseEpoch,
    eventSequence: run.eventSequence,
    phase: run.phase as 'plan' | 'research',
    status: run.status as MeriDurableRunStatus,
    stage: run.stage,
    startedAt: run.startedAt,
    heartbeatAt: run.heartbeatAt,
    ...(typeof run.deadlineAt === 'string' ? { deadlineAt: run.deadlineAt } : {}),
    ...(typeof run.finishedAt === 'string' ? { finishedAt: run.finishedAt } : {}),
    ...(typeof run.failureReason === 'string' ? { failureReason: run.failureReason } : {}),
    ...(run.readyToStart === true ? { readyToStart: true } : {}),
  };
}

function readStep(value: unknown): MeriDurableResearchStep | null {
  const step = record(value);
  const dependsOn = stringArray(step?.dependsOn);
  const sourceRefs = stringArray(step?.sourceRefs);
  const operationRefs = stringArray(step?.operationRefs);
  if (
    !step ||
    typeof step.id !== 'string' ||
    typeof step.objective !== 'string' ||
    !dependsOn ||
    !nonNegativeInteger(step.goalRevision) ||
    !['safe_read', 'approval_required'].includes(String(step.effect)) ||
    !nonNegativeInteger(step.attempt) ||
    !(step.deadlineAt === null || typeof step.deadlineAt === 'string') ||
    !STEP_OUTCOMES.has(step.outcome as MeriDurableStepOutcome) ||
    !sourceRefs ||
    !operationRefs ||
    !nonNegativeInteger(step.leaseEpoch) ||
    !(step.completedAt === null || typeof step.completedAt === 'string') ||
    !(step.failureCode === null || typeof step.failureCode === 'string')
  )
    return null;
  return {
    id: step.id,
    objective: step.objective,
    dependsOn,
    goalRevision: step.goalRevision,
    effect: step.effect as MeriDurableResearchStep['effect'],
    attempt: step.attempt,
    deadlineAt: step.deadlineAt as string | null,
    outcome: step.outcome as MeriDurableStepOutcome,
    sourceRefs,
    operationRefs,
    leaseEpoch: step.leaseEpoch,
    completedAt: step.completedAt as string | null,
    failureCode: step.failureCode as string | null,
  };
}

function readEvent(value: unknown): MeriDurableResearchEvent | null {
  const event = record(value);
  if (
    !event ||
    event.version !== 1 ||
    !nonNegativeInteger(event.sequence) ||
    !EVENT_TYPES.has(event.type as MeriDurableResearchEvent['type']) ||
    !nonNegativeInteger(event.goalRevision) ||
    !nonNegativeInteger(event.planVersion) ||
    !(event.stepId === null || typeof event.stepId === 'string') ||
    typeof event.createdAt !== 'string'
  )
    return null;
  return event as unknown as MeriDurableResearchEvent;
}

export function readMeriDurableResearchSnapshot(
  value: unknown,
): MeriDurableResearchSnapshot | null {
  const snapshot = record(value);
  const run = snapshot?.run === null ? null : readRun(snapshot?.run);
  const coordinator = record(snapshot?.coordinator);
  const goal = record(coordinator?.goal);
  const constraints = stringArray(goal?.constraints);
  const deliverables = stringArray(goal?.deliverables);
  const cancellation = record(coordinator?.cancellation);
  const parsedCancellation = readCancellation(cancellation);
  const rawSteps = coordinator?.steps;
  const rawEvents = snapshot?.events;
  const steps = Array.isArray(rawSteps)
    ? rawSteps.map(readStep).filter((step): step is MeriDurableResearchStep => Boolean(step))
    : null;
  const events = Array.isArray(rawEvents)
    ? rawEvents.map(readEvent).filter((event): event is MeriDurableResearchEvent => Boolean(event))
    : null;
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    typeof snapshot.researchId !== 'string' ||
    !(snapshot.run === null || run) ||
    !coordinator ||
    coordinator.version !== 1 ||
    !nonNegativeInteger(coordinator.planVersion) ||
    !nonNegativeInteger(coordinator.goalRevision) ||
    !goal ||
    typeof goal.objective !== 'string' ||
    !constraints ||
    !deliverables ||
    !(coordinator.deadlineAt === null || typeof coordinator.deadlineAt === 'string') ||
    !nonNegativeInteger(coordinator.leaseEpoch) ||
    coordinator.aggregateBudgetRef !== 'researchToolBudget' ||
    !parsedCancellation ||
    !steps ||
    !Array.isArray(rawSteps) ||
    steps.length !== rawSteps.length ||
    !events ||
    !Array.isArray(rawEvents) ||
    events.length !== rawEvents.length ||
    !nonNegativeInteger(snapshot.nextSequence)
  )
    return null;
  return {
    version: 1,
    researchId: snapshot.researchId,
    run,
    coordinator: {
      version: 1,
      planVersion: coordinator.planVersion,
      goalRevision: coordinator.goalRevision,
      goal: { objective: goal.objective, constraints, deliverables },
      deadlineAt: coordinator.deadlineAt as string | null,
      leaseEpoch: coordinator.leaseEpoch,
      aggregateBudgetRef: 'researchToolBudget',
      cancellation: parsedCancellation,
      steps,
    },
    events: events.sort((left, right) => left.sequence - right.sequence).slice(-MAX_EVENT_HISTORY),
    nextSequence: snapshot.nextSequence,
    ...(snapshot.cursorResetRequired === true ? { cursorResetRequired: true as const } : {}),
  };
}

function readCancellation(
  cancellation: Record<string, unknown> | null,
): MeriDurableResearchCoordinator['cancellation'] | null {
  if (!cancellation) return null;
  if (cancellation.state === 'none') return { state: 'none' };
  if (
    !['requested', 'observed'].includes(String(cancellation.state)) ||
    typeof cancellation.requestId !== 'string' ||
    typeof cancellation.reason !== 'string' ||
    typeof cancellation.requestedAt !== 'string' ||
    !(cancellation.observedAt === null || typeof cancellation.observedAt === 'string')
  )
    return null;
  return {
    state: cancellation.state as 'requested' | 'observed',
    requestId: cancellation.requestId,
    reason: cancellation.reason,
    requestedAt: cancellation.requestedAt,
    observedAt: cancellation.observedAt as string | null,
  };
}

/**
 * Merge a delta snapshot without allowing a delayed request, an old lease, or
 * an old goal revision to revive or regress the displayed run.
 */
export function mergeMeriDurableResearchSnapshot(
  previous: MeriDurableResearchSnapshot | null,
  incoming: MeriDurableResearchSnapshot,
): MeriDurableResearchSnapshot {
  if (!previous || previous.researchId !== incoming.researchId) return incoming;
  if (incoming.coordinator.goalRevision < previous.coordinator.goalRevision) return previous;
  if (
    incoming.coordinator.goalRevision === previous.coordinator.goalRevision &&
    incoming.coordinator.planVersion < previous.coordinator.planVersion
  )
    return previous;
  if (incoming.run && previous.run && incoming.run.leaseEpoch < previous.run.leaseEpoch)
    return previous;
  if (
    !previous.run &&
    incoming.run &&
    incoming.coordinator.leaseEpoch <= previous.coordinator.leaseEpoch
  )
    return previous;
  if (
    incoming.run &&
    previous.run &&
    incoming.run.id === previous.run.id &&
    incoming.run.leaseEpoch === previous.run.leaseEpoch &&
    incoming.run.eventSequence < previous.run.eventSequence
  )
    return previous;
  if (
    incoming.run &&
    previous.run &&
    incoming.run.id === previous.run.id &&
    TERMINAL.has(previous.run.status) &&
    !TERMINAL.has(incoming.run.status)
  )
    return previous;

  const eventMap = new Map<number, MeriDurableResearchEvent>();
  if (!incoming.cursorResetRequired) {
    for (const event of previous.events) eventMap.set(event.sequence, event);
  }
  for (const event of incoming.events) {
    if (event.goalRevision < incoming.coordinator.goalRevision - 1) continue;
    if (incoming.cursorResetRequired || !eventMap.has(event.sequence))
      eventMap.set(event.sequence, event);
  }
  return {
    ...incoming,
    events: [...eventMap.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-MAX_EVENT_HISTORY),
    nextSequence: incoming.cursorResetRequired
      ? incoming.nextSequence
      : Math.max(previous.nextSequence, incoming.nextSequence),
  };
}

async function bodyOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function checkedJson(response: Response): Promise<unknown> {
  const body = await bodyOrNull(response);
  if (!response.ok) throw new MeriDurableResearchHttpError(response.status, body);
  return body;
}

export async function fetchMeriDurableResearchSnapshot(input: {
  apiBaseUrl: string;
  researchId: string;
  afterSequence: number;
  headers: Record<string, string>;
  signal?: AbortSignal;
}): Promise<MeriDurableResearchSnapshot> {
  const response = await fetch(
    `${input.apiBaseUrl}/api/clio/research/${encodeURIComponent(input.researchId)}/coordinator?afterSequence=${input.afterSequence}`,
    { headers: input.headers, signal: input.signal },
  );
  const snapshot = readMeriDurableResearchSnapshot(await checkedJson(response));
  if (!snapshot || snapshot.researchId !== input.researchId)
    throw new Error('The durable research coordinator returned an invalid snapshot.');
  return snapshot;
}

export async function steerMeriDurableResearch(input: {
  apiBaseUrl: string;
  researchId: string;
  headers: Record<string, string>;
  requestId: string;
  expectedGoalRevision: number;
  message: string;
  signal?: AbortSignal;
}): Promise<MeriDurableSteeringResponse> {
  const response = await fetch(
    `${input.apiBaseUrl}/api/clio/research/${encodeURIComponent(input.researchId)}/steer`,
    {
      method: 'POST',
      headers: input.headers,
      body: JSON.stringify({
        version: 1,
        requestId: input.requestId,
        expectedGoalRevision: input.expectedGoalRevision,
        message: input.message,
      }),
      signal: input.signal,
    },
  );
  const value = record(await checkedJson(response));
  const receipt = record(value?.receipt);
  if (
    !value ||
    value.version !== 1 ||
    value.accepted !== true ||
    typeof value.idempotentReplay !== 'boolean' ||
    !receipt ||
    receipt.version !== 1 ||
    typeof receipt.requestId !== 'string' ||
    !nonNegativeInteger(receipt.goalRevision) ||
    !nonNegativeInteger(receipt.previousGoalRevision) ||
    !nonNegativeInteger(receipt.sequence) ||
    typeof receipt.message !== 'string' ||
    typeof receipt.acceptedAt !== 'string' ||
    !['pending_safe_boundary', 'applied'].includes(String(receipt.state)) ||
    !(receipt.appliedAt === null || typeof receipt.appliedAt === 'string')
  )
    throw new Error('The durable research steering response was invalid.');
  return value as unknown as MeriDurableSteeringResponse;
}

export async function cancelMeriDurableResearch(input: {
  apiBaseUrl: string;
  researchId: string;
  headers: Record<string, string>;
  requestId: string;
  signal?: AbortSignal;
}): Promise<{ run: MeriDurableResearchRun | null }> {
  const response = await fetch(
    `${input.apiBaseUrl}/api/clio/research/${encodeURIComponent(input.researchId)}/cancel`,
    {
      method: 'POST',
      headers: input.headers,
      body: JSON.stringify({ version: 1, requestId: input.requestId, reason: 'User pressed Stop' }),
      signal: input.signal,
    },
  );
  const value = record(await checkedJson(response));
  return { run: readRun(value?.run) };
}

export function newMeriDurableRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  return `meri-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function isMeriDurableTerminal(status: MeriDurableRunStatus): boolean {
  return TERMINAL.has(status);
}
