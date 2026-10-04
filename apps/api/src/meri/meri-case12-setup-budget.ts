import { createHash } from 'node:crypto';
import { researchJsonSha256 } from './meri-research-durable-result.js';
import {
  admitResearchProviderBudget,
  readResearchProviderBudget,
  reserveResearchProviderAttempt,
  settleResearchProviderAttempt,
  type ResearchProviderBudgetV1,
  type ResearchProviderReservationBinding,
} from './meri-research-tool-budget.js';

/** Arithmetic only. Neither a plan nor a serialized ledger authorizes setup. */
export type Case12SetupWireKind = 'openai_embeddings' | 'bedrock_embeddings';
export const CASE12_SETUP_ROWS = 510;
// Reserve each model's full input ceiling, independent of tokenizer assumptions.
// https://developers.openai.com/api/docs/guides/embeddings
// https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html
export const CASE12_SETUP_MAX_INPUT_TOKENS = 8192;
export const CASE12_SETUP_WIRES = Object.freeze({
  openai_embeddings: Object.freeze({
    provider: 'openai',
    model: 'text-embedding-3-small',
    endpoint: 'https://api.openai.com/v1/embeddings',
  }),
  bedrock_embeddings: Object.freeze({
    provider: 'aws-bedrock',
    model: 'amazon.titan-embed-text-v2:0',
    endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  }),
});
const KINDS = ['openai_embeddings', 'bedrock_embeddings'] as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
function fail(code: string): never {
  throw new Error(`meri_case12_setup_budget_${code}`);
}
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function exact(v: unknown, keys: readonly string[]): asserts v is Record<string, unknown> {
  if (!record(v) || Object.keys(v).sort().join('|') !== [...keys].sort().join('|'))
    fail('malformed');
}
function instant(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
export const case12SetupHash = researchJsonSha256;
export const case12SetupBodyHash = (body: string) =>
  createHash('sha256').update(body, 'utf8').digest('hex');

export interface Case12SetupRequestPlan {
  bodySha256: string;
  inputBytes: number;
}
export interface Case12SetupRowPlan {
  candidateId: string;
  logicalId: string;
  candidatePayloadSha256: string;
  requests: Record<Case12SetupWireKind, Case12SetupRequestPlan>;
}
export interface Case12SetupBudgetPlan {
  version: 1;
  caseId: '12';
  fixtureNamespace: 'meri-foundation-20260928';
  fixtureInstanceId: string;
  runId: string;
  aggregateReservationId: string;
  tenantId: string;
  proposerUserId: string;
  reviewerUserId: string;
  clientId: string;
  setupPlanSha256: string;
  recipeSha256: string;
  orderedDefinitionSha256: string;
  sourceSha256: string;
  imageSha256: string;
  aggregateCheckpointSha256: string;
  rateEvidenceSha256: string;
  admittedAt: string;
  deadlineAt: string;
  ratesExpiresAt: string;
  rates: Record<Case12SetupWireKind, { inputPerM: number; outputPerM: 0 }>;
  maxCostMicros: number;
  rows: Case12SetupRowPlan[];
}
export interface Case12SetupBudgetState {
  version: 1;
  planSha256: string;
  nextRow: number;
  reconciliationRequired: boolean;
  rows: Array<ResearchProviderBudgetV1 | null>;
}
export type Case12SetupOutcome =
  { kind: 'known'; inputTokens: number; outputTokens: 0 } | { kind: 'uncertain' };
export interface Case12SetupWireInput {
  kind: Case12SetupWireKind;
  provider: string;
  model: string;
  endpoint: string;
  body: string;
}
export function case12SetupCost(inputPerM: number, inputTokens: number): number {
  const value = Math.max(1, Math.ceil(((inputTokens * inputPerM) / 1_000_000) * 1_000_000));
  if (!integer(value)) fail('unsafe_cost');
  return value;
}
function rowLimits(plan: Case12SetupBudgetPlan, index: number) {
  if (!plan.rows[index]) fail('row_invalid');
  return {
    maxAttempts: 2,
    maxTokens: KINDS.length * CASE12_SETUP_MAX_INPUT_TOKENS,
    maxCostMicros: KINDS.reduce(
      (n, k) => n + case12SetupCost(plan.rates[k].inputPerM, CASE12_SETUP_MAX_INPUT_TOKENS),
      0,
    ),
    deadlineAt: plan.deadlineAt,
  };
}
export function validateCase12SetupBudgetPlan(value: unknown): Case12SetupBudgetPlan {
  exact(value, [
    'version',
    'caseId',
    'fixtureNamespace',
    'fixtureInstanceId',
    'runId',
    'aggregateReservationId',
    'tenantId',
    'proposerUserId',
    'reviewerUserId',
    'clientId',
    'setupPlanSha256',
    'recipeSha256',
    'orderedDefinitionSha256',
    'sourceSha256',
    'imageSha256',
    'aggregateCheckpointSha256',
    'rateEvidenceSha256',
    'admittedAt',
    'deadlineAt',
    'ratesExpiresAt',
    'rates',
    'maxCostMicros',
    'rows',
  ]);
  if (
    value.version !== 1 ||
    value.caseId !== '12' ||
    value.fixtureNamespace !== 'meri-foundation-20260928' ||
    value.tenantId !== 'f2d6cf8f-057c-479a-8110-62fe5086d43f' ||
    [
      'fixtureInstanceId',
      'runId',
      'aggregateReservationId',
      'proposerUserId',
      'reviewerUserId',
      'clientId',
    ].some((k) => typeof value[k] !== 'string' || !UUID.test(value[k] as string)) ||
    value.proposerUserId === value.reviewerUserId ||
    [
      'setupPlanSha256',
      'recipeSha256',
      'orderedDefinitionSha256',
      'sourceSha256',
      'imageSha256',
      'aggregateCheckpointSha256',
      'rateEvidenceSha256',
    ].some((k) => typeof value[k] !== 'string' || !HASH.test(value[k] as string)) ||
    !instant(value.admittedAt) ||
    !instant(value.deadlineAt) ||
    !instant(value.ratesExpiresAt) ||
    Date.parse(value.deadlineAt) <= Date.parse(value.admittedAt) ||
    Date.parse(value.deadlineAt) > Date.parse(value.ratesExpiresAt) ||
    !integer(value.maxCostMicros) ||
    value.maxCostMicros < 1 ||
    value.maxCostMicros > 15_000_000 ||
    !Array.isArray(value.rows) ||
    value.rows.length !== CASE12_SETUP_ROWS
  )
    fail('plan_invalid');
  exact(value.rates, KINDS);
  for (const kind of KINDS) {
    const rate = value.rates[kind];
    exact(rate, ['inputPerM', 'outputPerM']);
    if (
      typeof rate.inputPerM !== 'number' ||
      !Number.isFinite(rate.inputPerM) ||
      rate.inputPerM <= 0 ||
      rate.outputPerM !== 0
    )
      fail('rate_invalid');
  }
  const ids = new Set();
  for (const [index, row] of value.rows.entries()) {
    exact(row, ['candidateId', 'logicalId', 'candidatePayloadSha256', 'requests']);
    // Candidate IDs are deterministic UUIDv5; instance/run/reservation IDs are fresh UUIDv4.
    if (
      typeof row.candidateId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        row.candidateId,
      ) ||
      ids.has(row.candidateId) ||
      typeof row.candidatePayloadSha256 !== 'string' ||
      !HASH.test(row.candidatePayloadSha256) ||
      row.logicalId !==
        (index === 0 ? 'MA510' : `MA510-DISTRACTOR-${String(index).padStart(4, '0')}`)
    )
      fail('row_invalid');
    ids.add(row.candidateId);
    exact(row.requests, KINDS);
    for (const kind of KINDS) {
      const request = row.requests[kind];
      exact(request, ['bodySha256', 'inputBytes']);
      if (
        typeof request.bodySha256 !== 'string' ||
        !HASH.test(request.bodySha256) ||
        !integer(request.inputBytes) ||
        request.inputBytes < 1 ||
        request.inputBytes > 1_000_000
      )
        fail('request_invalid');
    }
  }
  const plan = structuredClone(value) as unknown as Case12SetupBudgetPlan;
  const bound = plan.rows.reduce((n, _, i) => n + rowLimits(plan, i).maxCostMicros, 0);
  if (!integer(bound) || bound !== plan.maxCostMicros) fail('plan_bound_mismatch');
  return plan;
}
function binding(
  plan: Case12SetupBudgetPlan,
  index: number,
  kind: Case12SetupWireKind,
): ResearchProviderReservationBinding {
  const row = plan.rows[index]!;
  const identity = `${row.candidateId}:${kind}`;
  return {
    kind,
    provider: CASE12_SETUP_WIRES[kind].provider,
    model: CASE12_SETUP_WIRES[kind].model,
    phase: 'case12_setup',
    logicalOperationId: identity,
    attemptId: identity,
    retryOfAttemptId: null,
    maxInputTokens: CASE12_SETUP_MAX_INPUT_TOKENS,
    maxOutputTokens: 0,
  };
}
export function createCase12SetupBudget(planInput: unknown): Case12SetupBudgetState {
  const plan = validateCase12SetupBudgetPlan(planInput);
  return {
    version: 1,
    planSha256: case12SetupHash(plan),
    nextRow: 0,
    reconciliationRequired: false,
    rows: plan.rows.map(() => null),
  };
}
/** Recompute every child rather than trusting stored aggregate counters. */
export function readCase12SetupBudget(value: unknown, planInput: unknown): Case12SetupBudgetState {
  const plan = validateCase12SetupBudgetPlan(planInput);
  exact(value, ['version', 'planSha256', 'nextRow', 'reconciliationRequired', 'rows']);
  if (
    value.version !== 1 ||
    value.planSha256 !== case12SetupHash(plan) ||
    !integer(value.nextRow) ||
    value.nextRow > CASE12_SETUP_ROWS ||
    typeof value.reconciliationRequired !== 'boolean' ||
    !Array.isArray(value.rows) ||
    value.rows.length !== CASE12_SETUP_ROWS
  )
    fail('state_invalid');
  const reservations = new Set();
  let uncertain = false;
  for (const [index, raw] of value.rows.entries()) {
    if (raw === null) {
      if (index < value.nextRow) fail('completed_row_missing');
      continue;
    }
    if (index > value.nextRow) fail('row_order');
    const child = readResearchProviderBudget({ researchProviderBudget: raw });
    if (
      !child ||
      child.attempts.length < 1 ||
      case12SetupHash(child.limits) !== case12SetupHash(rowLimits(plan, index))
    )
      fail('child_invalid');
    let replay = admitResearchProviderBudget({}, rowLimits(plan, index)).metadata;
    for (const attempt of child.attempts) {
      if (
        !KINDS.includes(attempt.kind as Case12SetupWireKind) ||
        !UUID.test(attempt.reservationId) ||
        reservations.has(attempt.reservationId) ||
        !instant(attempt.reservedAt) ||
        Date.parse(attempt.reservedAt) < Date.parse(plan.admittedAt)
      )
        fail('attempt_invalid');
      const kind = attempt.kind as Case12SetupWireKind;
      reservations.add(attempt.reservationId);
      const reserved = reserveResearchProviderAttempt({
        metadata: replay,
        run: { id: plan.runId, leaseEpoch: 1 },
        limits: rowLimits(plan, index),
        binding: binding(plan, index, kind),
        price: plan.rates[kind],
        now: new Date(attempt.reservedAt),
        reservationId: attempt.reservationId,
      });
      if (!reserved.dispatchAllowed) fail('attempt_replayed');
      replay = reserved.metadata;
      if (attempt.status !== 'reserved') {
        if (
          !instant(attempt.settledAt) ||
          Date.parse(attempt.settledAt) < Date.parse(attempt.reservedAt) ||
          !['settled', 'uncertain'].includes(attempt.status)
        )
          fail('settlement_invalid');
        uncertain ||= attempt.status === 'uncertain';
        const outcome =
          attempt.status === 'settled'
            ? {
                kind: 'known' as const,
                inputTokens: attempt.actualInputTokens!,
                outputTokens: attempt.actualOutputTokens!,
                price: plan.rates[kind],
              }
            : { kind: 'uncertain' as const };
        replay = settleResearchProviderAttempt({
          metadata: replay,
          run: { id: plan.runId, leaseEpoch: 1 },
          reservationId: attempt.reservationId,
          binding: binding(plan, index, kind),
          outcome,
          now: new Date(attempt.settledAt),
        }).metadata;
      }
    }
    if (case12SetupHash(readResearchProviderBudget(replay)) !== case12SetupHash(child))
      fail('child_accounting_changed');
    if (
      index < value.nextRow &&
      (child.attempts.length !== 2 || child.attempts.some((a) => a.status !== 'settled'))
    )
      fail('row_not_settled');
  }
  if (uncertain && !value.reconciliationRequired) fail('uncertainty_cleared');
  return structuredClone(value) as unknown as Case12SetupBudgetState;
}
export function reserveCase12SetupWire(
  value: unknown,
  planInput: unknown,
  index: number,
  input: Case12SetupWireInput,
  now = new Date(),
) {
  const plan = validateCase12SetupBudgetPlan(planInput),
    state = readCase12SetupBudget(value, plan);
  if (
    state.reconciliationRequired ||
    index !== state.nextRow ||
    index >= CASE12_SETUP_ROWS ||
    !KINDS.includes(input.kind)
  )
    fail('dispatch_denied');
  const fixed = CASE12_SETUP_WIRES[input.kind],
    expected = plan.rows[index]!.requests[input.kind];
  if (
    input.provider !== fixed.provider ||
    input.model !== fixed.model ||
    input.endpoint !== fixed.endpoint ||
    typeof input.body !== 'string' ||
    Buffer.byteLength(input.body, 'utf8') !== expected.inputBytes ||
    case12SetupBodyHash(input.body) !== expected.bodySha256 ||
    now.getTime() < Date.parse(plan.admittedAt)
  )
    fail('wire_changed');
  const result = reserveResearchProviderAttempt({
    metadata: state.rows[index] ? { researchProviderBudget: state.rows[index] } : {},
    run: { id: plan.runId, leaseEpoch: 1 },
    limits: rowLimits(plan, index),
    binding: binding(plan, index, input.kind),
    price: plan.rates[input.kind],
    now,
  });
  if (!result.dispatchAllowed) fail('wire_replay_denied');
  state.rows[index] = result.budget;
  return { state, reservationId: result.reservation.reservationId };
}
export function settleCase12SetupWire(
  value: unknown,
  planInput: unknown,
  index: number,
  kind: Case12SetupWireKind,
  reservationId: string,
  outcome: Case12SetupOutcome,
  now = new Date(),
) {
  const plan = validateCase12SetupBudgetPlan(planInput),
    state = readCase12SetupBudget(value, plan);
  if (
    index !== state.nextRow ||
    index >= CASE12_SETUP_ROWS ||
    !KINDS.includes(kind) ||
    !state.rows[index]
  )
    fail('settlement_missing');
  if (outcome.kind !== 'uncertain' && (outcome.kind !== 'known' || outcome.outputTokens !== 0))
    fail('settlement_invalid');
  const result = settleResearchProviderAttempt({
    metadata: { researchProviderBudget: state.rows[index] },
    run: { id: plan.runId, leaseEpoch: 1 },
    reservationId,
    binding: binding(plan, index, kind),
    outcome: outcome.kind === 'known' ? { ...outcome, price: plan.rates[kind] } : outcome,
    now,
  });
  state.rows[index] = result.budget;
  state.reconciliationRequired ||= outcome.kind === 'uncertain';
  return readCase12SetupBudget(state, plan);
}
export function completeCase12SetupBudgetRow(value: unknown, planInput: unknown, index: number) {
  const state = readCase12SetupBudget(value, planInput),
    row = state.rows[index];
  if (
    state.reconciliationRequired ||
    state.nextRow !== index ||
    !row ||
    row.attempts.length !== 2 ||
    row.attempts.some((a) => a.status !== 'settled')
  )
    fail('row_incomplete');
  state.nextRow++;
  return state;
}
export function case12SetupBudgetTotals(value: unknown, planInput: unknown) {
  const state = readCase12SetupBudget(value, planInput);
  return {
    chargedAttempts: state.rows.reduce((n, r) => n + (r?.chargedAttempts ?? 0), 0),
    chargedTokens: state.rows.reduce((n, r) => n + (r?.chargedTokens ?? 0), 0),
    chargedCostMicros: state.rows.reduce((n, r) => n + (r?.chargedCostMicros ?? 0), 0),
    pendingAttempts: state.rows.reduce(
      (n, r) => n + (r?.attempts.filter((a) => a.status === 'reserved').length ?? 0),
      0,
    ),
    allRowsSettled: state.nextRow === CASE12_SETUP_ROWS && !state.reconciliationRequired,
    captureAuthority: false as const,
  };
}
