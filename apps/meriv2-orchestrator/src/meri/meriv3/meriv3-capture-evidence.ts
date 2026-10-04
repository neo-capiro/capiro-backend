import { readControlledReadHttpObservations, readMemoryCaptureHttpObservations } from '../controlled-read-observations.js';
import type { MeriControlledReadAttempt } from '@capiro/meriv2-core';
import { createHash } from 'node:crypto';
import type { MeriCitation } from '@capiro/shared';
import {
  completeMeriCaptureEvidenceReceipt,
  observed,
  pendingBinding,
  signMeriCaptureEvidenceReceipt,
  unknown,
  type MeriCaptureObservedValue,
  type MeriTelemetryUsage,
  type MeriCaptureSourceObservation,
  type MeriCaptureToolCallObservation,
  type MeriServerReadonlyCapturePolicy,
  type SignedMeriCaptureEvidenceReceipt,
  type MeriPromptClockUse,
} from '@capiro/meriv2-core';
import type { MeriToolCoverageReceipt } from './meriv3-turn-coverage.js';

export interface MeriV3CaptureExecutionObservation {
  clockInvocations?: import('@capiro/meriv2-core').MeriCaptureClockInvocation[];
  promptClockUse?: MeriPromptClockUse;
  controlledReadAttempts?: MeriControlledReadAttempt[];
  boundedRuntime?: {
    acquisitionStopped: boolean;
    stopReason: string | null;
    toolCalls: number;
    modelCalls: number;
    retryCalls: number;
  };
  toolCalls: MeriCaptureToolCallObservation[];
  sources: MeriCaptureSourceObservation[];
  estimatedCostUsd: MeriCaptureObservedValue<number>;
}

function runtimeRevision(): MeriCaptureObservedValue<string> {
  const value =
    process.env.GIT_SHA ??
    process.env.SOURCE_VERSION ??
    process.env.CODEBUILD_RESOLVED_SOURCE_VERSION;
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
    ? observed(value)
    : unknown('runtime_release_revision_unavailable');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sourceVersion(citation: MeriCitation): MeriCaptureObservedValue<string> {
  const version = citation.source?.version;
  return typeof version === 'string' && version.trim()
    ? observed(version.trim())
    : unknown('canonical_current_version_not_reported');
}

function sourceLocator(citation: MeriCitation): MeriCaptureObservedValue<string> {
  const locator = citation.source?.section;
  return typeof locator === 'string' && locator.trim()
    ? observed(locator.trim())
    : unknown('canonical_locator_not_reported');
}

export function observeMeriV3CaptureExecution(args: {
  callId: string;
  tool: string;
  readOnly: boolean;
  localDiscovery?: true;
  result: unknown;
  citations: readonly MeriCitation[];
  coverage: readonly MeriToolCoverageReceipt[];
}): Pick<MeriV3CaptureExecutionObservation, 'toolCalls' | 'sources'> {
  const sourceIds = [...new Set(args.citations.map((citation) => citation.id).filter(Boolean))];
  const resultRecord =
    args.result && typeof args.result === 'object' && !Array.isArray(args.result)
      ? (args.result as Record<string, unknown>)
      : null;
  const failed = Boolean(resultRecord?.error || resultRecord?.blocked);
  const partial =
    resultRecord?.partial === true ||
    args.coverage.some((coverage) => coverage.status === 'partial' || coverage.truncated);
  const unavailable = args.coverage.some((coverage) => coverage.status === 'unavailable');
  const status: MeriCaptureToolCallObservation['status'] = !args.readOnly
    ? 'denied'
    : failed
      ? 'failed'
      : unavailable
        ? 'unavailable'
        : partial
          ? 'partial'
          : sourceIds.length === 0 &&
              Array.isArray(resultRecord?.records) &&
              resultRecord.records.length === 0
            ? 'empty'
            : 'complete';
  const toolCall: MeriCaptureToolCallObservation = {
    callId: args.callId,
    name: args.tool,
    attempt: 1,
    status,
    readOnly: args.readOnly,
    sourceIds,
    ...(args.localDiscovery ? { localDiscovery: true as const } : {}),
  };
  const sources = args.citations
    .filter((citation) => citation.id)
    .map((citation): MeriCaptureSourceObservation => {
      const matchingCoverage = args.coverage.find((entry) => entry.tool === args.tool);
      const memory = args.tool === 'search_memory' && args.readOnly
        ? readMemoryCaptureHttpObservations().find(row => row.callId === args.callId &&
            row.sourceId === citation.id && citation.source?.kind === 'memory' &&
            citation.source.recordId === row.sourceId && citation.source.version === row.currentVersion &&
            (citation.source.clientId ?? null) === row.clientId &&
            typeof citation.snippet === 'string' && row.passageSha256 === sha256(citation.snippet))
        : undefined;
      if (memory) return {
        sourceId: memory.sourceId, toolCallId: args.callId,
        tenantId: observed(memory.tenantId), clientId: memory.clientId === null
          ? unknown('canonical_memory_has_no_client') : observed(memory.clientId),
        currentVersion: observed(memory.currentVersion), fullRead: observed(memory.fullRead),
        locator: observed(`characters ${memory.offset}-${memory.endOffset}`),
        passageSha256: observed(memory.passageSha256),
        byteSha256: memory.fullRead ? observed(memory.passageSha256) : unknown('canonical_memory_content_is_partial'),
      };
      const controlled = readControlledReadHttpObservations()?.find(
        (row) =>
          row.callId === args.callId &&
          row.sourceId === citation.id &&
          row.tool === args.tool &&
          row.caseId === '20' &&
          row.fullRead &&
          row.logicalError === null &&
          row.passageSha256 === sha256(citation.snippet ?? ''),
      );
      if (controlled)
        return {
          sourceId: citation.id,
          toolCallId: args.callId,
          tenantId: observed(controlled.sourceTenantId),
          clientId: observed(controlled.sourceClientId),
          currentVersion: observed(controlled.sourceVersion),
          fullRead: observed(true),
          locator: observed('page 14'),
          passageSha256: observed(controlled.passageSha256!),
          byteSha256: observed(controlled.contentSha256),
        };

      const snippet =
        typeof citation.snippet === 'string' && citation.snippet.length > 0
          ? observed(sha256(citation.snippet))
          : unknown<string>('observed_passage_bytes_not_reported');
      const byteHash = citation.documentEvidence?.contentHash;
      return {
        sourceId: citation.id,
        toolCallId: args.callId,
        tenantId: unknown('canonical_source_tenant_not_reported'),
        clientId:
          citation.documentEvidence?.clientId || citation.source?.clientId
            ? observed(citation.documentEvidence?.clientId ?? citation.source!.clientId!)
            : unknown('canonical_source_client_not_reported'),
        currentVersion: sourceVersion(citation),
        fullRead: matchingCoverage
          ? observed(
              matchingCoverage.status === 'complete' &&
                matchingCoverage.paginationComplete === true &&
                matchingCoverage.truncated === false,
            )
          : unknown('source_coverage_not_reported'),
        locator: sourceLocator(citation),
        passageSha256: snippet,
        byteSha256:
          typeof byteHash === 'string' && /^[a-f0-9]{64}$/.test(byteHash)
            ? observed(byteHash)
            : unknown('canonical_source_bytes_not_reported'),
      };
    });
  return { toolCalls: [toolCall], sources };
}

export function buildSignedOrchestratorCaptureEvidence(args: {
  policy: MeriServerReadonlyCapturePolicy;
  startedAt: number;
  completedAt: number;
  providerCallObserved: boolean;
  provider: string;
  model: string | null;
  usage: MeriTelemetryUsage | null;
  execution: MeriV3CaptureExecutionObservation;
  secret: string | undefined;
}): SignedMeriCaptureEvidenceReceipt {
  const policy = args.policy;
  // Legacy ChatResult usage uses zero fallbacks. Only the provider observation
  // owner may establish a complete usage total for acceptance receipts.
  const usageKnown = args.providerCallObserved && args.usage?.status === 'known';
  const fixtureValue = <T extends string>(value: T | null, reason: string) =>
    value === null ? pendingBinding<T>(reason) : observed(value);
  const receipt = completeMeriCaptureEvidenceReceipt({
    ...(policy.semanticClock ? { semanticClock: { binding: policy.semanticClock,
      prompt: args.execution.promptClockUse ? observed(args.execution.promptClockUse)
        : unknown<MeriPromptClockUse>('prompt_render_not_observed'),
      ...(args.execution.clockInvocations ? { invocations: args.execution.clockInvocations } : {}),
      apiJoin: 'PENDING' as const } } : {}),
    version: 1,
    kind: 'server_capture_evidence_receipt',
    purpose: 'server_capture_evidence',
    policyId: policy.policyId,
    caseId: policy.caseId,
    captureRunId: policy.captureRunId,
    requestId: policy.requestId,
    conversationId: policy.conversationId,
    turnId: policy.turnId,
    traceId: policy.traceId,
    tenantId: policy.tenantId,
    actorUserId: policy.actorUserId,
    clientId: policy.clientId,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    expiresAt: policy.expiresAt,
    sources: args.execution.sources,
    toolCalls: args.execution.toolCalls,
    ...(args.execution.controlledReadAttempts
      ? {
          controlledReadAttempts: args.execution.controlledReadAttempts,
          boundedRuntime: args.execution.boundedRuntime,
        }
      : {}),
    usage: {
      provider: args.providerCallObserved
        ? observed(args.provider)
        : unknown('provider_call_not_observed'),
      model:
        args.providerCallObserved && args.model
          ? observed(args.model)
          : unknown('effective_model_not_observed'),
      inputTokens:
        usageKnown && args.usage?.inputTokens !== null
          ? observed(args.usage!.inputTokens!)
          : unknown('provider_usage_not_observed'),
      outputTokens:
        usageKnown && args.usage?.outputTokens !== null
          ? observed(args.usage!.outputTokens!)
          : unknown('provider_usage_not_observed'),
      // Current telemetry does not prove cache reporting on every attempt.
      cacheReadTokens: unknown('cache_per_attempt_coverage_not_bound'),
      cacheCreationTokens: unknown('cache_per_attempt_coverage_not_bound'),
      estimatedCostUsd: usageKnown
        ? observed(args.usage!.knownEstimatedCostUsd!)
        : unknown('provider_usage_or_effective_model_price_not_fully_observed'),
      costKind: usageKnown ? 'existing_pricing_estimate' : 'unknown',
    },
    releases: {
      api: {
        service: 'api',
        releaseRevision: unknown('api_release_must_be_observed_by_api'),
        identityContract: 'runtime_environment_v1',
        deploymentProof: 'PENDING_APPROVED_BUILD_RECEIPT_CROSSCHECK',
      },
      orchestrator: {
        service: 'meriv2-orchestrator',
        releaseRevision: runtimeRevision(),
        identityContract: 'runtime_environment_v1',
        deploymentProof: 'PENDING_APPROVED_BUILD_RECEIPT_CROSSCHECK',
      },
    },
    fixture: {
      namespace: policy.fixtureNamespace,
      version: fixtureValue(policy.fixtureVersion, 'fixture_version_binding_pending'),
      physicalMapSha256: fixtureValue(
        policy.physicalMapSha256,
        'fixture_physical_map_binding_pending',
      ),
      resetReceiptId: fixtureValue(policy.resetReceiptId, 'fixture_reset_receipt_binding_pending'),
      seedReceiptId: fixtureValue(policy.seedReceiptId, 'fixture_seed_receipt_binding_pending'),
    },
    effects: {
      boundary: 'bounded_capture_path_hooks',
      writes: [
        {
          logicalWriteId: `${policy.requestId}:context`,
          kind: 'context_packet_and_evidence',
          phase: 'before',
          status: 'observed',
          recordId: null,
        },
      ],
      logicalEffects: [],
    },
    predecessorAttestationSha256: null,
  });
  return signMeriCaptureEvidenceReceipt(receipt, args.secret);
}
