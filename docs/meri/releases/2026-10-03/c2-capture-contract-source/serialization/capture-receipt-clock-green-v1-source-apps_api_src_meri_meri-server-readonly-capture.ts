import { createHash, randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { MERI_CAPABILITY_REGISTRY, type TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import type {
  MeriServerReadonlyCapturePolicy,
  MeriServerReadonlyCaptureReceipt,
  SignedMeriCaptureEvidenceReceipt,
  MeriCaptureClockApiJoin,
} from '@capiro/meriv2-core';
import {
  completeMeriCaptureEvidenceReceipt,
  decodeAndVerifyMeriCapturePolicyTransport,
  meriCaptureEvidenceEnvelopeSha256,
  MERI_CAPTURE_POLICY_HEADER,
  MERI_CAPTURE_POLICY_NAMESPACE,
  observed,
  signMeriCaptureEvidenceReceipt,
  type MeriCaptureTransportPurpose,
  unknown,
  validateMeriSyntheticReadBudgetGuard,
  verifyMeriCaptureEvidenceReceipt,
} from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  syntheticReadBudgetHash,
  validateSyntheticReadBudgetQualification,
  type SyntheticReadProviderBudgetQualification,
} from './meri-synthetic-read-budget.js';

const SYNTHETIC_TENANTS: ReadonlyMap<
  string,
  'meri-foundation-20260928-t1' | 'meri-foundation-20260928-t2'
> = new Map([
  ['f2d6cf8f-057c-479a-8110-62fe5086d43f', 'meri-foundation-20260928-t1'],
  ['52e91176-08f0-4d89-9633-bc212f5bdbbf', 'meri-foundation-20260928-t2'],
] as const);
const POLICY_TTL_MS = 30 * 60_000;
const CAPTURE_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const CAPTURE_OUTPUT_MAX_CHUNKS = 8_192;

interface MeriCaptureOutputWriter {
  write(data: string): void;
}

export interface MeriServerReadonlyCaptureOutputFence {
  writer: MeriCaptureOutputWriter;
  release(): Promise<void>;
}

export function meriReadonlyCaptureCatalogSha256(): string {
  return createHash('sha256')
    .update(
      MERI_CAPABILITY_REGISTRY.filter((tool) => tool.readOnly === true)
        .map((tool) => tool.name)
        .sort()
        .join('\n'),
    )
    .digest('hex');
}

export function isMeriReadonlyCaptureTenant(
  ctx: Pick<TenantContext, 'tenantId' | 'tenantSlug'>,
): boolean {
  return (
    SYNTHETIC_TENANTS.has(ctx.tenantId) ||
    (typeof ctx.tenantSlug === 'string' &&
      ctx.tenantSlug.startsWith(`${MERI_CAPTURE_POLICY_NAMESPACE}-t`))
  );
}

export function admitMeriServerReadonlyCaptureTransport(args: {
  ctx: TenantContext;
  req: Request;
  purpose: MeriCaptureTransportPurpose;
  toolName?: string | null;
}): MeriServerReadonlyCapturePolicy | null {
  const raw = args.req.headers[MERI_CAPTURE_POLICY_HEADER];
  const encoded = Array.isArray(raw) ? raw[0] : raw;
  if (!encoded && !isMeriReadonlyCaptureTenant(args.ctx)) return null;
  let policy: MeriServerReadonlyCapturePolicy;
  try {
    policy = decodeAndVerifyMeriCapturePolicyTransport(
      typeof encoded === 'string' ? encoded : undefined,
      {
        purpose: args.purpose,
        toolName: args.toolName,
        tenantId: args.ctx.tenantId,
        actorUserId: args.ctx.userId,
      },
      process.env.INTERNAL_SERVICE_SECRET,
    );
  } catch {
    throw captureDenied('trusted_transport_missing_or_invalid');
  }
  if (
    policy.tenantSlug !== args.ctx.tenantSlug ||
    policy.toolCatalogSha256 !== meriReadonlyCaptureCatalogSha256()
  ) {
    throw captureDenied('trusted_transport_scope_rebound');
  }
  if (args.purpose === 'tool') {
    assertMeriServerReadonlyCaptureToolAllowed(args.toolName ?? '', policy);
  } else {
    throw captureDenied('action_proposals_suppressed');
  }
  return policy;
}

export async function issueMeriServerReadonlyCapturePolicy(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  conversationId: string;
  now?: number;
}): Promise<MeriServerReadonlyCapturePolicy | null> {
  const expectedSlug = SYNTHETIC_TENANTS.get(args.ctx.tenantId);
  if (!expectedSlug && !isMeriReadonlyCaptureTenant(args.ctx)) return null;
  if (expectedSlug !== args.ctx.tenantSlug) throw captureDenied('tenant_identity_rebound');
  const issuedAt = args.now ?? Date.now();
  const conversation = await currentCaptureAuthorityRows(
    args.prisma,
    args.ctx,
    args.conversationId,
  );
  const budgetOnly = asRecord(conversation?.metadata)?.syntheticReadBudgetQualification as
    SyntheticReadProviderBudgetQualification | undefined;
  // These source-owned definitions/receipt joins are qualified offline first.
  // Keep live admission closed until the deployed case20 path is verified.
  if (
    !budgetOnly &&
    ['21', '22', '23', '24', '26', '27'].includes(conversation?.captureBinding.caseId ?? '')
  )
    throw captureDenied('controlled_budget_expansion_not_live_qualified');
  if (
    !budgetOnly &&
    ['14', '20', '72'].includes(conversation?.captureBinding.caseId ?? '') &&
    !conversation?.captureBudgetQualified
  )
    throw captureDenied('controlled_provider_qualification_required');
  const policy: MeriServerReadonlyCapturePolicy = {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: randomUUID(),
    requestId: randomUUID(),
    traceId: randomUUID(),
    turnId: null,
    caseId: conversation?.captureBinding.caseId ?? null,
    captureRunId: conversation?.captureBinding.captureRunId ?? null,
    fixtureVersion: conversation?.captureBinding.fixtureVersion ?? null,
    physicalMapSha256: conversation?.captureBinding.physicalMapSha256 ?? null,
    resetReceiptId: conversation?.captureBinding.resetReceiptId ?? null,
    seedReceiptId: conversation?.captureBinding.seedReceiptId ?? null,
    fixtureNamespace: MERI_CAPTURE_POLICY_NAMESPACE,
    tenantId: args.ctx.tenantId,
    tenantSlug: expectedSlug,
    actorUserId: args.ctx.userId,
    conversationId: args.conversationId,
    clientId: conversation?.clientId ?? null,
    issuedAt,
    expiresAt: issuedAt + POLICY_TTL_MS,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: meriReadonlyCaptureCatalogSha256(),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedCaptureWrites: conversation?.captureBudgetQualified
      ? [
          'context_packet_and_evidence',
          'conversation_user_message',
          'conversation_assistant_message',
          'provider_budget_ledger',
        ]
      : [
          'context_packet_and_evidence',
          'conversation_user_message',
          'conversation_assistant_message',
        ],
  };
  if (budgetOnly) {
    policy.syntheticReadBudget = {
      version: 1,
      kind: 'synthetic_read_budget_only',
      caseId: budgetOnly.caseId as '01',
      captureRunId: budgetOnly.captureRunId,
      aggregateReservationId: budgetOnly.aggregateReservationId,
      qualificationSha256: syntheticReadBudgetHash(budgetOnly),
    };
    policy.caseId =
      policy.captureRunId =
      policy.fixtureVersion =
      policy.physicalMapSha256 =
      policy.resetReceiptId =
      policy.seedReceiptId =
        null;
    policy.expiresAt = Date.parse(budgetOnly.deadlineAt);
    policy.expectedCaptureWrites = [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
      'provider_budget_ledger',
    ];
    validateSyntheticReadBudgetQualification(budgetOnly, policy);
  }
  await assertMeriServerReadonlyCaptureCurrentAuthority({
    prisma: args.prisma,
    ctx: args.ctx,
    policy,
    now: issuedAt,
  });
  return Object.freeze(policy);
}

export async function assertMeriServerReadonlyCaptureCurrentAuthority(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy | null;
  now?: number;
}): Promise<{ client: { id: string; name: string } | null } | null> {
  const { policy } = args;
  if (!policy) return null;
  assertExactCapturePolicy(policy, args.ctx, args.now);
  const conversation = await currentCaptureAuthorityRows(
    args.prisma,
    args.ctx,
    policy.conversationId,
  );
  if (policy.syntheticReadBudget) {
    validateSyntheticReadBudgetQualification(
      asRecord(conversation?.metadata)?.syntheticReadBudgetQualification,
      policy,
    );
    if (!conversation || conversation.clientId !== policy.clientId)
      throw captureDenied('server_current_conversation_or_client_authority_missing');
    return { client: conversation.client };
  }
  if (
    !conversation ||
    conversation.clientId !== policy.clientId ||
    conversation.captureBinding.caseId !== policy.caseId ||
    conversation.captureBinding.captureRunId !== policy.captureRunId ||
    conversation.captureBinding.fixtureVersion !== policy.fixtureVersion ||
    conversation.captureBinding.physicalMapSha256 !== policy.physicalMapSha256 ||
    conversation.captureBinding.resetReceiptId !== policy.resetReceiptId ||
    conversation.captureBinding.seedReceiptId !== policy.seedReceiptId
  ) {
    throw captureDenied('server_current_conversation_or_client_authority_missing');
  }
  return { client: conversation.client };
}

export function assertMeriServerReadonlyCaptureTurnInput(args: {
  policy: MeriServerReadonlyCapturePolicy | null;
  mode: 'new' | 'regenerate' | 'resend';
  attachmentIds: readonly string[];
}): void {
  if (!args.policy) return;
  if (args.mode !== 'new') throw captureDenied('rerun_writes_not_authorized');
  if (args.attachmentIds.length) throw captureDenied('attachment_claim_writes_not_authorized');
}

export function assertMeriServerReadonlyCaptureNoArtifactWrites(
  policy: MeriServerReadonlyCapturePolicy | null,
  artifactIds: readonly string[],
): void {
  if (policy && artifactIds.length) throw captureDenied('artifact_writes_not_authorized');
}

/**
 * Holds the explicitly server-owned synthetic capture stream until the turn's
 * asynchronous work is complete and current authority has been re-read. This
 * is intentionally not used for ordinary chat streaming.
 *
 * Release is a point-in-time authority check followed by a synchronous flush;
 * it is not a database lock or an atomic revocation protocol across processes.
 */
export function createMeriServerReadonlyCaptureOutputFence(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
  destination: MeriCaptureOutputWriter;
}): MeriServerReadonlyCaptureOutputFence {
  const chunks: string[] = [];
  let bufferedBytes = 0;
  let exceeded = false;
  let released = false;

  return {
    writer: {
      write(data: string): void {
        if (released || exceeded) return;
        const value = String(data);
        const nextBytes = bufferedBytes + Buffer.byteLength(value, 'utf8');
        if (nextBytes > CAPTURE_OUTPUT_MAX_BYTES || chunks.length >= CAPTURE_OUTPUT_MAX_CHUNKS) {
          exceeded = true;
          chunks.length = 0;
          bufferedBytes = 0;
          return;
        }
        chunks.push(value);
        bufferedBytes = nextBytes;
      },
    },
    async release(): Promise<void> {
      if (released) return;
      if (exceeded) throw captureDenied('private_output_buffer_limit_exceeded');
      await assertMeriServerReadonlyCaptureCurrentAuthority({
        prisma: args.prisma,
        ctx: args.ctx,
        policy: args.policy,
      });
      released = true;
      const ready = chunks.splice(0);
      bufferedBytes = 0;
      for (const chunk of ready) args.destination.write(chunk);
    },
  };
}

export function assertMeriServerReadonlyCaptureToolAllowed(
  name: string,
  policy: MeriServerReadonlyCapturePolicy | null,
  now = Date.now(),
): void {
  if (!policy) return;
  const capability = MERI_CAPABILITY_REGISTRY.find((candidate) => candidate.name === name);
  if (
    policy.expiresAt <= now ||
    policy.toolCatalogSha256 !== meriReadonlyCaptureCatalogSha256() ||
    !capability ||
    capability.readOnly !== true ||
    name === 'run_analysis'
  ) {
    throw captureDenied('tool_dispatch_denied');
  }
}

export function meriServerReadonlyCaptureReceipt(
  policy: MeriServerReadonlyCapturePolicy | null,
): MeriServerReadonlyCaptureReceipt | null {
  if (!policy) return null;
  return {
    version: 1,
    policyId: policy.policyId,
    fixtureNamespace: policy.fixtureNamespace,
    authority: 'server_current',
    tenantId: policy.tenantId,
    actorUserId: policy.actorUserId,
    conversationId: policy.conversationId,
    clientId: policy.clientId,
    issuedAt: policy.issuedAt,
    expiresAt: policy.expiresAt,
    toolCatalogSha256: policy.toolCatalogSha256,
    dispatchBoundary: 'read_only_enforced',
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedCaptureWrites: policy.expectedCaptureWrites,
  };
}

export function finalizeMeriServerCaptureEvidence(args: {
  policy: MeriServerReadonlyCapturePolicy;
  orchestrator: SignedMeriCaptureEvidenceReceipt;
  userMessageId: string;
  assistantMessageId: string;
  completedAt?: number;
  secret?: string;
  clockPackets?: MeriCaptureClockApiJoin | null;
}): SignedMeriCaptureEvidenceReceipt {
  const secret = args.secret ?? process.env.INTERNAL_SERVICE_SECRET;
  const orchestrator = verifyMeriCaptureEvidenceReceipt(
    args.orchestrator,
    args.policy,
    secret,
    args.completedAt,
  );
  const releaseRevision = currentReleaseRevision();
  const semanticClock = orchestrator.semanticClock ? { ...orchestrator.semanticClock } : null;
  // Only the API owner may supply this join. Omit absent evidence before
  // signing: JSON persistence drops undefined, changing the signed payload.
  if (semanticClock) delete semanticClock.api;
  const receipt = completeMeriCaptureEvidenceReceipt({
    ...orchestrator,
    ...(semanticClock ? { semanticClock: {
      ...semanticClock,
      apiJoin: args.clockPackets ? 'VERIFIED' as const : 'PENDING' as const,
      ...(args.clockPackets ? { api: args.clockPackets } : {}),
    } } : {}),
    completedAt: args.completedAt ?? Date.now(),
    releases: {
      ...orchestrator.releases,
      api: {
        service: 'api',
        releaseRevision: releaseRevision
          ? observed(releaseRevision)
          : unknown('runtime_release_revision_unavailable'),
        identityContract: 'runtime_environment_v1',
        deploymentProof: 'PENDING_APPROVED_BUILD_RECEIPT_CROSSCHECK',
      },
    },
    effects: {
      boundary: 'bounded_capture_path_hooks',
      writes: [
        ...orchestrator.effects.writes,
        {
          logicalWriteId: `${args.policy.requestId}:user-message`,
          kind: 'conversation_user_message',
          phase: 'during',
          status: 'observed',
          recordId: args.userMessageId,
        },
        {
          logicalWriteId: `${args.policy.requestId}:assistant-message`,
          kind: 'conversation_assistant_message',
          phase: 'during',
          status: 'observed',
          recordId: args.assistantMessageId,
        },
        {
          logicalWriteId: `${args.policy.requestId}:receipt-metadata`,
          kind: 'assistant_receipt_metadata',
          phase: 'after',
          status: 'observed',
          recordId: args.assistantMessageId,
        },
      ],
      logicalEffects: orchestrator.effects.logicalEffects,
    },
    predecessorAttestationSha256: meriCaptureEvidenceEnvelopeSha256(args.orchestrator),
  });
  return signMeriCaptureEvidenceReceipt(receipt, secret);
}

function currentReleaseRevision(): string | null {
  const value =
    process.env.GIT_SHA ??
    process.env.SOURCE_VERSION ??
    process.env.CODEBUILD_RESOLVED_SOURCE_VERSION;
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function currentCaptureAuthorityRows(
  prisma: PrismaService,
  ctx: TenantContext,
  conversationId: string,
): Promise<{
  clientId: string | null;
  client: { id: string; name: string } | null;
  captureBudgetQualified: boolean;
  metadata: unknown;
  captureBinding: {
    caseId: string | null;
    captureRunId: string | null;
    fixtureVersion: string | null;
    physicalMapSha256: string | null;
    resetReceiptId: string | null;
    seedReceiptId: string | null;
  };
} | null> {
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    const [tenant, actor, membership, conversation] = await Promise.all([
      tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { id: true, slug: true, settings: true },
      }),
      tx.user.findUnique({
        where: { id: ctx.userId },
        select: { id: true, clerkUserId: true, email: true, firstName: true, lastName: true },
      }),
      tx.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
        select: { id: true },
      }),
      tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        select: {
          metadata: true,
          clientId: true,
          client: {
            select: {
              id: true,
              tenantId: true,
              name: true,
              memoryWall: true,
              memoryAccessGrants: {
                where: { userId: ctx.userId },
                select: { id: true },
                take: 1,
              },
            },
          },
        },
      }),
    ]);
    const settings = asRecord(tenant?.settings);
    const fixture = asRecord(settings?.meriFoundationFixture);
    const captureBinding = asRecord(fixture?.captureEvidence);
    const actorName = `${actor?.firstName ?? ''} ${actor?.lastName ?? ''}`.trim();
    const expectedSlug = SYNTHETIC_TENANTS.get(ctx.tenantId);
    const client = conversation?.client;
    if (
      tenant?.id !== ctx.tenantId ||
      tenant.slug !== expectedSlug ||
      fixture?.fixtureNamespace !== MERI_CAPTURE_POLICY_NAMESPACE ||
      actor?.id !== ctx.userId ||
      actor.clerkUserId !== ctx.clerkUserId ||
      !actor.email.toLowerCase().endsWith('@example.com') ||
      !/synthetic/i.test(actorName) ||
      !membership ||
      !conversation ||
      (conversation.clientId !== null &&
        (!client ||
          client.id !== conversation.clientId ||
          client.tenantId !== ctx.tenantId ||
          (client.memoryWall && client.memoryAccessGrants.length === 0)))
    ) {
      throw captureDenied('server_current_fixture_authority_missing');
    }
    return {
      metadata: conversation.metadata,
      clientId: conversation.clientId,
      client: client ? { id: client.id, name: client.name } : null,
      captureBudgetQualified: asRecord(fixture?.captureProviderBudget) !== null,
      captureBinding: {
        caseId: captureString(captureBinding?.caseId, /^(0[1-9]|[1-6][0-9]|7[0-5])$/),
        captureRunId: captureString(captureBinding?.captureRunId),
        fixtureVersion: captureString(captureBinding?.fixtureVersion),
        physicalMapSha256: captureString(captureBinding?.physicalMapSha256, /^[a-f0-9]{64}$/),
        resetReceiptId: captureString(captureBinding?.resetReceiptId),
        seedReceiptId: captureString(captureBinding?.seedReceiptId),
      },
    };
  });
}

function captureString(value: unknown, pattern?: RegExp): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  return !pattern || pattern.test(normalized) ? normalized : null;
}

function assertExactCapturePolicy(
  policy: MeriServerReadonlyCapturePolicy,
  ctx: TenantContext,
  now = Date.now(),
): void {
  validateMeriSyntheticReadBudgetGuard(policy);
  if (
    policy.version !== 1 ||
    policy.kind !== 'server_readonly_acceptance_capture' ||
    policy.fixtureNamespace !== MERI_CAPTURE_POLICY_NAMESPACE ||
    !/^[a-f0-9-]{20,100}$/i.test(policy.requestId) ||
    !/^[a-f0-9-]{20,100}$/i.test(policy.traceId) ||
    (policy.turnId !== null && !policy.turnId.trim()) ||
    policy.tenantId !== ctx.tenantId ||
    policy.tenantSlug !== ctx.tenantSlug ||
    policy.actorUserId !== ctx.userId ||
    policy.expiresAt <= now ||
    (policy.syntheticReadBudget &&
      (policy.expiresAt - policy.issuedAt > POLICY_TTL_MS || policy.issuedAt > now + 30_000)) ||
    policy.toolAuthority !== 'shared_static_registry_read_only' ||
    policy.toolCatalogSha256 !== meriReadonlyCaptureCatalogSha256() ||
    policy.dynamicMcpAllowed !== false ||
    policy.incidentalWriters !== 'suppressed' ||
    (policy.expectedCaptureWrites.length !== 3 &&
      (policy.expectedCaptureWrites.length !== 4 ||
        policy.expectedCaptureWrites[3] !== 'provider_budget_ledger')) ||
    policy.expectedCaptureWrites[0] !== 'context_packet_and_evidence' ||
    policy.expectedCaptureWrites[1] !== 'conversation_user_message' ||
    policy.expectedCaptureWrites[2] !== 'conversation_assistant_message'
  ) {
    throw captureDenied('signed_policy_scope_or_contract_invalid');
  }
}

function captureDenied(reason: string): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: 'meri_server_readonly_capture_denied',
    reason,
    message: 'Server-owned read-only capture authority was denied before dispatch.',
  });
}
