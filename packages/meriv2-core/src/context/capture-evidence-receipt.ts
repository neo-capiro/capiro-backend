import { readMeriCase12SetupBinding, type MeriCase12SetupBinding } from './case12-setup-binding.js';

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
import type { CompiledContextPacket } from './contract';
import {
  validateMeriFixtureSemanticClock,
  type MeriServerReadonlyCapturePolicy,
  type MeriFixtureSemanticClock,
  type MeriPromptClockUse,
} from './server-readonly-capture';

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
  /** Set by the actual local discovery dispatcher, never inferred from a name. */
  localDiscovery?: true;
}

export interface MeriCaptureCompilerPacket {
  packetId: string;
  persisted: true;
  clockUse: NonNullable<CompiledContextPacket['clockUse']>;
}

export interface MeriCaptureClockInvocation {
  callId: string;
  tool: string;
  outcome: 'pending' | 'returned' | 'threw';
  httpAttempts: number;
  httpStatus: number | null;
  responseSha256: string | null;
  packets: MeriCaptureCompilerPacket[];
  /** Observed from the actual raw own-proposal HTTP response, never model text. */
  proposalRead?: {
    authority: 'own_pending_proposals';
    tenantId: string;
    actorUserId: string;
    clientId: string;
    semanticTime: 'not_used';
    compiler: 'not_run';
    claimsAreApprovedFacts: false;
    coverage: 'complete' | 'empty' | 'partial';
  };
}

export interface MeriCaptureClockApiJoin {
  initial: MeriCaptureCompilerPacket;
  tools: MeriCaptureCompilerPacket[];
  relativeToolWindows: 'NOT_APPLICABLE';
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
  /** Rendering and HTTP observations are independently joined by the API owner. */
  semanticClock?: {
    binding: MeriFixtureSemanticClock;
    prompt: MeriCaptureObservedValue<MeriPromptClockUse>;
    invocations?: MeriCaptureClockInvocation[];
    apiJoin: 'PENDING' | 'VERIFIED';
    api?: MeriCaptureClockApiJoin;
  };
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
    case12Setup?: MeriCaptureObservedValue<MeriCase12SetupBinding>;
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
    boundary:
      | 'case01_memory_turn'
      | 'case12_memory_turn'
      | 'case14_memory_turn'
      | 'case20_controlled_read_turn'
      | 'case72_controlled_read_turn';
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

export function meriCaptureClockExecutionBlockers(
  receipt: Omit<MeriCaptureEvidenceReceipt, 'status' | 'blockers'>,
): string[] {
  const clock = receipt.semanticClock;
  if (!clock) return [];
  const failures = new Set<string>();
  const { binding, prompt, invocations } = clock;
  try {
    validateMeriFixtureSemanticClock(binding, {
      caseId: receipt.caseId,
      captureRunId: receipt.captureRunId,
      issuedAt: binding.observedAt,
    });
  } catch {
    failures.add('semantic_clock_binding_unproved');
  }
  if (
    prompt.status !== 'OBSERVED' ||
    !prompt.value ||
    prompt.value.instant !== binding.instant ||
    prompt.value.timeZone !== binding.timeZone ||
    prompt.value.date !== '2026-09-26' ||
    !Number.isSafeInteger(prompt.value.renderedAt) ||
    prompt.value.renderedAt < receipt.startedAt ||
    prompt.value.renderedAt > receipt.completedAt ||
    !/^[a-f0-9]{64}$/.test(prompt.value.groundingSha256)
  )
    failures.add('semantic_clock_prompt_unproved');
  if (!Array.isArray(invocations)) return [...failures, 'semantic_clock_invocations_unproved'];
  const allowed =
    receipt.caseId === '01' || receipt.caseId === '14'
      ? ['search_memory', 'list_memory_proposals']
      : receipt.caseId === '12'
        ? ['search_memory']
        : receipt.caseId === '20'
          ? ['search_program_elements', 'get_program_element', 'get_pe_budget_timeline']
          : receipt.caseId === '72'
            ? ['read_client_documents']
            : [];
  if (!allowed.length) failures.add('semantic_clock_case_not_admitted');
  const calls = new Map<string, MeriCaptureToolCallObservation>();
  for (const call of receipt.toolCalls) {
    if (!call.callId?.trim() || calls.has(call.callId) || !call.readOnly || call.attempt !== 1)
      failures.add('semantic_clock_logical_calls_invalid');
    calls.set(call.callId, call);
  }
  const seen = new Set<string>();
  const packets = new Set<string>();
  for (const attempt of invocations) {
    if (!attempt || typeof attempt.callId !== 'string' || !Array.isArray(attempt.packets)) {
      failures.add('semantic_clock_invocation_join_unproved');
      continue;
    }
    const call = calls.get(attempt.callId);
    const controlled =
      receipt.controlledReadAttempts?.filter((row) => row.callId === attempt.callId) ?? [];
    const expectedUnavailable =
      receipt.caseId === '72' &&
      controlled.length === 1 &&
      controlled[0]!.logicalError === 'document unavailable';
    if (
      !call ||
      call.localDiscovery ||
      seen.has(attempt.callId) ||
      call.name !== attempt.tool ||
      !allowed.includes(attempt.tool) ||
      attempt.httpAttempts !== 1 ||
      attempt.httpStatus !== 200 ||
      !/^[a-f0-9]{64}$/.test(attempt.responseSha256 ?? '') ||
      (attempt.outcome !== 'returned' && !(expectedUnavailable && attempt.outcome === 'threw')) ||
      !(
        expectedUnavailable ? ['failed', 'unavailable'] : ['complete', 'empty', 'partial']
      ).includes(call.status)
    )
      failures.add('semantic_clock_invocation_join_unproved');
    seen.add(attempt.callId);
    if (attempt.tool !== 'list_memory_proposals' && attempt.proposalRead !== undefined)
      failures.add('semantic_clock_proposal_read_unproved');
    if (attempt.tool === 'search_memory') {
      if (!Array.isArray(attempt.packets) || !attempt.packets.length || attempt.packets.length > 2)
        failures.add('semantic_clock_tool_packets_unproved');
      for (const packet of attempt.packets ?? []) {
        if (!validClockPacket(packet, binding, receipt) || packets.has(packet.packetId))
          failures.add('semantic_clock_tool_packets_unproved');
        if (packet?.packetId) packets.add(packet.packetId);
      }
      if (controlled.length) failures.add('semantic_clock_unexpected_controlled_read');
    } else if (attempt.tool === 'list_memory_proposals') {
      const proof = attempt.proposalRead;
      if (
        !proof ||
        proof.authority !== 'own_pending_proposals' ||
        proof.tenantId !== receipt.tenantId ||
        proof.actorUserId !== receipt.actorUserId ||
        typeof receipt.clientId !== 'string' ||
        !receipt.clientId.trim() ||
        proof.clientId !== receipt.clientId ||
        proof.semanticTime !== 'not_used' ||
        proof.compiler !== 'not_run' ||
        proof.claimsAreApprovedFacts !== false ||
        !['complete', 'empty'].includes(proof.coverage) ||
        // The generic logical observer calls an empty `candidates` page complete;
        // only the actual proposal response establishes that its owned queue is empty.
        (proof.coverage === 'empty'
          ? !['complete', 'empty'].includes(call?.status ?? '')
          : proof.coverage !== call?.status) ||
        attempt.packets.length !== 0 ||
        controlled.length !== 0 ||
        !Array.isArray(call?.sourceIds) ||
        call.sourceIds.length !== 0 ||
        receipt.sources.some((source) => source.toolCallId === attempt.callId)
      )
        failures.add('semantic_clock_proposal_read_unproved');
    } else {
      const row = controlled[0];
      if (
        attempt.packets?.length !== 0 ||
        controlled.length !== 1 ||
        !row ||
        row.tool !== attempt.tool ||
        row.httpStatus !== 200 ||
        row.caseId !== receipt.caseId ||
        row.requestId !== receipt.requestId ||
        row.traceId !== receipt.traceId ||
        row.turnId !== receipt.turnId ||
        row.captureRunId !== receipt.captureRunId ||
        row.responseSha256 !== attempt.responseSha256 ||
        (row.logicalError && !expectedUnavailable)
      )
        failures.add('semantic_clock_controlled_read_join_unproved');
    }
  }
  for (const call of calls.values()) {
    if (call.localDiscovery) {
      if (
        !['tool_search', 'tool_describe'].includes(call.name) ||
        call.status !== 'complete' ||
        seen.has(call.callId)
      )
        failures.add('semantic_clock_local_discovery_unproved');
    } else if (!seen.has(call.callId)) failures.add('semantic_clock_invocation_missing');
  }
  if (receipt.controlledReadAttempts?.some((row) => !seen.has(row.callId)))
    failures.add('semantic_clock_controlled_read_extra');
  return [...failures];
}

function validClockPacket(
  packet: MeriCaptureCompilerPacket,
  binding: MeriFixtureSemanticClock,
  receipt: Pick<MeriCaptureEvidenceReceipt, 'startedAt' | 'completedAt'>,
): boolean {
  const use = packet?.clockUse;
  return (
    !!packet &&
    typeof packet.packetId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      packet.packetId,
    ) &&
    packet.persisted === true &&
    !!use &&
    use.instant === binding.instant &&
    use.timeZone === binding.timeZone &&
    ['used', 'not_run'].includes(use.scoring) &&
    Number.isFinite(Date.parse(use.eligibilityAt)) &&
    Date.parse(use.eligibilityAt) >= binding.observedAt &&
    Date.parse(use.eligibilityAt) <= receipt.completedAt
  );
}

/** Case20's source is tenant-owned public evidence, not selected-client memory.
 * Only its actual fully-read controlled HTTP proof can establish that scope. */
function qualifiedCase20PublicSource(
  receipt: Omit<MeriCaptureEvidenceReceipt, 'status' | 'blockers'>,
  source: MeriCaptureSourceObservation,
): boolean {
  if (
    receipt.caseId !== '20' ||
    !receipt.clientId ||
    !receipt.semanticClock ||
    source.clientId.status !== 'OBSERVED' ||
    source.clientId.value !== null ||
    source.tenantId.status !== 'OBSERVED' ||
    source.tenantId.value !== receipt.tenantId ||
    source.fullRead.status !== 'OBSERVED' ||
    source.fullRead.value !== true ||
    source.currentVersion.status !== 'OBSERVED' ||
    source.passageSha256.status !== 'OBSERVED' ||
    source.byteSha256.status !== 'OBSERVED' ||
    !/^[a-f0-9]{64}$/.test(source.passageSha256.value ?? '') ||
    source.passageSha256.value !== source.byteSha256.value ||
    meriCaptureClockExecutionBlockers(receipt).length
  )
    return false;
  const calls = receipt.toolCalls.filter((call) => call.callId === source.toolCallId);
  const attempts = (receipt.controlledReadAttempts ?? []).filter(
    (a) => a.callId === source.toolCallId,
  );
  if (calls.length !== 1 || attempts.length !== 1) return false;
  const call = calls[0]!;
  const attempt = attempts[0]!;
  return (
    call.status === 'complete' &&
    call.sourceIds.length === 1 &&
    call.sourceIds[0] === source.sourceId &&
    attempt.tool === call.name &&
    attempt.sourceId === source.sourceId &&
    attempt.logicalSourceId === 'R2-27' &&
    attempt.sourceTenantId === receipt.tenantId &&
    attempt.sourceClientId === null &&
    attempt.fullRead === true &&
    attempt.sourceVersion === source.currentVersion.value &&
    attempt.contentSha256 === source.byteSha256.value &&
    attempt.passageSha256 === source.passageSha256.value &&
    attempt.currentVerifySha256 === receipt.semanticClock.binding.currentVerifySha256
  );
}

export function meriCaptureReceiptBlockers(
  receipt: Omit<MeriCaptureEvidenceReceipt, 'status' | 'blockers'>,
): string[] {
  const blockers = new Set<string>();
  if (receipt.semanticClock) {
    for (const blocker of meriCaptureClockExecutionBlockers(receipt)) blockers.add(blocker);
    const { binding, api, apiJoin, invocations } = receipt.semanticClock;
    if (
      apiJoin !== 'VERIFIED' ||
      !api ||
      api.relativeToolWindows !== 'NOT_APPLICABLE' ||
      !validClockPacket(api.initial, binding, receipt) ||
      !Array.isArray(api.tools) ||
      !Array.isArray(invocations) ||
      canonicalJson(api.tools) !==
        canonicalJson(
          invocations.flatMap((row) => (Array.isArray(row?.packets) ? row.packets : [])),
        ) ||
      api.tools.some((row) => !row || row.packetId === api.initial.packetId)
    )
      blockers.add('semantic_clock_api_tool_join_pending');
  }
  const requiredValues: Array<[string, MeriCaptureObservedValue<unknown>]> = [
    ['fixture_version', receipt.fixture.version],
    ['fixture_physical_map', receipt.fixture.physicalMapSha256],
    ['api_release', receipt.releases.api.releaseRevision],
    ['orchestrator_release', receipt.releases.orchestrator.releaseRevision],
    ['provider', receipt.usage.provider],
    ['model', receipt.usage.model],
    ['input_tokens', receipt.usage.inputTokens],
    ['output_tokens', receipt.usage.outputTokens],
  ];
  if (receipt.caseId === '12') {
    const setup = receipt.fixture.case12Setup;
    try {
      if (setup?.status !== 'OBSERVED') throw new Error('setup_unobserved');
      const binding = readMeriCase12SetupBinding(setup.value);
      if (
        binding.setupRunId === receipt.captureRunId ||
        receipt.fixture.resetReceiptId.status === 'OBSERVED' ||
        receipt.fixture.resetReceiptId.value !== null ||
        receipt.fixture.seedReceiptId.status === 'OBSERVED' ||
        receipt.fixture.seedReceiptId.value !== null
      )
        throw new Error('setup_mixed_provenance');
    } catch {
      blockers.add('fixture_case12_setup_unproved');
    }
  } else {
    requiredValues.push(
      ['fixture_reset_receipt', receipt.fixture.resetReceiptId],
      ['fixture_seed_receipt', receipt.fixture.seedReceiptId],
    );
    if (Object.hasOwn(receipt.fixture, 'case12Setup'))
      blockers.add('fixture_case12_setup_foreign_case');
  }
  if (!receipt.caseId) blockers.add('case_id_missing');
  if (!receipt.captureRunId) blockers.add('capture_run_id_missing');
  if (!receipt.turnId) blockers.add('turn_id_missing');
  if (receipt.providerBudget) {
    const budget = receipt.providerBudget;
    if (
      budget.version !== 1 ||
      !(
        (receipt.caseId === '01' && budget.boundary === 'case01_memory_turn') ||
        (receipt.caseId === '12' && budget.boundary === 'case12_memory_turn') ||
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
      // The declared ceiling is accounting context: capture budgets are
      // ledger-only, so charged spend may legitimately exceed it and the
      // receipt carries both figures without gating on their order.
      budget.maxCostMicros <= 0
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
    if (
      (source.clientId.status !== 'OBSERVED' || source.clientId.value !== receipt.clientId) &&
      !qualifiedCase20PublicSource(receipt, source)
    ) {
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
  if (policy.semanticClock) validateMeriFixtureSemanticClock(policy.semanticClock, policy);
  if (
    canonicalJson(receipt.semanticClock?.binding ?? null) !==
    canonicalJson(policy.semanticClock ?? null)
  )
    throw new Error('meri_capture_evidence_semantic_clock_mismatch');
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
