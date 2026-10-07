import { researchJsonSha256 } from './meri-research-durable-result.js';
import type { ResearchPlanStepV1, ResearchPlanV1 } from './meri-research-plan.js';
import {
  readResearchRun,
  researchMetadata,
  type ResearchRunState,
} from './meri-research-run-state.js';

export const DURABLE_RESEARCH_COORDINATOR_VERSION = 1 as const;
const MAX_EVENTS = 200;
const MAX_INBOX = 100;
const MAX_HISTORY = 100;
const MAX_TEXT = 4_000;

export type DurableResearchStepOutcome =
  | 'pending'
  | 'reserved'
  | 'completed'
  | 'retryable_failure'
  | 'waiting_for_approval'
  | 'uncertain_effect'
  | 'superseded'
  | 'cancelled';

export interface DurableResearchCoordinatorStepV1 {
  id: string;
  objective: string;
  dependsOn: string[];
  goalRevision: number;
  effect: 'safe_read' | 'approval_required';
  allowedCapabilities: string[];
  fingerprint: string | null;
  attempt: number;
  deadlineAt: string | null;
  outcome: DurableResearchStepOutcome;
  sourceRefs: string[];
  operationRefs: string[];
  resultRef: string | null;
  leaseEpoch: number;
  reservationId: string | null;
  providerCallId: string | null;
  completedAt: string | null;
  failureCode: string | null;
}

export interface DurableResearchSteeringReceiptV1 {
  version: 1;
  requestId: string;
  sequence: number;
  previousGoalRevision: number;
  goalRevision: number;
  message: string;
  acceptedAt: string;
  state: 'pending_safe_boundary' | 'applied';
  appliedAt: string | null;
}

export interface DurableResearchCoordinatorEventV1 {
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

export interface DurableResearchCoordinatorV1 {
  version: 1;
  planVersion: number;
  planSha256: string;
  goalRevision: number;
  goal: { objective: string; constraints: string[]; deliverables: string[] };
  deadlineAt: string | null;
  leaseEpoch: number;
  aggregateBudgetRef: 'researchToolBudget';
  steps: DurableResearchCoordinatorStepV1[];
  stepHistory: DurableResearchCoordinatorStepV1[];
  inbox: DurableResearchSteeringReceiptV1[];
  appliedInboxSequence: number;
  cancellation:
    | { state: 'none' }
    | {
        state: 'requested' | 'observed';
        requestId: string;
        reason: string;
        requestedAt: string;
        observedAt: string | null;
      };
  events: DurableResearchCoordinatorEventV1[];
}

export class DurableResearchCoordinatorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DurableResearchCoordinatorError';
  }
}

export function readDurableResearchCoordinator(
  value: unknown,
): DurableResearchCoordinatorV1 | null {
  const raw = researchMetadata(value).durableCoordinator;
  if (raw === undefined) return null;
  if (!isRecord(raw) || raw.version !== 1) malformed();
  if (
    !positiveInteger(raw.planVersion) ||
    typeof raw.planSha256 !== 'string' ||
    !nonNegativeInteger(raw.goalRevision) ||
    !isRecord(raw.goal) ||
    typeof raw.goal.objective !== 'string' ||
    !stringArray(raw.goal.constraints) ||
    !stringArray(raw.goal.deliverables) ||
    !(raw.deadlineAt === null || validTimestamp(raw.deadlineAt)) ||
    !nonNegativeInteger(raw.leaseEpoch) ||
    raw.aggregateBudgetRef !== 'researchToolBudget' ||
    !Array.isArray(raw.steps) ||
    !Array.isArray(raw.stepHistory) ||
    !Array.isArray(raw.inbox) ||
    !nonNegativeInteger(raw.appliedInboxSequence) ||
    !Array.isArray(raw.events) ||
    !isRecord(raw.cancellation)
  )
    malformed();
  const coordinator: DurableResearchCoordinatorV1 = {
    version: 1,
    planVersion: raw.planVersion,
    planSha256: raw.planSha256,
    goalRevision: raw.goalRevision,
    goal: {
      objective: raw.goal.objective,
      constraints: [...raw.goal.constraints],
      deliverables: [...raw.goal.deliverables],
    },
    deadlineAt: raw.deadlineAt as string | null,
    leaseEpoch: raw.leaseEpoch,
    aggregateBudgetRef: 'researchToolBudget',
    steps: raw.steps.map(parseStep),
    stepHistory: raw.stepHistory.map(parseStep),
    inbox: raw.inbox.map(parseSteering),
    appliedInboxSequence: raw.appliedInboxSequence,
    cancellation: parseCancellation(raw.cancellation),
    events: raw.events.map(parseEvent),
  };
  if (new Set(coordinator.steps.map((step) => step.id)).size !== coordinator.steps.length)
    malformed();
  if (
    new Set(coordinator.inbox.map((message) => message.requestId)).size !== coordinator.inbox.length
  )
    malformed();
  return coordinator;
}

export function admitDurableResearchCoordinator(input: {
  metadata: unknown;
  plan: ResearchPlanV1;
  objective: string;
  run: Pick<ResearchRunState, 'leaseEpoch' | 'eventSequence'>;
  now?: Date;
}): { metadata: Record<string, unknown>; coordinator: DurableResearchCoordinatorV1 } {
  const metadata = researchMetadata(input.metadata);
  const existing = readDurableResearchCoordinator(metadata);
  if (existing) return { metadata, coordinator: existing };
  const now = input.now ?? new Date();
  let coordinator: DurableResearchCoordinatorV1 = {
    version: 1,
    planVersion: 1,
    planSha256: researchJsonSha256(input.plan),
    goalRevision: 0,
    goal: { objective: bounded(input.objective), constraints: [], deliverables: [] },
    deadlineAt: null,
    leaseEpoch: input.run.leaseEpoch,
    aggregateBudgetRef: 'researchToolBudget',
    steps: input.plan.steps.map((step) => coordinatorStep(step, 0, input.run.leaseEpoch, null)),
    stepHistory: [],
    inbox: [],
    appliedInboxSequence: 0,
    cancellation: { state: 'none' },
    events: [],
  };
  const appended = appendEvent(metadata, coordinator, input.run.eventSequence, {
    type: 'plan_admitted',
    stepId: null,
    createdAt: now.toISOString(),
  });
  coordinator = appended.coordinator;
  return {
    metadata: { ...metadata, run: appended.run, durableCoordinator: coordinator },
    coordinator,
  };
}

export function activateDurableResearchCoordinator(input: {
  metadata: unknown;
  run: ResearchRunState;
  deadlineAt: string;
  now?: Date;
}): {
  metadata: Record<string, unknown>;
  coordinator: DurableResearchCoordinatorV1;
  run: ResearchRunState;
} {
  const metadata = researchMetadata(input.metadata);
  const coordinator = requiredCoordinator(metadata);
  if (!validTimestamp(input.deadlineAt)) malformed();
  const steps = coordinator.steps.map((step) => {
    if (step.outcome !== 'reserved' || step.leaseEpoch === input.run.leaseEpoch) {
      return { ...step, deadlineAt: coordinator.deadlineAt ?? input.deadlineAt };
    }
    return {
      ...step,
      deadlineAt: coordinator.deadlineAt ?? input.deadlineAt,
      outcome: step.effect === 'safe_read' ? ('pending' as const) : ('uncertain_effect' as const),
      reservationId: null,
      providerCallId: null,
      failureCode:
        step.effect === 'safe_read'
          ? 'worker_lost_before_commit'
          : 'effect_requires_reconciliation',
    };
  });
  const next = {
    ...coordinator,
    leaseEpoch: input.run.leaseEpoch,
    deadlineAt: coordinator.deadlineAt ?? input.deadlineAt,
    steps,
  };
  return { metadata: { ...metadata, durableCoordinator: next }, coordinator: next, run: input.run };
}

export function reserveDurableResearchStep(input: {
  metadata: unknown;
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch' | 'eventSequence'>;
  reservationId: string;
  providerCallId: string;
  kind: 'dispatch' | 'receipt_reauthorization';
  tool: string;
  toolVersion: string;
  toolInput: Record<string, unknown>;
  now?: Date;
}): {
  metadata: Record<string, unknown>;
  coordinator: DurableResearchCoordinatorV1;
  run: ResearchRunState;
  step: DurableResearchCoordinatorStepV1;
} {
  const metadata = researchMetadata(input.metadata);
  const storedRun = requiredActiveRun(metadata, input.run);
  const coordinator = requiredCoordinator(metadata);
  assertCoordinatorActive(coordinator, input.run.leaseEpoch, input.now ?? new Date());
  const fingerprint = coordinatorFingerprint(input.tool, input.toolVersion, input.toolInput);
  let stepIndex = -1;
  if (input.kind === 'receipt_reauthorization') {
    stepIndex = coordinator.steps.findIndex(
      (step) =>
        step.goalRevision === coordinator.goalRevision &&
        step.effect === 'safe_read' &&
        step.outcome === 'completed' &&
        (step.fingerprint === fingerprint ||
          step.operationRefs.includes(`fingerprint:${fingerprint}`)) &&
        step.allowedCapabilities.includes(input.tool),
    );
  } else {
    stepIndex = nextExecutableStepIndex(coordinator, input.tool);
  }
  if (stepIndex < 0)
    throw new DurableResearchCoordinatorError(
      input.kind === 'receipt_reauthorization'
        ? 'research_step_reauthorization_not_relevant'
        : 'research_step_no_executable_work',
    );
  const current = coordinator.steps[stepIndex]!;
  if (current.effect !== 'safe_read')
    throw new DurableResearchCoordinatorError('research_step_requires_approval_reconciliation');
  if (!current.allowedCapabilities.includes(input.tool))
    throw new DurableResearchCoordinatorError(`research_step_capability_not_ready:${current.id}`);
  if (
    current.outcome === 'reserved' &&
    current.reservationId === input.reservationId &&
    current.providerCallId === input.providerCallId &&
    current.fingerprint === fingerprint
  ) {
    return { metadata, coordinator, run: storedRun, step: current };
  }
  if (input.kind === 'dispatch' && current.outcome === 'reserved')
    throw new DurableResearchCoordinatorError('research_step_attempt_in_flight');
  const step: DurableResearchCoordinatorStepV1 = {
    ...current,
    fingerprint,
    attempt: current.attempt + 1,
    outcome: input.kind === 'dispatch' ? 'reserved' : current.outcome,
    leaseEpoch: input.run.leaseEpoch,
    reservationId: input.reservationId,
    providerCallId: input.providerCallId,
    failureCode: null,
  };
  const steps = [...coordinator.steps];
  steps[stepIndex] = step;
  const appended = appendEvent(metadata, { ...coordinator, steps }, storedRun.eventSequence, {
    type: 'step_reserved',
    stepId: step.id,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
  return {
    metadata: { ...metadata, run: appended.run, durableCoordinator: appended.coordinator },
    coordinator: appended.coordinator,
    run: appended.run,
    step,
  };
}

export function completeDurableResearchStep(input: {
  metadata: unknown;
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>;
  reservationId: string;
  receiptId: string;
  resultRef: string;
  sourceRef?: string;
  now?: Date;
}): {
  metadata: Record<string, unknown>;
  coordinator: DurableResearchCoordinatorV1;
  run: ResearchRunState;
} {
  const metadata = researchMetadata(input.metadata);
  const storedRun = requiredActiveRun(metadata, input.run);
  const coordinator = requiredCoordinator(metadata);
  const index = coordinator.steps.findIndex(
    (step) =>
      step.goalRevision === coordinator.goalRevision &&
      step.reservationId === input.reservationId &&
      step.leaseEpoch === input.run.leaseEpoch,
  );
  if (index < 0) throw new DurableResearchCoordinatorError('research_step_reservation_not_found');
  const current = coordinator.steps[index]!;
  if (current.effect !== 'safe_read')
    throw new DurableResearchCoordinatorError('research_step_effect_mismatch');
  const completedAt = (input.now ?? new Date()).toISOString();
  const sourceRefs = uniqueStrings([
    ...current.sourceRefs,
    input.sourceRef ?? `receipt:${input.receiptId}`,
  ]);
  const step: DurableResearchCoordinatorStepV1 = {
    ...current,
    outcome: 'completed',
    sourceRefs,
    operationRefs: current.fingerprint
      ? uniqueStrings([...current.operationRefs, `fingerprint:${current.fingerprint}`])
      : current.operationRefs,
    resultRef: input.resultRef,
    completedAt,
    failureCode: null,
  };
  const steps = [...coordinator.steps];
  steps[index] = step;
  const appended = appendEvent(metadata, { ...coordinator, steps }, storedRun.eventSequence, {
    type: 'step_completed',
    stepId: step.id,
    createdAt: completedAt,
  });
  return {
    metadata: { ...metadata, run: appended.run, durableCoordinator: appended.coordinator },
    coordinator: appended.coordinator,
    run: appended.run,
  };
}

export function finishDurableResearchReauthorization(input: {
  metadata: unknown;
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>;
  reservationId: string;
  authorized: boolean;
  operationRef: string;
}): {
  metadata: Record<string, unknown>;
  coordinator: DurableResearchCoordinatorV1;
  run: ResearchRunState;
} {
  const metadata = researchMetadata(input.metadata);
  const storedRun = requiredActiveRun(metadata, input.run);
  const coordinator = requiredCoordinator(metadata);
  const index = coordinator.steps.findIndex(
    (step) =>
      step.goalRevision === coordinator.goalRevision &&
      step.outcome === 'completed' &&
      step.reservationId === input.reservationId &&
      step.leaseEpoch === input.run.leaseEpoch,
  );
  if (index < 0)
    throw new DurableResearchCoordinatorError('research_step_reauthorization_not_found');
  const current = coordinator.steps[index]!;
  const step: DurableResearchCoordinatorStepV1 = {
    ...current,
    reservationId: null,
    providerCallId: null,
    operationRefs: uniqueStrings([
      ...current.operationRefs,
      `${input.operationRef}:${input.authorized ? 'authorized' : 'denied'}`,
    ]),
    failureCode: input.authorized ? null : 'canonical_reauthorization_denied',
  };
  const steps = [...coordinator.steps];
  steps[index] = step;
  const next = { ...coordinator, steps };
  return {
    metadata: { ...metadata, durableCoordinator: next },
    coordinator: next,
    run: storedRun,
  };
}

export function failDurableResearchStep(input: {
  metadata: unknown;
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>;
  reservationId: string;
  code: string;
  now?: Date;
}): {
  metadata: Record<string, unknown>;
  coordinator: DurableResearchCoordinatorV1;
  run: ResearchRunState;
} {
  const metadata = researchMetadata(input.metadata);
  const storedRun = requiredActiveRun(metadata, input.run);
  const coordinator = requiredCoordinator(metadata);
  const index = coordinator.steps.findIndex(
    (step) =>
      step.goalRevision === coordinator.goalRevision &&
      step.reservationId === input.reservationId &&
      step.leaseEpoch === input.run.leaseEpoch,
  );
  if (index < 0) throw new DurableResearchCoordinatorError('research_step_reservation_not_found');
  const current = coordinator.steps[index]!;
  if (current.outcome === 'completed') return { metadata, coordinator, run: storedRun };
  const hasPriorCompletion =
    current.effect === 'safe_read' && current.completedAt !== null && current.sourceRefs.length > 0;
  const step: DurableResearchCoordinatorStepV1 = {
    ...current,
    outcome: hasPriorCompletion
      ? 'completed'
      : current.effect === 'safe_read'
        ? 'retryable_failure'
        : 'uncertain_effect',
    reservationId: null,
    providerCallId: null,
    failureCode: bounded(input.code, 200),
  };
  const steps = [...coordinator.steps];
  steps[index] = step;
  const appended = appendEvent(metadata, { ...coordinator, steps }, storedRun.eventSequence, {
    type: 'step_failed',
    stepId: step.id,
    createdAt: (input.now ?? new Date()).toISOString(),
    detail: step.failureCode ?? undefined,
  });
  return {
    metadata: { ...metadata, run: appended.run, durableCoordinator: appended.coordinator },
    coordinator: appended.coordinator,
    run: appended.run,
  };
}

export function queueDurableResearchSteering(input: {
  metadata: unknown;
  expectedGoalRevision: number;
  requestId: string;
  message: string;
  now?: Date;
}): {
  metadata: Record<string, unknown>;
  coordinator: DurableResearchCoordinatorV1;
  receipt: DurableResearchSteeringReceiptV1;
  idempotentReplay: boolean;
  run: ResearchRunState;
} {
  const metadata = researchMetadata(input.metadata);
  const run = readResearchRun(metadata);
  const coordinator = requiredCoordinator(metadata);
  if (!run) throw new DurableResearchCoordinatorError('research_run_unavailable');
  const requestId = boundedRequired(input.requestId, 256, 'research_steering_request_id_invalid');
  const message = boundedRequired(input.message, MAX_TEXT, 'research_steering_message_invalid');
  const existing = coordinator.inbox.find((entry) => entry.requestId === requestId);
  if (existing) {
    if (
      existing.message !== message ||
      existing.previousGoalRevision !== input.expectedGoalRevision
    )
      throw new DurableResearchCoordinatorError('research_steering_identity_reused');
    return { metadata, coordinator, receipt: existing, idempotentReplay: true, run };
  }
  if (input.expectedGoalRevision !== coordinator.goalRevision)
    throw new DurableResearchCoordinatorError(
      `research_goal_revision_conflict:${coordinator.goalRevision}`,
    );
  const sequence = Math.max(0, ...coordinator.inbox.map((entry) => entry.sequence)) + 1;
  const receipt: DurableResearchSteeringReceiptV1 = {
    version: 1,
    requestId,
    sequence,
    previousGoalRevision: coordinator.goalRevision,
    goalRevision: coordinator.goalRevision + 1,
    message,
    acceptedAt: (input.now ?? new Date()).toISOString(),
    state: 'pending_safe_boundary',
    appliedAt: null,
  };
  const next = {
    ...coordinator,
    goalRevision: receipt.goalRevision,
    inbox: [...coordinator.inbox, receipt].slice(-MAX_INBOX),
  };
  const appended = appendEvent(metadata, next, run.eventSequence, {
    type: 'steering_accepted',
    stepId: null,
    createdAt: receipt.acceptedAt,
    detail: `inbox:${sequence}`,
  });
  return {
    metadata: { ...metadata, run: appended.run, durableCoordinator: appended.coordinator },
    coordinator: appended.coordinator,
    receipt,
    idempotentReplay: false,
    run: appended.run,
  };
}

export function applyDurableResearchReplan(input: {
  metadata: unknown;
  plan: ResearchPlanV1;
  run: ResearchRunState;
  now?: Date;
}): {
  metadata: Record<string, unknown>;
  coordinator: DurableResearchCoordinatorV1;
  run: ResearchRunState;
} {
  const metadata = researchMetadata(input.metadata);
  const coordinator = requiredCoordinator(metadata);
  const pending = coordinator.inbox.filter(
    (message) => message.sequence > coordinator.appliedInboxSequence,
  );
  if (!pending.length) return { metadata, coordinator, run: input.run };
  const now = input.now ?? new Date();
  const appliedThrough = Math.max(...pending.map((message) => message.sequence));
  const inbox = coordinator.inbox.map((message) =>
    message.sequence <= appliedThrough && message.state === 'pending_safe_boundary'
      ? { ...message, state: 'applied' as const, appliedAt: now.toISOString() }
      : message,
  );
  const constraints = uniqueStrings([
    ...coordinator.goal.constraints,
    ...pending.map((message) => message.message),
  ]).slice(-100);
  const archived = coordinator.steps.map((step) =>
    step.outcome === 'completed' || step.outcome === 'uncertain_effect'
      ? step
      : { ...step, outcome: 'superseded' as const, failureCode: 'goal_revision_changed' },
  );
  let next: DurableResearchCoordinatorV1 = {
    ...coordinator,
    planVersion: coordinator.planVersion + 1,
    planSha256: researchJsonSha256(input.plan),
    goal: { ...coordinator.goal, constraints },
    leaseEpoch: input.run.leaseEpoch,
    steps: input.plan.steps.map((step) =>
      coordinatorStep(step, coordinator.goalRevision, input.run.leaseEpoch, coordinator.deadlineAt),
    ),
    stepHistory: [...coordinator.stepHistory, ...archived].slice(-MAX_HISTORY),
    inbox,
    appliedInboxSequence: appliedThrough,
  };
  const appended = appendEvent(metadata, next, input.run.eventSequence, {
    type: 'steering_applied',
    stepId: null,
    createdAt: now.toISOString(),
    detail: `inbox:${appliedThrough}`,
  });
  next = appended.coordinator;
  return {
    metadata: { ...metadata, run: appended.run, durableCoordinator: next },
    coordinator: next,
    run: appended.run,
  };
}

export function requestDurableResearchCancellation(input: {
  metadata: unknown;
  requestId: string;
  reason: string;
  now?: Date;
}): {
  metadata: Record<string, unknown>;
  coordinator: DurableResearchCoordinatorV1;
  run: ResearchRunState;
  idempotentReplay: boolean;
} {
  const metadata = researchMetadata(input.metadata);
  const run = readResearchRun(metadata);
  const coordinator = requiredCoordinator(metadata);
  if (!run) throw new DurableResearchCoordinatorError('research_run_unavailable');
  const requestId = boundedRequired(input.requestId, 256, 'research_cancel_request_id_invalid');
  const reason = boundedRequired(input.reason, 500, 'research_cancel_reason_invalid');
  if (coordinator.cancellation.state !== 'none') {
    if (
      coordinator.cancellation.requestId !== requestId ||
      coordinator.cancellation.reason !== reason
    )
      throw new DurableResearchCoordinatorError('research_cancel_identity_reused');
    return { metadata, coordinator, run, idempotentReplay: true };
  }
  const requestedAt = (input.now ?? new Date()).toISOString();
  const nextRun: ResearchRunState = {
    ...run,
    status: 'cancel_requested',
    stage: 'Cancellation requested; waiting for the worker to stop',
    heartbeatAt: requestedAt,
  };
  const next: DurableResearchCoordinatorV1 = {
    ...coordinator,
    cancellation: { state: 'requested', requestId, reason, requestedAt, observedAt: null },
  };
  const appended = appendEvent(
    metadata,
    next,
    run.eventSequence,
    {
      type: 'cancel_requested',
      stepId: null,
      createdAt: requestedAt,
    },
    nextRun,
  );
  return {
    metadata: { ...metadata, run: appended.run, durableCoordinator: appended.coordinator },
    coordinator: appended.coordinator,
    run: appended.run,
    idempotentReplay: false,
  };
}

export function observeDurableResearchCancellation(input: { metadata: unknown; now?: Date }): {
  metadata: Record<string, unknown>;
  coordinator: DurableResearchCoordinatorV1;
  run: ResearchRunState;
} {
  const metadata = researchMetadata(input.metadata);
  const run = readResearchRun(metadata);
  const coordinator = requiredCoordinator(metadata);
  if (!run || coordinator.cancellation.state !== 'requested')
    throw new DurableResearchCoordinatorError('research_cancellation_not_requested');
  const observedAt = (input.now ?? new Date()).toISOString();
  const steps = coordinator.steps.map((step) =>
    step.outcome === 'completed' || step.outcome === 'uncertain_effect'
      ? step
      : { ...step, outcome: 'cancelled' as const, failureCode: 'cancelled' },
  );
  const nextRun: ResearchRunState = {
    ...run,
    status: 'cancelled',
    stage: 'Research stopped at your request',
    heartbeatAt: observedAt,
    finishedAt: observedAt,
  };
  const next: DurableResearchCoordinatorV1 = {
    ...coordinator,
    steps,
    cancellation: { ...coordinator.cancellation, state: 'observed', observedAt },
  };
  const appended = appendEvent(
    metadata,
    next,
    run.eventSequence,
    {
      type: 'cancelled',
      stepId: null,
      createdAt: observedAt,
    },
    nextRun,
  );
  return {
    metadata: { ...metadata, run: appended.run, durableCoordinator: appended.coordinator },
    coordinator: appended.coordinator,
    run: appended.run,
  };
}

/**
 * Release D: a job's approval step is a proposal card, never executed by the
 * research run. These record the posted proposal and settle the step from the
 * proposal's own outcome. Neither needs a lease: the run is terminal by then,
 * and execution stays with the proposal authority (approveAndExecute).
 */
function currentApprovalStepIndex(
  coordinator: DurableResearchCoordinatorV1,
  stepId: string,
): number {
  const index = coordinator.steps.findIndex(
    (step) =>
      step.id === stepId &&
      step.goalRevision === coordinator.goalRevision &&
      step.effect === 'approval_required',
  );
  if (index < 0) throw new DurableResearchCoordinatorError('research_approval_step_not_found');
  return index;
}

const PROPOSAL_REF = /^proposal:([^:]+)$/;

export function recordDurableResearchApprovalProposal(input: {
  metadata: unknown;
  stepId: string;
  proposalId: string;
}): { metadata: Record<string, unknown>; coordinator: DurableResearchCoordinatorV1 } {
  const metadata = researchMetadata(input.metadata);
  const coordinator = requiredCoordinator(metadata);
  const index = currentApprovalStepIndex(coordinator, input.stepId);
  const current = coordinator.steps[index]!;
  if (current.outcome !== 'waiting_for_approval')
    throw new DurableResearchCoordinatorError('research_approval_step_not_waiting');
  const ref = `proposal:${input.proposalId}`;
  const existing = current.operationRefs.find((value) => PROPOSAL_REF.test(value));
  if (existing === ref) return { metadata, coordinator };
  if (existing)
    throw new DurableResearchCoordinatorError('research_approval_proposal_already_recorded');
  const steps = [...coordinator.steps];
  steps[index] = { ...current, operationRefs: [...current.operationRefs, ref] };
  const next = { ...coordinator, steps };
  return { metadata: { ...metadata, durableCoordinator: next }, coordinator: next };
}

/** The proposal posted for a step, if any. */
export function approvalStepProposalId(step: DurableResearchCoordinatorStepV1): string | null {
  for (const value of step.operationRefs) {
    const match = PROPOSAL_REF.exec(value);
    if (match) return match[1]!;
  }
  return null;
}

const APPROVAL_SETTLEMENT: Partial<
  Record<string, { outcome: DurableResearchStepOutcome; failureCode: string | null }>
> = {
  succeeded: { outcome: 'completed', failureCode: null },
  dismissed: { outcome: 'cancelled', failureCode: 'approval_dismissed' },
  expired: { outcome: 'cancelled', failureCode: 'approval_expired' },
  blocked: { outcome: 'cancelled', failureCode: 'approval_blocked' },
  failed_terminal: { outcome: 'cancelled', failureCode: 'approval_execution_failed' },
  outcome_unknown: { outcome: 'uncertain_effect', failureCode: 'approval_outcome_unknown' },
};

export function settleDurableResearchApprovalStep(input: {
  metadata: unknown;
  stepId: string;
  proposalId: string;
  proposalStatus: string;
  now?: Date;
}): {
  metadata: Record<string, unknown>;
  coordinator: DurableResearchCoordinatorV1;
  changed: boolean;
} {
  const metadata = researchMetadata(input.metadata);
  const coordinator = requiredCoordinator(metadata);
  const index = currentApprovalStepIndex(coordinator, input.stepId);
  const current = coordinator.steps[index]!;
  if (approvalStepProposalId(current) !== input.proposalId)
    throw new DurableResearchCoordinatorError('research_approval_proposal_mismatch');
  const settlement = APPROVAL_SETTLEMENT[input.proposalStatus];
  if (current.outcome !== 'waiting_for_approval' || !settlement)
    return { metadata, coordinator, changed: false };
  const settledAt = (input.now ?? new Date()).toISOString();
  const steps = [...coordinator.steps];
  steps[index] = {
    ...current,
    outcome: settlement.outcome,
    failureCode: settlement.failureCode,
    operationRefs: uniqueStrings([
      ...current.operationRefs,
      `proposal:${input.proposalId}:${input.proposalStatus}`,
    ]),
    completedAt: settlement.outcome === 'completed' ? settledAt : current.completedAt,
  };
  const run = readResearchRun(metadata);
  if (!run) throw new DurableResearchCoordinatorError('research_run_unavailable');
  const appended = appendEvent(
    metadata,
    { ...coordinator, steps },
    run.eventSequence,
    {
      type: settlement.outcome === 'completed' ? 'step_completed' : 'step_failed',
      stepId: current.id,
      createdAt: settledAt,
      detail: `proposal:${input.proposalStatus}`,
    },
    run,
  );
  return {
    metadata: { ...metadata, run: appended.run, durableCoordinator: appended.coordinator },
    coordinator: appended.coordinator,
    changed: true,
  };
}

export function publicDurableResearchCoordinator(
  coordinator: DurableResearchCoordinatorV1,
): Record<string, unknown> {
  return {
    version: 1,
    planVersion: coordinator.planVersion,
    goalRevision: coordinator.goalRevision,
    goal: coordinator.goal,
    deadlineAt: coordinator.deadlineAt,
    leaseEpoch: coordinator.leaseEpoch,
    aggregateBudgetRef: coordinator.aggregateBudgetRef,
    cancellation: coordinator.cancellation,
    steps: coordinator.steps.map((step) => ({
      id: step.id,
      objective: step.objective,
      dependsOn: step.dependsOn,
      goalRevision: step.goalRevision,
      effect: step.effect,
      attempt: step.attempt,
      deadlineAt: step.deadlineAt,
      outcome: step.outcome,
      sourceRefs: step.sourceRefs,
      operationRefs: step.operationRefs.filter((ref) => !ref.startsWith('fingerprint:')),
      leaseEpoch: step.leaseEpoch,
      completedAt: step.completedAt,
      failureCode: step.failureCode,
    })),
  };
}

function coordinatorStep(
  step: ResearchPlanStepV1,
  goalRevision: number,
  leaseEpoch: number,
  deadlineAt: string | null,
): DurableResearchCoordinatorStepV1 {
  return {
    id: step.id,
    objective: step.objective,
    dependsOn: [...step.dependsOn],
    goalRevision,
    effect: step.effect === 'read' ? 'safe_read' : 'approval_required',
    allowedCapabilities: [...step.allowedCapabilities],
    fingerprint: null,
    attempt: 0,
    deadlineAt,
    outcome: step.effect === 'read' ? 'pending' : 'waiting_for_approval',
    sourceRefs: [],
    operationRefs: [],
    resultRef: null,
    leaseEpoch,
    reservationId: null,
    providerCallId: null,
    completedAt: null,
    failureCode: null,
  };
}

function nextExecutableStepIndex(coordinator: DurableResearchCoordinatorV1, tool: string): number {
  const completed = new Set(
    coordinator.steps
      .filter(
        (step) => step.goalRevision === coordinator.goalRevision && step.outcome === 'completed',
      )
      .map((step) => step.id),
  );
  // Only safe reads are executable here; an approval step is a proposal that
  // research never executes, so routing a read to it can only be refused.
  const ready = coordinator.steps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        step.goalRevision === coordinator.goalRevision &&
        step.effect === 'safe_read' &&
        ['pending', 'retryable_failure', 'reserved', 'uncertain_effect'].includes(step.outcome) &&
        step.dependsOn.every((dependency) => completed.has(dependency)),
    );
  const matched = ready.find(({ step }) => step.allowedCapabilities.includes(tool));
  if (matched) return matched.index;
  // A further read for a step that already completed (another of its sources,
  // or a source a bounded child read first) re-reads that step. A failed
  // re-read restores the earlier completion. Only a tool whose step is not yet
  // reachable is refused, so dependency order still holds for first reads.
  for (let index = coordinator.steps.length - 1; index >= 0; index -= 1) {
    const step = coordinator.steps[index]!;
    if (
      step.goalRevision === coordinator.goalRevision &&
      step.outcome === 'completed' &&
      step.effect === 'safe_read' &&
      step.allowedCapabilities.includes(tool)
    )
      return index;
  }
  if (ready.length) return ready[0]!.index;
  return -1;
}

function coordinatorFingerprint(
  tool: string,
  toolVersion: string,
  input: Record<string, unknown>,
): string {
  return `sha256:${researchJsonSha256({ tool, toolVersion, input })}`;
}

function assertCoordinatorActive(
  coordinator: DurableResearchCoordinatorV1,
  leaseEpoch: number,
  now: Date,
): void {
  if (coordinator.leaseEpoch !== leaseEpoch)
    throw new DurableResearchCoordinatorError('research_coordinator_lease_epoch_changed');
  if (coordinator.cancellation.state !== 'none')
    throw new DurableResearchCoordinatorError('research_cancel_requested');
  if (coordinator.deadlineAt && Date.parse(coordinator.deadlineAt) <= now.getTime())
    throw new DurableResearchCoordinatorError('research_deadline_exceeded');
  if (coordinator.inbox.some((message) => message.state === 'pending_safe_boundary'))
    throw new DurableResearchCoordinatorError('research_goal_revision_changed');
}

function appendEvent(
  metadata: Record<string, unknown>,
  coordinator: DurableResearchCoordinatorV1,
  eventSequence: number,
  input: Omit<
    DurableResearchCoordinatorEventV1,
    'version' | 'sequence' | 'goalRevision' | 'planVersion'
  >,
  suppliedRun?: ResearchRunState,
): { coordinator: DurableResearchCoordinatorV1; run: ResearchRunState } {
  const run = suppliedRun ?? readResearchRun(metadata);
  if (!run) throw new DurableResearchCoordinatorError('research_run_unavailable');
  const sequence =
    Math.max(
      eventSequence,
      run.eventSequence,
      ...coordinator.events.map((event) => event.sequence),
    ) + 1;
  const event: DurableResearchCoordinatorEventV1 = {
    version: 1,
    sequence,
    goalRevision: coordinator.goalRevision,
    planVersion: coordinator.planVersion,
    ...input,
  };
  return {
    coordinator: { ...coordinator, events: [...coordinator.events, event].slice(-MAX_EVENTS) },
    run: { ...run, eventSequence: sequence },
  };
}

function requiredCoordinator(metadata: unknown): DurableResearchCoordinatorV1 {
  const coordinator = readDurableResearchCoordinator(metadata);
  if (!coordinator) throw new DurableResearchCoordinatorError('research_coordinator_unavailable');
  return coordinator;
}

function requiredActiveRun(
  metadata: unknown,
  expected: Pick<ResearchRunState, 'id' | 'leaseEpoch'>,
): ResearchRunState {
  const run = readResearchRun(metadata);
  if (
    !run ||
    run.status !== 'running' ||
    run.id !== expected.id ||
    run.leaseEpoch !== expected.leaseEpoch
  )
    throw new DurableResearchCoordinatorError('research_lease_inactive');
  return run;
}

function parseStep(value: unknown): DurableResearchCoordinatorStepV1 {
  if (!isRecord(value)) malformed();
  if (
    typeof value.id !== 'string' ||
    typeof value.objective !== 'string' ||
    !stringArray(value.dependsOn) ||
    !nonNegativeInteger(value.goalRevision) ||
    !['safe_read', 'approval_required'].includes(String(value.effect)) ||
    !stringArray(value.allowedCapabilities) ||
    !(value.fingerprint === null || typeof value.fingerprint === 'string') ||
    !nonNegativeInteger(value.attempt) ||
    !(value.deadlineAt === null || validTimestamp(value.deadlineAt)) ||
    ![
      'pending',
      'reserved',
      'completed',
      'retryable_failure',
      'waiting_for_approval',
      'uncertain_effect',
      'superseded',
      'cancelled',
    ].includes(String(value.outcome)) ||
    !stringArray(value.sourceRefs) ||
    !stringArray(value.operationRefs) ||
    !(value.resultRef === null || typeof value.resultRef === 'string') ||
    !nonNegativeInteger(value.leaseEpoch) ||
    !(value.reservationId === null || typeof value.reservationId === 'string') ||
    !(value.providerCallId === null || typeof value.providerCallId === 'string') ||
    !(value.completedAt === null || validTimestamp(value.completedAt)) ||
    !(value.failureCode === null || typeof value.failureCode === 'string')
  )
    malformed();
  return { ...(value as unknown as DurableResearchCoordinatorStepV1) };
}

function parseSteering(value: unknown): DurableResearchSteeringReceiptV1 {
  if (!isRecord(value)) malformed();
  if (
    value.version !== 1 ||
    typeof value.requestId !== 'string' ||
    !positiveInteger(value.sequence) ||
    !nonNegativeInteger(value.previousGoalRevision) ||
    !positiveInteger(value.goalRevision) ||
    typeof value.message !== 'string' ||
    !validTimestamp(value.acceptedAt) ||
    !['pending_safe_boundary', 'applied'].includes(String(value.state)) ||
    !(value.appliedAt === null || validTimestamp(value.appliedAt))
  )
    malformed();
  return { ...(value as unknown as DurableResearchSteeringReceiptV1) };
}

function parseEvent(value: unknown): DurableResearchCoordinatorEventV1 {
  if (!isRecord(value)) malformed();
  if (
    value.version !== 1 ||
    !positiveInteger(value.sequence) ||
    ![
      'plan_admitted',
      'step_reserved',
      'step_completed',
      'step_failed',
      'steering_accepted',
      'steering_applied',
      'cancel_requested',
      'cancelled',
    ].includes(String(value.type)) ||
    !nonNegativeInteger(value.goalRevision) ||
    !positiveInteger(value.planVersion) ||
    !(value.stepId === null || typeof value.stepId === 'string') ||
    !validTimestamp(value.createdAt) ||
    !(value.detail === undefined || typeof value.detail === 'string')
  )
    malformed();
  return { ...(value as unknown as DurableResearchCoordinatorEventV1) };
}

function parseCancellation(
  raw: Record<string, unknown>,
): DurableResearchCoordinatorV1['cancellation'] {
  if (raw.state === 'none') return { state: 'none' };
  if (
    !['requested', 'observed'].includes(String(raw.state)) ||
    typeof raw.requestId !== 'string' ||
    typeof raw.reason !== 'string' ||
    !validTimestamp(raw.requestedAt) ||
    !(raw.observedAt === null || validTimestamp(raw.observedAt))
  )
    malformed();
  return {
    state: raw.state as 'requested' | 'observed',
    requestId: raw.requestId,
    reason: raw.reason,
    requestedAt: raw.requestedAt as string,
    observedAt: raw.observedAt as string | null,
  };
}

function bounded(value: string, max = MAX_TEXT): string {
  return value.trim().slice(0, max);
}

function boundedRequired(value: unknown, max: number, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new DurableResearchCoordinatorError(code);
  return value.trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function malformed(): never {
  throw new DurableResearchCoordinatorError('research_coordinator_malformed');
}
