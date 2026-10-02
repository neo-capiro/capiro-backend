export interface MeriControlledReadAttempt {
  callId: string;
  tool: string;
  httpStatus: number;
  logicalError: string | null;
  caseId: string;
  captureRunId: string;
  requestId: string;
  traceId: string;
  turnId: string;
  sourceId: string;
  logicalSourceId: string;
  sourceVersion: string;
  currentVerifySha256: string;
  contentSha256: string;
  responseSha256: string;
  sourceTenantId: string;
  sourceClientId: string | null;
  fullRead: boolean;
  passageSha256: string | null;
  /** Additional complete source set from ONE actual HTTP response. The legacy
   * scalar fields identify its first source; they never add another tool call. */
  sourceReads?: Array<{
    sourceId: string;
    logicalSourceId: string;
    sourceVersion: string;
    contentSha256: string;
    sourceTenantId: string;
    sourceClientId: string | null;
    fullRead: true;
    passageSha256: string;
  }>;
  coverage?: Record<string, unknown> | null;
}
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../repair/plan-remedy';
import type { MeriServerReadonlyCapturePolicy } from './server-readonly-capture';

export const MERI_CAPTURE_EVIDENCE_VERSION = 1 as const;
export const MERI_CAPTURE_EVIDENCE_PURPOSE = 'server_capture_evidence' as const;
export const MERI_CAPTURE_EVIDENCE_AUDIENCE =
  'capiro:meri:server-readonly-capture:evidence:v1' as const;

export type MeriCaptureEvidenceStatus = 'COMPLETE' | 'BLOCKED' | 'NOT_RUN';
export type MeriCaptureProvenanceStatus = 'OBSERVED' | 'UNKNOWN' | 'NOT_RUN' | 'PENDING_BINDING';

export interface MeriCaptureObservedValue<T> {
  status: MeriCaptureProvenanceStatus;
  value: T | null;
  reason: string | null;
}

export interface MeriCaptureReleaseIdentity {
  service: 'api' | 'meriv2-orchestrator';
  releaseRevision: MeriCaptureObservedValue<string>;
  identityContract: 'runtime_environment_v1';
  deploymentProof: 'PENDING_APPROVED_BUILD_RECEIPT_CROSSCHECK';
}

export interface MeriCaptureSourceObservation {
  sourceId: string;
  toolCallId: string;
  tenantId: MeriCaptureObservedValue<string>;
  clientId: MeriCaptureObservedValue<string | null>;
  currentVersion: MeriCaptureObservedValue<string>;
  fullRead: MeriCaptureObservedValue<boolean>;
  locator: MeriCaptureObservedValue<string>;
  passageSha256: MeriCaptureObservedValue<string>;
  byteSha256: MeriCaptureObservedValue<string>;
}

export interface MeriCaptureToolCallObservation {
  callId: string;
  name: string;
  attempt: number;
  status:
    'complete' | 'empty' | 'partial' | 'unavailable' | 'denied' | 'failed' | 'invalid_not_executed';
  readOnly: boolean;
  sourceIds: string[];
}

export interface MeriCaptureUsageObservation {
  provider: MeriCaptureObservedValue<string>;
  model: MeriCaptureObservedValue<string>;
  inputTokens: MeriCaptureObservedValue<number>;
  outputTokens: MeriCaptureObservedValue<number>;
  cacheReadTokens: MeriCaptureObservedValue<number>;
  cacheCreationTokens: MeriCaptureObservedValue<number>;
  estimatedCostUsd: MeriCaptureObservedValue<number>;
  costKind: 'existing_pricing_estimate' | 'unknown';
}

export interface MeriCaptureWriteObservation {
  logicalWriteId: string;
  kind:
    | 'context_packet_and_evidence'
    | 'conversation_user_message'
    | 'conversation_assistant_message'
    | 'assistant_receipt_metadata'
    | 'provider_budget_ledger'
    | 'unexpected_write';
  phase: 'before' | 'during' | 'after';
  status: 'observed' | 'pending' | 'unexpected';
  recordId: string | null;
}

export interface MeriCaptureEvidenceReceipt {
  version: typeof MERI_CAPTURE_EVIDENCE_VERSION;
  kind: 'server_capture_evidence_receipt';
  purpose: typeof MERI_CAPTURE_EVIDENCE_PURPOSE;
  status: MeriCaptureEvidenceStatus;
  blockers: string[];
  policyId: string;
  caseId: string | null;
  captureRunId: string | null;
  requestId: string;
  conversationId: string;
  turnId: string | null;
  traceId: string;
  tenantId: string;
  actorUserId: string;
  clientId: string | null;
  startedAt: number;
  completedAt: number;
  expiresAt: number;
  sources: MeriCaptureSourceObservation[];
  toolCalls: MeriCaptureToolCallObservation[];
  usage: MeriCaptureUsageObservation;
  releases: {
    api: MeriCaptureReleaseIdentity;
    orchestrator: MeriCaptureReleaseIdentity;
  };
  fixture: {
    namespace: string;
    version: MeriCaptureObservedValue<string>;
    physicalMapSha256: MeriCaptureObservedValue<string>;
    resetReceiptId: MeriCaptureObservedValue<string>;
    seedReceiptId: MeriCaptureObservedValue<string>;
  };
  effects: {
    boundary: 'bounded_capture_path_hooks';
    writes: MeriCaptureWriteObservation[];
    logicalEffects: Array<{
      logicalEffectId: string;
      operationId: string | null;
      receiptId: string | null;
      status: 'observed' | 'unknown_outcome' | 'unexpected';
    }>;
  };
  controlledReadAttempts?: MeriControlledReadAttempt[];
  boundedRuntime?: {
    acquisitionStopped: boolean;
    stopReason: string | null;
    toolCalls: number;
    modelCalls: number;
    retryCalls: number;
  };
  predecessorAttestationSha256: string | null;
  /** API-owned durable ledger; a primary-model usage estimate is not this proof. */
  providerBudget?: {
    version: 1;
    boundary: 'case01_memory_turn' | 'case14_memory_turn' | 'case20_controlled_read_turn' | 'case72_controlled_read_turn';
    status: 'SETTLED' | 'UNSETTLED';
    admissionId: string;
    turnId: string;
    ledgerSha256: string;
    qualificationSha256: string;
    attempts: number;
    chargedTokens: number;
    chargedCostMicros: number;
    maxCostMicros: number;
    unaccountedBoundaries: readonly string[];
  };
}

export interface SignedMeriCaptureEvidenceReceipt {
  version: 1;
  audience: typeof MERI_CAPTURE_EVIDENCE_AUDIENCE;
  purpose: typeof MERI_CAPTURE_EVIDENCE_PURPOSE;
  receipt: MeriCaptureEvidenceReceipt;
  signature: string;
}

export function observed<T>(value: T): MeriCaptureObservedValue<T> {
  return { status: 'OBSERVED', value, reason: null };
}

export function unknown<T>(reason: string): MeriCaptureObservedValue<T> {
  return { status: 'UNKNOWN', value: null, reason };
}

export function pendingBinding<T>(reason: string): MeriCaptureObservedValue<T> {
  return { status: 'PENDING_BINDING', value: null, reason };
}

export function notRun<T>(reason: string): MeriCaptureObservedValue<T> {
  return { status: 'NOT_RUN', value: null, reason };
}

export function meriCaptureReceiptBlockers(
  receipt: Omit<MeriCaptureEvidenceReceipt, 'status' | 'blockers'>,
): string[] {
  const blockers = new Set<string>();
  const requiredValues: Array<[string, MeriCaptureObservedValue<unknown>]> = [
    ['fixture_version', receipt.fixture.version],
    ['fixture_physical_map', receipt.fixture.physicalMapSha256],
    ['fixture_reset_receipt', receipt.fixture.resetReceiptId],
    ['fixture_seed_receipt', receipt.fixture.seedReceiptId],
    ['api_release', receipt.releases.api.releaseRevision],
    ['orchestrator_release', receipt.releases.orchestrator.releaseRevision],
    ['provider', receipt.usage.provider],
    ['model', receipt.usage.model],
    ['input_tokens', receipt.usage.inputTokens],
    ['output_tokens', receipt.usage.outputTokens],
  ];
  if (!receipt.caseId) blockers.add('case_id_missing');
  if (!receipt.captureRunId) blockers.add('capture_run_id_missing');
  if (!receipt.turnId) blockers.add('turn_id_missing');
  if (receipt.providerBudget) {
    const budget = receipt.providerBudget;
    if (
      budget.version !== 1 ||
      !(
        (receipt.caseId === '01' && budget.boundary === 'case01_memory_turn') ||
        (receipt.caseId === '14' && budget.boundary === 'case14_memory_turn') ||
        (receipt.caseId === '20' && budget.boundary === 'case20_controlled_read_turn') ||
        (receipt.caseId === '72' && budget.boundary === 'case72_controlled_read_turn')
      ) ||
      !budget.admissionId ||
      !/^[a-f0-9]{64}$/.test(budget.ledgerSha256) ||
      !/^[a-f0-9]{64}$/.test(budget.qualificationSha256) ||
      ![
        budget.attempts,
        budget.chargedTokens,
        budget.chargedCostMicros,
        budget.maxCostMicros,
      ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      budget.maxCostMicros <= 0 ||
      budget.maxCostMicros > 3_000_000 ||
      budget.chargedCostMicros > budget.maxCostMicros
    )
      blockers.add('provider_budget_malformed');
    if (budget.status !== 'SETTLED') blockers.add('provider_budget_usage_unsettled');
    if (budget.turnId !== receipt.turnId) blockers.add('provider_budget_turn_mismatch');
    if (budget.unaccountedBoundaries.length)
      blockers.add('provider_budget_api_ingress_unaccounted');
  } else if (receipt.caseId) {
    blockers.add('provider_budget_not_run');
  }
  for (const [name, value] of requiredValues) {
    if (value.status !== 'OBSERVED' || value.value === null) blockers.add(`${name}_unproved`);
  }
  for (const source of receipt.sources) {
    if (source.tenantId.status !== 'OBSERVED' || source.tenantId.value !== receipt.tenantId) {
      blockers.add(`source_tenant_authority_unproved:${source.sourceId}`);
    }
    if (source.clientId.status !== 'OBSERVED' || source.clientId.value !== receipt.clientId) {
      blockers.add(`source_client_authority_unproved:${source.sourceId}`);
    }
    if (source.currentVersion.status !== 'OBSERVED')
      blockers.add(`source_version_unproved:${source.sourceId}`);
    if (source.fullRead.status !== 'OBSERVED')
      blockers.add(`source_coverage_unproved:${source.sourceId}`);
    if (
      source.locator.status !== 'OBSERVED' &&
      source.passageSha256.status !== 'OBSERVED' &&
      source.byteSha256.status !== 'OBSERVED'
    ) {
      blockers.add(`source_location_or_hash_unproved:${source.sourceId}`);
    }
  }
  const callIds = new Set(receipt.toolCalls.map((call) => call.callId));
  for (const source of receipt.sources) {
    if (!callIds.has(source.toolCallId))
      blockers.add(`source_tool_join_missing:${source.sourceId}`);
  }
  if (receipt.toolCalls.some((call) => !call.readOnly)) blockers.add('non_read_only_tool_observed');
  if (receipt.effects.logicalEffects.some((effect) => effect.status !== 'observed')) {
    blockers.add('logical_effect_not_authoritatively_observed');
  }
  if (receipt.effects.writes.some((write) => write.status === 'unexpected')) {
    blockers.add('unexpected_write_observed');
  }
  return [...blockers].sort();
}

export function completeMeriCaptureEvidenceReceipt(
  receipt: Omit<MeriCaptureEvidenceReceipt, 'status' | 'blockers'>,
): MeriCaptureEvidenceReceipt {
  const blockers = meriCaptureReceiptBlockers(receipt);
  return {
    ...receipt,
    status: blockers.length ? 'BLOCKED' : 'COMPLETE',
    blockers,
  };
}

function signingPayload(receipt: MeriCaptureEvidenceReceipt): string {
  return canonicalJson({
    audience: MERI_CAPTURE_EVIDENCE_AUDIENCE,
    purpose: MERI_CAPTURE_EVIDENCE_PURPOSE,
    receipt,
  });
}

export function signMeriCaptureEvidenceReceipt(
  receipt: MeriCaptureEvidenceReceipt,
  secret: string | undefined,
): SignedMeriCaptureEvidenceReceipt {
  if (!secret?.trim()) throw new Error('meri_capture_service_identity_unavailable');
  return {
    version: 1,
    audience: MERI_CAPTURE_EVIDENCE_AUDIENCE,
    purpose: MERI_CAPTURE_EVIDENCE_PURPOSE,
    receipt,
    signature: createHmac('sha256', secret.trim()).update(signingPayload(receipt)).digest('hex'),
  };
}

export function verifyMeriCaptureEvidenceReceipt(
  envelope: SignedMeriCaptureEvidenceReceipt,
  policy: MeriServerReadonlyCapturePolicy,
  secret: string | undefined,
  now = Date.now(),
): MeriCaptureEvidenceReceipt {
  if (!secret?.trim() || !envelope || envelope.version !== 1) {
    throw new Error('meri_capture_evidence_authentication_failed');
  }
  const receipt = envelope.receipt;
  if (
    envelope.audience !== MERI_CAPTURE_EVIDENCE_AUDIENCE ||
    envelope.purpose !== MERI_CAPTURE_EVIDENCE_PURPOSE ||
    receipt?.version !== 1 ||
    receipt.kind !== 'server_capture_evidence_receipt' ||
    receipt.purpose !== MERI_CAPTURE_EVIDENCE_PURPOSE ||
    receipt.policyId !== policy.policyId ||
    receipt.requestId !== policy.requestId ||
    receipt.traceId !== policy.traceId ||
    receipt.conversationId !== policy.conversationId ||
    receipt.tenantId !== policy.tenantId ||
    receipt.actorUserId !== policy.actorUserId ||
    receipt.clientId !== policy.clientId ||
    receipt.turnId !== policy.turnId ||
    receipt.caseId !== policy.caseId ||
    receipt.captureRunId !== policy.captureRunId ||
    receipt.expiresAt !== policy.expiresAt ||
    receipt.completedAt > now + 30_000 ||
    receipt.expiresAt <= now ||
    !/^[a-f0-9]{64}$/.test(envelope.signature)
  ) {
    throw new Error('meri_capture_evidence_authentication_failed');
  }
  const expected = createHmac('sha256', secret.trim()).update(signingPayload(receipt)).digest();
  const supplied = Buffer.from(envelope.signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
    throw new Error('meri_capture_evidence_authentication_failed');
  }
  const blockers = meriCaptureReceiptBlockers(receipt);
  if (
    receipt.status !== (blockers.length ? 'BLOCKED' : 'COMPLETE') ||
    JSON.stringify(receipt.blockers) !== JSON.stringify(blockers)
  ) {
    throw new Error('meri_capture_evidence_authentication_failed');
  }
  return receipt;
}

export function meriCaptureEvidenceEnvelopeSha256(
  envelope: SignedMeriCaptureEvidenceReceipt,
): string {
  return createHash('sha256').update(canonicalJson(envelope)).digest('hex');
}
