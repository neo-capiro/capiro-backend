import { randomUUID } from 'node:crypto';
import {
  validateMeriGovernedArtifactPolicy,
  type MeriGovernedArtifactCapturePolicy,
} from '@capiro/meriv2-core';
import { researchJsonSha256 } from './meri-research-durable-result.js';
import {
  admitResearchProviderBudget,
  readResearchProviderBudget,
  reserveResearchProviderAttempt,
  settleResearchProviderAttempt,
  type ResearchProviderBudgetV1,
  type ResearchProviderReservationBinding,
} from './meri-research-tool-budget.js';

export interface Case46ProviderRate {
  kind: ResearchProviderReservationBinding['kind'];
  provider: string;
  model: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
}
/** Trusted operator qualification, never accepted from the HTTP reservation body. */
export interface Case46ProviderBudgetQualification {
  version: 1;
  caseId: string;
  captureRunId: string;
  currentVerifySha256: string;
  rateEvidenceSha256: string;
  rateEvidenceExpiresAt: string;
  priceKind: 'qualified_text_token_upper_bound';
  maxAttempts: number;
  maxTokens: number;
  maxCostMicros: number;
  rates: Case46ProviderRate[];
}
export interface Case46ProviderBudgetState {
  version: 1;
  admissionId: string;
  turnId: string | null;
  policySha256: string;
  qualification: Case46ProviderBudgetQualification;
  qualificationSha256: string;
  ledger: ResearchProviderBudgetV1;
}
export type Case46ProviderSettlement = {
  reservationId: string;
  binding: Omit<ResearchProviderReservationBinding, 'maxInputTokens' | 'maxOutputTokens'>;
  outcome:
    | { kind: 'known'; inputTokens: number; outputTokens: number }
    | { kind: 'uncertain' }
    | { kind: 'rejected' };
};
const HASH = /^[a-f0-9]{64}$/;
const KEY = 'governedArtifactProviderBudget';
const chargedCost = (p: { inputPerM: number; outputPerM: number }, input: number, output: number) =>
  Math.max(1, Math.ceil(((p.inputPerM * input + p.outputPerM * output) / 1_000_000) * 1_000_000));
export const case46ProviderBudgetMetadataKey = KEY;
function fail(reason: string): never {
  throw new Error(`meri_case46_provider_budget_${reason}`);
}
const integer = (value: unknown, positive = false): value is number =>
  Number.isSafeInteger(value) && (value as number) >= (positive ? 1 : 0);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256;
export function case46BudgetHash(value: unknown): string {
  return researchJsonSha256(value);
}

export function validateCase46BudgetQualification(
  value: unknown,
  policy: Pick<
    MeriGovernedArtifactCapturePolicy,
    'caseId' | 'captureRunId' | 'expiresAt' | 'currentVerifySha256' | 'qualificationSha256'
  >,
): Case46ProviderBudgetQualification {
  const q = value as Case46ProviderBudgetQualification | undefined;
  if (
    !q ||
    q.version !== 1 ||
    q.caseId !== '46' ||
    q.caseId !== policy.caseId ||
    q.captureRunId !== policy.captureRunId ||
    !HASH.test(q.currentVerifySha256) ||
    q.currentVerifySha256 !== policy.currentVerifySha256 ||
    !HASH.test(q.rateEvidenceSha256) ||
    typeof q.rateEvidenceExpiresAt !== 'string' ||
    !Number.isFinite(Date.parse(q.rateEvidenceExpiresAt)) ||
    Date.parse(q.rateEvidenceExpiresAt) < policy.expiresAt ||
    q.priceKind !== 'qualified_text_token_upper_bound' ||
    !integer(q.maxAttempts, true) ||
    q.maxAttempts > 64 ||
    !integer(q.maxTokens, true) ||
    q.maxTokens > 1_000_000 ||
    !integer(q.maxCostMicros, true) ||
    q.maxCostMicros > 3_000_000 ||
    !Array.isArray(q.rates) ||
    !q.rates.length ||
    q.rates.length > 32
  )
    fail('qualification_missing_or_invalid');
  const keys = new Set<string>();
  for (const r of q.rates) {
    if (
      !r ||
      ![
        'openai_responses',
        'anthropic_messages',
        'jev',
        'bedrock_embeddings',
        'nvidia_rerank',
      ].includes(r.kind) ||
      !text(r.provider) ||
      !text(r.model) ||
      !integer(r.inputMicrosPerMillion) ||
      !integer(r.outputMicrosPerMillion) ||
      r.inputMicrosPerMillion + r.outputMicrosPerMillion <= 0 ||
      (['bedrock_embeddings', 'nvidia_rerank'].includes(r.kind) &&
        (r.inputMicrosPerMillion <= 0 || r.outputMicrosPerMillion !== 0)) ||
      !Number.isSafeInteger(r.inputMicrosPerMillion * q.maxTokens) ||
      !Number.isSafeInteger(r.outputMicrosPerMillion * q.maxTokens)
    )
      fail('rate_invalid');
    const key = `${r.kind}:${r.provider}:${r.model}`;
    if (keys.has(key)) fail('rate_duplicate');
    keys.add(key);
  }
  if (case46BudgetHash(q) !== policy.qualificationSha256) fail('qualification_rebound');
  return structuredClone(q);
}
function policyIdentity(policy: MeriGovernedArtifactCapturePolicy) {
  validateMeriGovernedArtifactPolicy(policy, policy);
  return case46BudgetHash({ ...policy, turnId: null });
}
function envelope(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    fail('metadata_invalid');
  return metadata as Record<string, unknown>;
}
function price(
  state: Case46ProviderBudgetState,
  binding: Pick<ResearchProviderReservationBinding, 'kind' | 'provider' | 'model'>,
) {
  const r = state.qualification.rates.find(
    (candidate) =>
      candidate.kind === binding.kind &&
      candidate.provider === binding.provider &&
      candidate.model === binding.model,
  );
  if (!r) return fail('price_unknown');
  return {
    inputPerM: r.inputMicrosPerMillion / 1_000_000,
    outputPerM: r.outputMicrosPerMillion / 1_000_000,
  };
}
export function readCase46ProviderBudget(
  metadata: unknown,
  policy: MeriGovernedArtifactCapturePolicy,
  qualification: unknown,
): Case46ProviderBudgetState | null {
  const raw = envelope(metadata)[KEY];
  if (raw === undefined) return null;
  const state = raw as Case46ProviderBudgetState;
  const q = validateCase46BudgetQualification(qualification, policy);
  if (
    !state ||
    state.version !== 1 ||
    !text(state.admissionId) ||
    (state.turnId !== null && !text(state.turnId)) ||
    (policy.turnId !== null && state.turnId !== policy.turnId) ||
    state.policySha256 !== policyIdentity(policy) ||
    state.qualificationSha256 !== case46BudgetHash(q) ||
    case46BudgetHash(state.qualification) !== state.qualificationSha256
  )
    fail('admission_rebound');
  const ledger = readResearchProviderBudget({ researchProviderBudget: state.ledger });
  if (
    !ledger ||
    ledger.limits.maxAttempts !== q.maxAttempts ||
    ledger.limits.maxTokens !== q.maxTokens ||
    ledger.limits.maxCostMicros !== q.maxCostMicros ||
    ledger.limits.deadlineAt !== new Date(policy.expiresAt).toISOString()
  )
    fail('ledger_limits_changed');
  let tokens = 0,
    cost = 0;
  for (const a of ledger.attempts) {
    if (a.runId !== state.admissionId || a.leaseEpoch !== 1 || !a.priceKnown)
      fail('attempt_rebound');
    const p = price(state, a);
    if (a.reservedCostMicros !== chargedCost(p, a.reservedInputTokens, a.reservedOutputTokens))
      fail('reservation_charge_changed');
    if (a.status === 'settled') {
      if (
        !integer(a.actualInputTokens) ||
        !integer(a.actualOutputTokens) ||
        !integer(a.actualCostMicros) ||
        a.actualInputTokens > a.reservedInputTokens ||
        a.actualOutputTokens > a.reservedOutputTokens ||
        a.actualCostMicros !== chargedCost(p, a.actualInputTokens, a.actualOutputTokens)
      )
        fail('settlement_charge_changed');
      tokens += a.actualInputTokens + a.actualOutputTokens;
      cost += a.actualCostMicros;
    } else if (a.status === 'rejected') {
      if (a.actualInputTokens !== 0 || a.actualOutputTokens !== 0 || a.actualCostMicros !== 0)
        fail('rejected_charge_changed');
    } else {
      tokens += a.reservedInputTokens + a.reservedOutputTokens;
      cost += a.reservedCostMicros;
    }
  }
  if (tokens !== ledger.chargedTokens || cost !== ledger.chargedCostMicros)
    fail('aggregate_charge_changed');
  return { ...structuredClone(state), ledger };
}
export function admitCase46ProviderBudget(
  metadata: unknown,
  policy: MeriGovernedArtifactCapturePolicy,
  qualification: unknown,
) {
  const existing = readCase46ProviderBudget(metadata, { ...policy, turnId: null }, qualification);
  if (existing) {
    if (policy.turnId !== null && existing.turnId !== null && existing.turnId !== policy.turnId)
      fail('turn_rebound');
    const state = { ...existing, turnId: existing.turnId ?? policy.turnId };
    return { metadata: { ...envelope(metadata), [KEY]: state }, state };
  }
  const q = validateCase46BudgetQualification(qualification, policy);
  const { budget } = admitResearchProviderBudget(
    {},
    {
      maxAttempts: q.maxAttempts,
      maxTokens: q.maxTokens,
      maxCostMicros: q.maxCostMicros,
      deadlineAt: new Date(policy.expiresAt).toISOString(),
    },
  );
  const state: Case46ProviderBudgetState = {
    version: 1,
    admissionId: randomUUID(),
    turnId: policy.turnId,
    policySha256: policyIdentity(policy),
    qualification: q,
    qualificationSha256: case46BudgetHash(q),
    ledger: budget,
  };
  return { metadata: { ...envelope(metadata), [KEY]: state }, state };
}
export function reserveCase46ProviderAttempt(
  metadata: unknown,
  policy: MeriGovernedArtifactCapturePolicy,
  qualification: unknown,
  binding: ResearchProviderReservationBinding,
  now = new Date(),
) {
  const state =
    readCase46ProviderBudget(metadata, policy, qualification) ?? fail('admission_missing');
  if (
    !binding ||
    !integer(binding.maxOutputTokens) ||
    (binding.maxOutputTokens === 0 &&
      !['bedrock_embeddings', 'nvidia_rerank'].includes(binding.kind))
  )
    fail('output_bound_missing');
  const result = reserveResearchProviderAttempt({
    metadata: { researchProviderBudget: state.ledger },
    run: { id: state.admissionId, leaseEpoch: 1 },
    limits: state.ledger.limits,
    binding,
    price: price(state, binding),
    now,
  });
  const next = { ...state, ledger: result.budget };
  return {
    metadata: { ...envelope(metadata), [KEY]: next },
    state: next,
    reservationId: result.reservation.reservationId,
    deadlineAt: result.budget.limits.deadlineAt,
    dispatchAllowed: result.dispatchAllowed,
  };
}
export function settleCase46ProviderAttempt(
  metadata: unknown,
  policy: MeriGovernedArtifactCapturePolicy,
  qualification: unknown,
  input: Case46ProviderSettlement,
) {
  const state =
    readCase46ProviderBudget(metadata, policy, qualification) ?? fail('admission_missing');
  if (
    !input ||
    !text(input.reservationId) ||
    !input.binding ||
    !['known', 'rejected', 'uncertain'].includes(input.outcome?.kind)
  )
    fail('settlement_invalid');
  const result = settleResearchProviderAttempt({
    metadata: { researchProviderBudget: state.ledger },
    run: { id: state.admissionId, leaseEpoch: 1 },
    reservationId: input.reservationId,
    binding: input.binding,
    outcome:
      input.outcome.kind === 'known'
        ? { ...input.outcome, price: price(state, input.binding) }
        : input.outcome,
  });
  const next = { ...state, ledger: result.budget };
  return { metadata: { ...envelope(metadata), [KEY]: next }, state: next };
}

/** Final evidence is unavailable until every dispatched attempt has a known
 * settlement. Retained reservations/uncertain outcomes never become zero cost. */
export function settledCase46ProviderReceipt(
  metadata: unknown,
  policy: MeriGovernedArtifactCapturePolicy,
  qualification: unknown,
) {
  const state =
    readCase46ProviderBudget(metadata, policy, qualification) ?? fail('admission_missing');
  if (
    !policy.turnId ||
    state.turnId !== policy.turnId ||
    !state.ledger.attempts.some((a) => a.status === 'settled') ||
    state.ledger.attempts.some((a) => !['settled', 'rejected'].includes(a.status))
  )
    fail('settled_usage_required');
  return {
    version: 1 as const,
    kind: 'governed_artifact_provider_usage' as const,
    caseId: '46' as const,
    captureRunId: policy.captureRunId,
    policyId: policy.policyId,
    conversationId: policy.conversationId,
    turnId: policy.turnId,
    currentVerifySha256: policy.currentVerifySha256,
    qualificationSha256: state.qualificationSha256,
    ledgerSha256: case46BudgetHash(state.ledger),
    attempts: state.ledger.chargedAttempts,
    tokens: state.ledger.chargedTokens,
    costMicros: state.ledger.chargedCostMicros,
    allAttemptsSettled: true as const,
  };
}
