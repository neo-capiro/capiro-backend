import { randomUUID } from 'node:crypto';
import type { ResearchPlanV1 } from './meri-research-plan.js';
import { canonicalResearchJson, researchJsonSha256 } from './meri-research-durable-result.js';
import { readDurableResearchStepReceipts } from './meri-research-durable-step.js';
import { researchMetadata, type ResearchRunState } from './meri-research-run-state.js';

export const RESEARCH_TOOL_BUDGET_VERSION = 1 as const;
export const MAX_RESEARCH_TOOL_ATTEMPTS = 48;
export const RESEARCH_PROVIDER_BUDGET_VERSION = 1 as const;
export const MAX_RESEARCH_PROVIDER_ATTEMPTS = 64;
const MAX_ATTEMPT_KEY_CHARS = 500;
const MAX_ID_CHARS = 256;
const MAX_TOOL_CHARS = 160;
const MAX_INPUT_CHARS = 40_000;
const HASH_RE = /^[a-f0-9]{64}$/;
const TOOL_VERSION_RE = /^sha256:[a-f0-9]{64}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{0,159}$/;

export type ResearchToolAttemptKind = 'dispatch' | 'receipt_reauthorization';
export type ResearchToolAttemptOutcome = 'result_committed' | 'replay_authorized' | 'replay_denied';

export interface ResearchToolAttemptReservationV1 {
  version: 1;
  reservationId: string;
  attemptKey: string;
  kind: ResearchToolAttemptKind;
  tool: string;
  toolVersion: string;
  inputSha256: string;
  runId: string;
  leaseEpoch: number;
  status: 'reserved' | 'completed';
  outcome: ResearchToolAttemptOutcome | null;
  reservedAt: string;
  completedAt: string | null;
}

export interface ResearchToolBudgetV1 {
  version: 1;
  limit: number;
  spent: number;
  attempts: ResearchToolAttemptReservationV1[];
}

export interface ResearchToolAttemptBinding {
  providerCallId: string;
  kind: ResearchToolAttemptKind;
  tool: string;
  toolVersion: string;
  input: Record<string, unknown>;
}

const BUDGET_KEYS = ['version', 'limit', 'spent', 'attempts'] as const;
const ATTEMPT_KEYS = [
  'version',
  'reservationId',
  'attemptKey',
  'kind',
  'tool',
  'toolVersion',
  'inputSha256',
  'runId',
  'leaseEpoch',
  'status',
  'outcome',
  'reservedAt',
  'completedAt',
] as const;

export class ResearchToolBudgetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ResearchToolBudgetError';
  }
}

export type ResearchProviderAttemptKind = 'openai_responses' | 'anthropic_messages' | 'jev';

export interface ResearchProviderBudgetLimitsV1 {
  maxAttempts: number;
  maxTokens: number;
  maxCostMicros: number;
  deadlineAt: string;
}

export interface ResearchProviderAttemptV1 {
  version: 1;
  reservationId: string;
  logicalOperationId: string;
  attemptId: string;
  retryOfAttemptId: string | null;
  kind: ResearchProviderAttemptKind;
  phase: string;
  provider: string;
  model: string;
  runId: string;
  leaseEpoch: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedCostMicros: number;
  priceKnown: boolean;
  status: 'reserved' | 'settled' | 'uncertain' | 'rejected';
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  actualCostMicros: number | null;
  reservedAt: string;
  settledAt: string | null;
}

export interface ResearchProviderBudgetV1 {
  version: 1;
  activation: 'enforced';
  limits: ResearchProviderBudgetLimitsV1;
  chargedAttempts: number;
  chargedTokens: number;
  chargedCostMicros: number;
  attempts: ResearchProviderAttemptV1[];
}

export interface ResearchProviderReservationBinding {
  logicalOperationId: string;
  attemptId: string;
  retryOfAttemptId: string | null;
  kind: ResearchProviderAttemptKind;
  phase: string;
  provider: string;
  model: string;
  maxInputTokens: number;
  /** Null reserves every token still available for an otherwise unbounded response. */
  maxOutputTokens: number | null;
}

export interface ResearchProviderPrice {
  inputPerM: number;
  outputPerM: number;
}

const PROVIDER_BUDGET_KEYS = [
  'version',
  'activation',
  'limits',
  'chargedAttempts',
  'chargedTokens',
  'chargedCostMicros',
  'attempts',
] as const;
const PROVIDER_LIMIT_KEYS = ['maxAttempts', 'maxTokens', 'maxCostMicros', 'deadlineAt'] as const;
const PROVIDER_ATTEMPT_KEYS = [
  'version',
  'reservationId',
  'logicalOperationId',
  'attemptId',
  'retryOfAttemptId',
  'kind',
  'phase',
  'provider',
  'model',
  'runId',
  'leaseEpoch',
  'reservedInputTokens',
  'reservedOutputTokens',
  'reservedCostMicros',
  'priceKnown',
  'status',
  'actualInputTokens',
  'actualOutputTokens',
  'actualCostMicros',
  'reservedAt',
  'settledAt',
] as const;
const LEGACY_PROVIDER_ATTEMPT_KEYS = PROVIDER_ATTEMPT_KEYS.filter(
  (key) => key !== 'logicalOperationId' && key !== 'retryOfAttemptId',
);

export class ResearchProviderBudgetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ResearchProviderBudgetError';
  }
}

export function readResearchProviderBudget(value: unknown): ResearchProviderBudgetV1 | null {
  const raw = researchMetadata(value).researchProviderBudget;
  if (raw === undefined) return null;
  if (!isRecord(raw) || !exactKeys(raw, PROVIDER_BUDGET_KEYS)) providerMalformed();
  if (
    raw.version !== RESEARCH_PROVIDER_BUDGET_VERSION ||
    raw.activation !== 'enforced' ||
    !isRecord(raw.limits) ||
    !exactKeys(raw.limits, PROVIDER_LIMIT_KEYS) ||
    !positiveBoundedInteger(raw.limits.maxAttempts) ||
    raw.limits.maxAttempts > MAX_RESEARCH_PROVIDER_ATTEMPTS ||
    !positiveBoundedInteger(raw.limits.maxTokens) ||
    !positiveBoundedInteger(raw.limits.maxCostMicros) ||
    typeof raw.limits.deadlineAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.limits.deadlineAt)) ||
    !nonNegativeInteger(raw.chargedAttempts) ||
    !nonNegativeInteger(raw.chargedTokens) ||
    !nonNegativeInteger(raw.chargedCostMicros) ||
    !Array.isArray(raw.attempts) ||
    raw.attempts.length > MAX_RESEARCH_PROVIDER_ATTEMPTS
  )
    providerMalformed();
  const attempts = raw.attempts.map(parseProviderAttempt);
  if (
    raw.chargedAttempts !== attempts.length ||
    raw.chargedAttempts > raw.limits.maxAttempts ||
    raw.chargedTokens > raw.limits.maxTokens ||
    raw.chargedCostMicros > raw.limits.maxCostMicros ||
    new Set(attempts.map((attempt) => attempt.reservationId)).size !== attempts.length ||
    new Set(attempts.map((attempt) => attempt.attemptId)).size !== attempts.length
  )
    providerMalformed();
  return {
    version: 1,
    activation: 'enforced',
    limits: { ...(raw.limits as unknown as ResearchProviderBudgetLimitsV1) },
    chargedAttempts: raw.chargedAttempts,
    chargedTokens: raw.chargedTokens,
    chargedCostMicros: raw.chargedCostMicros,
    attempts,
  };
}

/** First server admission fixes the absolute deadline and ceilings; later calls may only narrow. */
export function admitResearchProviderBudget(
  value: unknown,
  requested: ResearchProviderBudgetLimitsV1,
): { metadata: Record<string, unknown>; budget: ResearchProviderBudgetV1 } {
  validateProviderLimits(requested);
  const metadata = researchMetadata(value);
  const current = readResearchProviderBudget(metadata);
  if (current) {
    const limits = {
      maxAttempts: Math.min(current.limits.maxAttempts, requested.maxAttempts),
      maxTokens: Math.min(current.limits.maxTokens, requested.maxTokens),
      maxCostMicros: Math.min(current.limits.maxCostMicros, requested.maxCostMicros),
      deadlineAt:
        Date.parse(current.limits.deadlineAt) <= Date.parse(requested.deadlineAt)
          ? current.limits.deadlineAt
          : requested.deadlineAt,
    };
    if (
      current.chargedAttempts > limits.maxAttempts ||
      current.chargedTokens > limits.maxTokens ||
      current.chargedCostMicros > limits.maxCostMicros
    )
      throw new ResearchProviderBudgetError('research_provider_budget_replan_below_spend');
    const budget = { ...current, limits };
    return { metadata: { ...metadata, researchProviderBudget: budget }, budget };
  }
  const budget: ResearchProviderBudgetV1 = {
    version: 1,
    activation: 'enforced',
    limits: { ...requested },
    chargedAttempts: 0,
    chargedTokens: 0,
    chargedCostMicros: 0,
    attempts: [],
  };
  return { metadata: { ...metadata, researchProviderBudget: budget }, budget };
}

export function reserveResearchProviderAttempt(input: {
  metadata: unknown;
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>;
  limits: ResearchProviderBudgetLimitsV1;
  binding: ResearchProviderReservationBinding;
  price: ResearchProviderPrice | null;
  now?: Date;
  reservationId?: string;
}) {
  validateProviderBinding(input.binding);
  const now = input.now ?? new Date();
  const admitted = admitResearchProviderBudget(input.metadata, input.limits);
  if (now.getTime() >= Date.parse(admitted.budget.limits.deadlineAt))
    throw new ResearchProviderBudgetError('research_provider_budget_deadline');
  const existing = admitted.budget.attempts.find(
    (attempt) => attempt.attemptId === input.binding.attemptId,
  );
  if (existing) {
    assertSameProviderBinding(existing, input.binding);
    return {
      metadata: admitted.metadata,
      budget: admitted.budget,
      reservation: existing,
      dispatchAllowed: false,
    };
  }
  const operationAttempts = admitted.budget.attempts.filter(
    (attempt) => attempt.logicalOperationId === input.binding.logicalOperationId,
  );
  if (input.binding.retryOfAttemptId === null) {
    if (operationAttempts.length > 0)
      throw new ResearchProviderBudgetError('research_provider_budget_operation_recovery_required');
  } else {
    const predecessor = operationAttempts.find(
      (attempt) => attempt.attemptId === input.binding.retryOfAttemptId,
    );
    if (!predecessor)
      throw new ResearchProviderBudgetError('research_provider_budget_retry_predecessor_not_found');
    if (operationAttempts.at(-1)?.attemptId !== predecessor.attemptId)
      throw new ResearchProviderBudgetError('research_provider_budget_retry_predecessor_stale');
    if (!['uncertain', 'rejected'].includes(predecessor.status))
      throw new ResearchProviderBudgetError(
        'research_provider_budget_retry_predecessor_not_retryable',
      );
  }
  if (admitted.budget.chargedAttempts >= admitted.budget.limits.maxAttempts)
    throw new ResearchProviderBudgetError('research_provider_budget_attempts_exhausted');
  const remainingTokens = admitted.budget.limits.maxTokens - admitted.budget.chargedTokens;
  const outputTokens =
    input.binding.maxOutputTokens ?? Math.max(0, remainingTokens - input.binding.maxInputTokens);
  const reservedTokens = input.binding.maxInputTokens + outputTokens;
  if (reservedTokens <= 0 || reservedTokens > remainingTokens)
    throw new ResearchProviderBudgetError('research_provider_budget_tokens_exhausted');
  const remainingCost = admitted.budget.limits.maxCostMicros - admitted.budget.chargedCostMicros;
  const reservedCostMicros = input.price
    ? providerCostMicros(input.price, input.binding.maxInputTokens, outputTokens)
    : remainingCost;
  if (reservedCostMicros <= 0 || reservedCostMicros > remainingCost)
    throw new ResearchProviderBudgetError('research_provider_budget_cost_exhausted');
  const reservation: ResearchProviderAttemptV1 = {
    version: 1,
    reservationId: boundedId(input.reservationId) ? input.reservationId : randomUUID(),
    logicalOperationId: input.binding.logicalOperationId,
    attemptId: input.binding.attemptId,
    retryOfAttemptId: input.binding.retryOfAttemptId,
    kind: input.binding.kind,
    phase: input.binding.phase,
    provider: input.binding.provider,
    model: input.binding.model,
    runId: input.run.id,
    leaseEpoch: input.run.leaseEpoch,
    reservedInputTokens: input.binding.maxInputTokens,
    reservedOutputTokens: outputTokens,
    reservedCostMicros,
    priceKnown: input.price !== null,
    status: 'reserved',
    actualInputTokens: null,
    actualOutputTokens: null,
    actualCostMicros: null,
    reservedAt: now.toISOString(),
    settledAt: null,
  };
  const budget: ResearchProviderBudgetV1 = {
    ...admitted.budget,
    chargedAttempts: admitted.budget.chargedAttempts + 1,
    chargedTokens: admitted.budget.chargedTokens + reservedTokens,
    chargedCostMicros: admitted.budget.chargedCostMicros + reservedCostMicros,
    attempts: [...admitted.budget.attempts, reservation],
  };
  return {
    metadata: { ...admitted.metadata, researchProviderBudget: budget },
    budget,
    reservation,
    dispatchAllowed: true,
  };
}

export function settleResearchProviderAttempt(input: {
  metadata: unknown;
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>;
  reservationId: string;
  binding: Omit<ResearchProviderReservationBinding, 'maxInputTokens' | 'maxOutputTokens'>;
  outcome:
    | {
        kind: 'known';
        inputTokens: number;
        outputTokens: number;
        price: ResearchProviderPrice | null;
      }
    | { kind: 'rejected' }
    | { kind: 'uncertain' };
  now?: Date;
}) {
  const metadata = researchMetadata(input.metadata);
  const budget = readResearchProviderBudget(metadata);
  if (!budget) providerMalformed();
  const index = budget.attempts.findIndex(
    (attempt) => attempt.reservationId === input.reservationId,
  );
  if (index < 0)
    throw new ResearchProviderBudgetError('research_provider_budget_reservation_not_found');
  const current = budget.attempts[index]!;
  if (
    current.runId !== input.run.id ||
    current.leaseEpoch !== input.run.leaseEpoch ||
    current.logicalOperationId !== input.binding.logicalOperationId ||
    current.attemptId !== input.binding.attemptId ||
    current.retryOfAttemptId !== input.binding.retryOfAttemptId ||
    current.kind !== input.binding.kind ||
    current.phase !== input.binding.phase ||
    current.provider !== input.binding.provider ||
    current.model !== input.binding.model
  )
    throw new ResearchProviderBudgetError('research_provider_budget_reservation_binding_changed');
  const targetStatus =
    input.outcome.kind === 'known'
      ? 'settled'
      : input.outcome.kind === 'rejected'
        ? 'rejected'
        : 'uncertain';
  if (current.status !== 'reserved') {
    if (current.status !== targetStatus)
      throw new ResearchProviderBudgetError('research_provider_budget_outcome_changed');
    if (
      input.outcome.kind === 'known' &&
      (current.actualInputTokens !== input.outcome.inputTokens ||
        current.actualOutputTokens !== input.outcome.outputTokens)
    )
      throw new ResearchProviderBudgetError('research_provider_budget_usage_changed');
    return { metadata, budget, reservation: current };
  }
  let chargedTokens = budget.chargedTokens;
  let chargedCostMicros = budget.chargedCostMicros;
  let actualInputTokens: number | null = null;
  let actualOutputTokens: number | null = null;
  let actualCostMicros: number | null = null;
  if (input.outcome.kind === 'rejected') {
    chargedTokens -= current.reservedInputTokens + current.reservedOutputTokens;
    chargedCostMicros -= current.reservedCostMicros;
    actualInputTokens = 0;
    actualOutputTokens = 0;
    actualCostMicros = 0;
  } else if (input.outcome.kind === 'known') {
    if (
      !nonNegativeInteger(input.outcome.inputTokens) ||
      !nonNegativeInteger(input.outcome.outputTokens) ||
      input.outcome.inputTokens > current.reservedInputTokens ||
      input.outcome.outputTokens > current.reservedOutputTokens
    )
      throw new ResearchProviderBudgetError('research_provider_budget_usage_exceeds_reservation');
    actualInputTokens = input.outcome.inputTokens;
    actualOutputTokens = input.outcome.outputTokens;
    chargedTokens -=
      current.reservedInputTokens +
      current.reservedOutputTokens -
      input.outcome.inputTokens -
      input.outcome.outputTokens;
    if (input.outcome.price) {
      actualCostMicros = providerCostMicros(
        input.outcome.price,
        input.outcome.inputTokens,
        input.outcome.outputTokens,
      );
      if (actualCostMicros > current.reservedCostMicros)
        throw new ResearchProviderBudgetError('research_provider_budget_cost_exceeds_reservation');
      chargedCostMicros -= current.reservedCostMicros - actualCostMicros;
    }
    // Unknown pricing deliberately retains the full cost reservation.
  }
  const reservation: ResearchProviderAttemptV1 = {
    ...current,
    status: targetStatus,
    actualInputTokens,
    actualOutputTokens,
    actualCostMicros,
    settledAt: (input.now ?? new Date()).toISOString(),
  };
  const attempts = [...budget.attempts];
  attempts[index] = reservation;
  const nextBudget = { ...budget, chargedTokens, chargedCostMicros, attempts };
  return {
    metadata: { ...metadata, researchProviderBudget: nextBudget },
    budget: nextBudget,
    reservation,
  };
}

export function readResearchToolBudget(value: unknown): ResearchToolBudgetV1 | null {
  const raw = researchMetadata(value).researchToolBudget;
  if (raw === undefined) return null;
  if (!isRecord(raw) || !exactKeys(raw, BUDGET_KEYS)) malformed();
  if (
    raw.version !== RESEARCH_TOOL_BUDGET_VERSION ||
    !positiveBoundedInteger(raw.limit) ||
    raw.limit > MAX_RESEARCH_TOOL_ATTEMPTS ||
    !nonNegativeInteger(raw.spent) ||
    raw.spent > MAX_RESEARCH_TOOL_ATTEMPTS ||
    !Array.isArray(raw.attempts) ||
    raw.attempts.length > MAX_RESEARCH_TOOL_ATTEMPTS ||
    raw.spent !== raw.attempts.length
  )
    malformed();

  const attempts = raw.attempts.map(parseAttempt);
  if (new Set(attempts.map((attempt) => attempt.reservationId)).size !== attempts.length)
    malformed();
  if (new Set(attempts.map((attempt) => attempt.attemptKey)).size !== attempts.length) malformed();
  return { version: 1, limit: raw.limit, spent: raw.spent, attempts };
}

/**
 * Bind the logical task to its first admitted limit. A later accepted plan may
 * narrow that limit, but it cannot restore or enlarge it and never clears spend.
 */
export function admitResearchToolBudget(
  value: unknown,
  planToolCalls: number,
): { metadata: Record<string, unknown>; budget: ResearchToolBudgetV1 } {
  if (!positiveBoundedInteger(planToolCalls) || planToolCalls > MAX_RESEARCH_TOOL_ATTEMPTS)
    throw new ResearchToolBudgetError('research_tool_budget_plan_limit_invalid');
  const metadata = researchMetadata(value);
  const current = readResearchToolBudget(metadata);
  if (current) {
    if (planToolCalls > current.limit)
      throw new ResearchToolBudgetError('research_tool_budget_replan_expansion_denied');
    const budget = planToolCalls === current.limit ? current : { ...current, limit: planToolCalls };
    return { metadata: { ...metadata, researchToolBudget: budget }, budget };
  }

  const attempts = legacyReceiptAttempts(metadata);
  const budget: ResearchToolBudgetV1 = {
    version: 1,
    limit: planToolCalls,
    spent: attempts.length,
    attempts,
  };
  return { metadata: { ...metadata, researchToolBudget: budget }, budget };
}

export function reserveResearchToolAttempt(input: {
  metadata: unknown;
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>;
  plan: ResearchPlanV1;
  binding: ResearchToolAttemptBinding;
  now?: Date;
  reservationId?: string;
}): {
  metadata: Record<string, unknown>;
  budget: ResearchToolBudgetV1;
  reservation: ResearchToolAttemptReservationV1;
  dispatchAllowed: boolean;
} {
  validateBinding(input.binding);
  if (
    !input.plan.steps.some(
      (step) => step.effect === 'read' && step.allowedCapabilities.includes(input.binding.tool),
    )
  )
    throw new ResearchToolBudgetError('research_tool_budget_capability_not_admitted');

  const admitted = admitResearchToolBudget(input.metadata, input.plan.budget.toolCalls);
  const attemptKey = `${input.binding.kind}:${input.binding.providerCallId}`;
  if (attemptKey.length > MAX_ATTEMPT_KEY_CHARS)
    throw new ResearchToolBudgetError('research_tool_budget_attempt_identity_invalid');
  const inputSha256 = researchJsonSha256(input.binding.input);
  if (canonicalResearchJson(input.binding.input).length > MAX_INPUT_CHARS)
    throw new ResearchToolBudgetError('research_tool_budget_input_too_large');
  const existing = admitted.budget.attempts.find((attempt) => attempt.attemptKey === attemptKey);
  if (existing) {
    assertSameBinding(existing, input.binding, inputSha256);
    return {
      metadata: admitted.metadata,
      budget: admitted.budget,
      reservation: existing,
      dispatchAllowed: false,
    };
  }
  if (
    admitted.budget.spent >= admitted.budget.limit ||
    admitted.budget.attempts.length >= MAX_RESEARCH_TOOL_ATTEMPTS
  )
    throw new ResearchToolBudgetError('research_tool_budget_exhausted');

  const reservedAt = (input.now ?? new Date()).toISOString();
  if (!Number.isFinite(Date.parse(reservedAt))) malformed();
  const reservation: ResearchToolAttemptReservationV1 = {
    version: 1,
    reservationId: boundedId(input.reservationId) ? input.reservationId : randomUUID(),
    attemptKey,
    kind: input.binding.kind,
    tool: input.binding.tool,
    toolVersion: input.binding.toolVersion,
    inputSha256,
    runId: input.run.id,
    leaseEpoch: input.run.leaseEpoch,
    status: 'reserved',
    outcome: null,
    reservedAt,
    completedAt: null,
  };
  if (
    admitted.budget.attempts.some((attempt) => attempt.reservationId === reservation.reservationId)
  )
    throw new ResearchToolBudgetError('research_tool_budget_reservation_identity_reused');
  const budget: ResearchToolBudgetV1 = {
    ...admitted.budget,
    spent: admitted.budget.spent + 1,
    attempts: [...admitted.budget.attempts, reservation],
  };
  return {
    metadata: { ...admitted.metadata, researchToolBudget: budget },
    budget,
    reservation,
    dispatchAllowed: true,
  };
}

export function completeResearchToolAttempt(input: {
  metadata: unknown;
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>;
  reservationId: string;
  binding: Omit<ResearchToolAttemptBinding, 'providerCallId'>;
  outcome: ResearchToolAttemptOutcome;
  now?: Date;
}): {
  metadata: Record<string, unknown>;
  budget: ResearchToolBudgetV1;
  reservation: ResearchToolAttemptReservationV1;
} {
  const metadata = researchMetadata(input.metadata);
  const budget = readResearchToolBudget(metadata);
  if (!budget) malformed();
  const index = budget.attempts.findIndex(
    (attempt) => attempt.reservationId === input.reservationId,
  );
  if (index < 0) throw new ResearchToolBudgetError('research_tool_budget_reservation_not_found');
  const current = budget.attempts[index]!;
  const inputSha256 = researchJsonSha256(input.binding.input);
  if (
    current.runId !== input.run.id ||
    current.leaseEpoch !== input.run.leaseEpoch ||
    current.kind !== input.binding.kind ||
    current.tool !== input.binding.tool ||
    current.toolVersion !== input.binding.toolVersion ||
    current.inputSha256 !== inputSha256
  )
    throw new ResearchToolBudgetError('research_tool_budget_reservation_binding_changed');
  if (current.status === 'completed') {
    if (current.outcome !== input.outcome)
      throw new ResearchToolBudgetError('research_tool_budget_outcome_changed');
    return { metadata, budget, reservation: current };
  }
  const completedAt = (input.now ?? new Date()).toISOString();
  const reservation: ResearchToolAttemptReservationV1 = {
    ...current,
    status: 'completed',
    outcome: input.outcome,
    completedAt,
  };
  const attempts = [...budget.attempts];
  attempts[index] = reservation;
  const nextBudget = { ...budget, attempts };
  return {
    metadata: { ...metadata, researchToolBudget: nextBudget },
    budget: nextBudget,
    reservation,
  };
}

function legacyReceiptAttempts(value: unknown): ResearchToolAttemptReservationV1[] {
  const receipts = readDurableResearchStepReceipts(value).filter(
    (receipt) =>
      receipt.version === 2 && receipt.executionId && receipt.toolVersion && receipt.inputSha256,
  );
  if (receipts.length > MAX_RESEARCH_TOOL_ATTEMPTS)
    throw new ResearchToolBudgetError('research_tool_budget_legacy_overflow');
  const seen = new Set<string>();
  return receipts.map((receipt) => {
    if (seen.has(receipt.executionId!))
      throw new ResearchToolBudgetError('research_tool_budget_legacy_identity_reused');
    seen.add(receipt.executionId!);
    const attempt: ResearchToolAttemptReservationV1 = {
      version: 1,
      reservationId: receipt.executionId!,
      attemptKey: `legacy:${receipt.executionId}`,
      kind: 'dispatch',
      tool: receipt.tool,
      toolVersion: receipt.toolVersion!,
      inputSha256: receipt.inputSha256!,
      runId: receipt.runId,
      leaseEpoch: receipt.leaseEpoch,
      status: 'completed',
      outcome: 'result_committed',
      reservedAt: receipt.completedAt,
      completedAt: receipt.completedAt,
    };
    return parseAttempt(attempt as unknown as Record<string, unknown>);
  });
}

function parseAttempt(value: unknown): ResearchToolAttemptReservationV1 {
  if (!isRecord(value) || !exactKeys(value, ATTEMPT_KEYS)) malformed();
  if (
    value.version !== 1 ||
    !boundedId(value.reservationId) ||
    !boundedString(value.attemptKey, MAX_ATTEMPT_KEY_CHARS) ||
    !['dispatch', 'receipt_reauthorization'].includes(String(value.kind)) ||
    typeof value.tool !== 'string' ||
    !TOOL_RE.test(value.tool) ||
    typeof value.toolVersion !== 'string' ||
    !TOOL_VERSION_RE.test(value.toolVersion) ||
    typeof value.inputSha256 !== 'string' ||
    !HASH_RE.test(value.inputSha256) ||
    !boundedId(value.runId) ||
    !nonNegativeInteger(value.leaseEpoch) ||
    !['reserved', 'completed'].includes(String(value.status)) ||
    !(
      value.outcome === null ||
      ['result_committed', 'replay_authorized', 'replay_denied'].includes(String(value.outcome))
    ) ||
    typeof value.reservedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.reservedAt)) ||
    !(
      value.completedAt === null ||
      (typeof value.completedAt === 'string' && Number.isFinite(Date.parse(value.completedAt)))
    ) ||
    (value.status === 'reserved' && (value.outcome !== null || value.completedAt !== null)) ||
    (value.status === 'completed' && (value.outcome === null || value.completedAt === null))
  )
    malformed();
  return { ...(value as unknown as ResearchToolAttemptReservationV1) };
}

function validateBinding(binding: ResearchToolAttemptBinding): void {
  if (
    !boundedString(binding.providerCallId, MAX_ID_CHARS) ||
    !['dispatch', 'receipt_reauthorization'].includes(binding.kind) ||
    !TOOL_RE.test(binding.tool) ||
    !TOOL_VERSION_RE.test(binding.toolVersion) ||
    !isRecord(binding.input)
  )
    throw new ResearchToolBudgetError('research_tool_budget_binding_invalid');
}

function assertSameBinding(
  existing: ResearchToolAttemptReservationV1,
  binding: ResearchToolAttemptBinding,
  inputSha256: string,
): void {
  if (
    existing.kind !== binding.kind ||
    existing.tool !== binding.tool ||
    existing.toolVersion !== binding.toolVersion ||
    existing.inputSha256 !== inputSha256
  )
    throw new ResearchToolBudgetError('research_tool_budget_attempt_identity_reused');
}

function parseProviderAttempt(value: unknown): ResearchProviderAttemptV1 {
  if (
    !isRecord(value) ||
    (!exactKeys(value, PROVIDER_ATTEMPT_KEYS) && !exactKeys(value, LEGACY_PROVIDER_ATTEMPT_KEYS))
  )
    providerMalformed();
  const logicalOperationId = value.logicalOperationId ?? value.attemptId;
  const retryOfAttemptId = value.retryOfAttemptId ?? null;
  if (
    value.version !== 1 ||
    !boundedId(value.reservationId) ||
    !boundedString(logicalOperationId, MAX_ATTEMPT_KEY_CHARS) ||
    !boundedString(value.attemptId, MAX_ATTEMPT_KEY_CHARS) ||
    !(retryOfAttemptId === null || boundedString(retryOfAttemptId, MAX_ATTEMPT_KEY_CHARS)) ||
    !['openai_responses', 'anthropic_messages', 'jev'].includes(String(value.kind)) ||
    !boundedString(value.phase, 64) ||
    !boundedString(value.provider, 64) ||
    !boundedString(value.model, 160) ||
    !boundedId(value.runId) ||
    !nonNegativeInteger(value.leaseEpoch) ||
    !nonNegativeInteger(value.reservedInputTokens) ||
    !nonNegativeInteger(value.reservedOutputTokens) ||
    !positiveBoundedInteger(value.reservedCostMicros) ||
    typeof value.priceKnown !== 'boolean' ||
    !['reserved', 'settled', 'uncertain', 'rejected'].includes(String(value.status)) ||
    !(value.actualInputTokens === null || nonNegativeInteger(value.actualInputTokens)) ||
    !(value.actualOutputTokens === null || nonNegativeInteger(value.actualOutputTokens)) ||
    !(value.actualCostMicros === null || nonNegativeInteger(value.actualCostMicros)) ||
    typeof value.reservedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.reservedAt)) ||
    !(
      value.settledAt === null ||
      (typeof value.settledAt === 'string' && Number.isFinite(Date.parse(value.settledAt)))
    ) ||
    (value.status === 'reserved' &&
      (value.actualInputTokens !== null ||
        value.actualOutputTokens !== null ||
        value.actualCostMicros !== null ||
        value.settledAt !== null)) ||
    (value.status !== 'reserved' && value.settledAt === null)
  )
    providerMalformed();
  return {
    ...(value as unknown as ResearchProviderAttemptV1),
    logicalOperationId: String(logicalOperationId),
    retryOfAttemptId: retryOfAttemptId as string | null,
  };
}

function validateProviderLimits(limits: ResearchProviderBudgetLimitsV1): void {
  if (
    !positiveBoundedInteger(limits.maxAttempts) ||
    limits.maxAttempts > MAX_RESEARCH_PROVIDER_ATTEMPTS ||
    !positiveBoundedInteger(limits.maxTokens) ||
    !positiveBoundedInteger(limits.maxCostMicros) ||
    !Number.isFinite(Date.parse(limits.deadlineAt))
  )
    throw new ResearchProviderBudgetError('research_provider_budget_limits_invalid');
}

function validateProviderBinding(binding: ResearchProviderReservationBinding): void {
  if (
    !boundedString(binding.logicalOperationId, MAX_ATTEMPT_KEY_CHARS) ||
    !boundedString(binding.attemptId, MAX_ATTEMPT_KEY_CHARS) ||
    !(
      binding.retryOfAttemptId === null ||
      boundedString(binding.retryOfAttemptId, MAX_ATTEMPT_KEY_CHARS)
    ) ||
    !['openai_responses', 'anthropic_messages', 'jev'].includes(binding.kind) ||
    !boundedString(binding.phase, 64) ||
    !boundedString(binding.provider, 64) ||
    !boundedString(binding.model, 160) ||
    !nonNegativeInteger(binding.maxInputTokens) ||
    !(binding.maxOutputTokens === null || nonNegativeInteger(binding.maxOutputTokens))
  )
    throw new ResearchProviderBudgetError('research_provider_budget_binding_invalid');
}

function assertSameProviderBinding(
  existing: ResearchProviderAttemptV1,
  binding: ResearchProviderReservationBinding,
): void {
  if (
    existing.logicalOperationId !== binding.logicalOperationId ||
    existing.retryOfAttemptId !== binding.retryOfAttemptId ||
    existing.kind !== binding.kind ||
    existing.phase !== binding.phase ||
    existing.provider !== binding.provider ||
    existing.model !== binding.model ||
    existing.reservedInputTokens !== binding.maxInputTokens ||
    (binding.maxOutputTokens !== null && existing.reservedOutputTokens !== binding.maxOutputTokens)
  )
    throw new ResearchProviderBudgetError('research_provider_budget_attempt_identity_reused');
}

function providerCostMicros(
  price: ResearchProviderPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  if (
    !Number.isFinite(price.inputPerM) ||
    price.inputPerM < 0 ||
    !Number.isFinite(price.outputPerM) ||
    price.outputPerM < 0
  )
    throw new ResearchProviderBudgetError('research_provider_budget_price_invalid');
  return Math.max(
    1,
    Math.ceil(
      ((inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000) * 1_000_000,
    ),
  );
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function positiveBoundedInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function boundedId(value: unknown): value is string {
  return boundedString(value, MAX_ID_CHARS);
}

function boundedString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function malformed(): never {
  throw new ResearchToolBudgetError('research_tool_budget_malformed');
}

function providerMalformed(): never {
  throw new ResearchProviderBudgetError('research_provider_budget_malformed');
}
