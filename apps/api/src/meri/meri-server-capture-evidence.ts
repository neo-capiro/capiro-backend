import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import {
  completeMeriCaptureEvidenceReceipt,
  notRun,
  observed,
  signMeriCaptureEvidenceReceipt,
  unknown,
  type MeriServerReadonlyCapturePolicy,
  type SignedMeriCaptureEvidenceReceipt,
} from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import { assertMeriServerReadonlyCaptureCurrentAuthority } from './meri-server-readonly-capture.js';

function runtimeRevision() {
  const value =
    process.env.GIT_SHA ??
    process.env.SOURCE_VERSION ??
    process.env.CODEBUILD_RESOLVED_SOURCE_VERSION;
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
    ? observed(value)
    : unknown<string>('runtime_release_revision_unavailable');
}

export function buildApiOnlyMeriServerCaptureEvidence(args: {
  policy: MeriServerReadonlyCapturePolicy;
  userMessageId: string;
  assistantMessageId: string;
  citations: ReadonlyArray<{
    id: string;
    snippet?: string | null;
    source?: { version?: string | null; section?: string | null; clientId?: string | null } | null;
    documentEvidence?: { contentHash?: string | null; clientId?: string | null } | null;
  }>;
  usage: { inputTokens: number; outputTokens: number } | null;
  completedAt?: number;
  secret?: string;
}): SignedMeriCaptureEvidenceReceipt {
  const policy = args.policy;
  const captureString = (value: string | null | undefined, reason: string) =>
    value?.trim() ? observed(value.trim()) : unknown<string>(reason);
  const receipt = completeMeriCaptureEvidenceReceipt({
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
    startedAt: policy.issuedAt,
    completedAt: args.completedAt ?? Date.now(),
    expiresAt: policy.expiresAt,
    sources: args.citations.map((citation) => ({
      sourceId: citation.id,
      toolCallId: 'NOT_RUN',
      tenantId: unknown('canonical_source_tenant_owner_not_bound_on_raw_path'),
      clientId:
        citation.documentEvidence?.clientId !== undefined || citation.source?.clientId !== undefined
          ? observed(citation.documentEvidence?.clientId ?? citation.source?.clientId ?? null)
          : unknown('canonical_source_client_owner_not_bound_on_raw_path'),
      currentVersion: captureString(
        citation.source?.version,
        'canonical_current_version_not_reported',
      ),
      fullRead: unknown('raw_source_full_read_coverage_not_reported'),
      locator: captureString(citation.source?.section, 'canonical_locator_not_reported'),
      passageSha256:
        typeof citation.snippet === 'string' && citation.snippet.length > 0
          ? observed(createHash('sha256').update(citation.snippet, 'utf8').digest('hex'))
          : unknown('observed_passage_bytes_not_reported'),
      byteSha256:
        typeof citation.documentEvidence?.contentHash === 'string' &&
        /^[a-f0-9]{64}$/.test(citation.documentEvidence.contentHash)
          ? observed(citation.documentEvidence.contentHash)
          : unknown('canonical_source_bytes_not_reported'),
    })),
    toolCalls: [],
    usage: {
      provider: notRun('provider_owner_adapter_not_bound_on_raw_path'),
      model: notRun('effective_model_owner_adapter_not_bound_on_raw_path'),
      inputTokens: args.usage
        ? observed(args.usage.inputTokens)
        : unknown('provider_usage_not_reported'),
      outputTokens: args.usage
        ? observed(args.usage.outputTokens)
        : unknown('provider_usage_not_reported'),
      cacheReadTokens: unknown('cache_read_usage_not_reported'),
      cacheCreationTokens: unknown('cache_creation_usage_not_reported'),
      estimatedCostUsd: notRun('existing_pricing_adapter_not_bound_on_raw_path'),
      costKind: 'unknown',
    },
    releases: {
      api: {
        service: 'api',
        releaseRevision: runtimeRevision(),
        identityContract: 'runtime_environment_v1',
        deploymentProof: 'PENDING_APPROVED_BUILD_RECEIPT_CROSSCHECK',
      },
      orchestrator: {
        service: 'meriv2-orchestrator',
        releaseRevision: notRun('orchestrator_capture_observation_not_run'),
        identityContract: 'runtime_environment_v1',
        deploymentProof: 'PENDING_APPROVED_BUILD_RECEIPT_CROSSCHECK',
      },
    },
    fixture: {
      namespace: policy.fixtureNamespace,
      version: captureString(policy.fixtureVersion, 'fixture_version_binding_pending'),
      physicalMapSha256: captureString(
        policy.physicalMapSha256,
        'fixture_physical_map_binding_pending',
      ),
      resetReceiptId: captureString(policy.resetReceiptId, 'fixture_reset_receipt_binding_pending'),
      seedReceiptId: captureString(policy.seedReceiptId, 'fixture_seed_receipt_binding_pending'),
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
        {
          logicalWriteId: `${policy.requestId}:user-message`,
          kind: 'conversation_user_message',
          phase: 'during',
          status: 'observed',
          recordId: args.userMessageId,
        },
        {
          logicalWriteId: `${policy.requestId}:assistant-message`,
          kind: 'conversation_assistant_message',
          phase: 'during',
          status: 'observed',
          recordId: args.assistantMessageId,
        },
        {
          logicalWriteId: `${policy.requestId}:receipt-metadata`,
          kind: 'assistant_receipt_metadata',
          phase: 'after',
          status: 'observed',
          recordId: args.assistantMessageId,
        },
      ],
      logicalEffects: [],
    },
    predecessorAttestationSha256: null,
  });
  return signMeriCaptureEvidenceReceipt(
    receipt,
    args.secret ?? process.env.INTERNAL_SERVICE_SECRET,
  );
}

export async function persistMeriServerCaptureEvidenceReceipt(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
  assistantMessageId: string;
  receipt: SignedMeriCaptureEvidenceReceipt;
}): Promise<void> {
  await assertMeriServerReadonlyCaptureCurrentAuthority({
    prisma: args.prisma,
    ctx: args.ctx,
    policy: args.policy,
  });
  await args.prisma.withTenant(args.ctx.tenantId, async (tx) => {
    const where = {
      id: args.assistantMessageId,
      tenantId: args.ctx.tenantId,
      userId: args.ctx.userId,
      conversationId: args.policy.conversationId,
      clientId: args.policy.clientId,
      role: 'assistant',
    } as const;
    const current = await tx.clioMessage.findFirst({ where, select: { metadata: true } });
    if (!current) throw new Error('meri_capture_assistant_message_readback_missing');
    const metadata =
      current.metadata && typeof current.metadata === 'object' && !Array.isArray(current.metadata)
        ? (current.metadata as Record<string, unknown>)
        : {};
    await tx.clioMessage.update({
      where: { id: args.assistantMessageId },
      data: {
        metadata: {
          ...metadata,
          serverCaptureEvidenceReceipt: args.receipt,
        } as unknown as import('@prisma/client').Prisma.InputJsonValue,
      },
    });
    const readback = await tx.clioMessage.findFirst({ where, select: { metadata: true } });
    const readbackMetadata =
      readback?.metadata &&
      typeof readback.metadata === 'object' &&
      !Array.isArray(readback.metadata)
        ? (readback.metadata as Record<string, unknown>)
        : null;
    if (!isDeepStrictEqual(readbackMetadata?.serverCaptureEvidenceReceipt, args.receipt)) {
      throw new Error('meri_capture_receipt_readback_mismatch');
    }
  });
  await assertMeriServerReadonlyCaptureCurrentAuthority({
    prisma: args.prisma,
    ctx: args.ctx,
    policy: args.policy,
  });
}
