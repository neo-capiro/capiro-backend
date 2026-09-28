import { createHash, randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { MERI_CAPABILITY_REGISTRY, type TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import type {
  MeriServerReadonlyCapturePolicy,
  MeriServerReadonlyCaptureReceipt,
} from '@capiro/meriv2-core';
import {
  decodeAndVerifyMeriCapturePolicyTransport,
  MERI_CAPTURE_POLICY_HEADER,
  MERI_CAPTURE_POLICY_NAMESPACE,
  type MeriCaptureTransportPurpose,
} from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';

const SYNTHETIC_TENANTS: ReadonlyMap<
  string,
  'meri-foundation-20260928-t1' | 'meri-foundation-20260928-t2'
> = new Map([
  ['f2d6cf8f-057c-479a-8110-62fe5086d43f', 'meri-foundation-20260928-t1'],
  ['52e91176-08f0-4d89-9633-bc212f5bdbbf', 'meri-foundation-20260928-t2'],
] as const);
const POLICY_TTL_MS = 30 * 60_000;

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

export function isMeriReadonlyCaptureTenant(ctx: Pick<TenantContext, 'tenantId' | 'tenantSlug'>): boolean {
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
  const conversation = await currentCaptureAuthorityRows(args.prisma, args.ctx, args.conversationId);
  const policy: MeriServerReadonlyCapturePolicy = {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: randomUUID(),
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
    expectedCaptureWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
    ] as const,
  };
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
  if (!conversation || conversation.clientId !== policy.clientId) {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function currentCaptureAuthorityRows(
  prisma: PrismaService,
  ctx: TenantContext,
  conversationId: string,
): Promise<{
  clientId: string | null;
  client: { id: string; name: string } | null;
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
      clientId: conversation.clientId,
      client: client ? { id: client.id, name: client.name } : null,
    };
  });
}

function assertExactCapturePolicy(
  policy: MeriServerReadonlyCapturePolicy,
  ctx: TenantContext,
  now = Date.now(),
): void {
  if (
    policy.version !== 1 ||
    policy.kind !== 'server_readonly_acceptance_capture' ||
    policy.fixtureNamespace !== MERI_CAPTURE_POLICY_NAMESPACE ||
    policy.tenantId !== ctx.tenantId ||
    policy.tenantSlug !== ctx.tenantSlug ||
    policy.actorUserId !== ctx.userId ||
    policy.expiresAt <= now ||
    policy.toolAuthority !== 'shared_static_registry_read_only' ||
    policy.toolCatalogSha256 !== meriReadonlyCaptureCatalogSha256() ||
    policy.dynamicMcpAllowed !== false ||
    policy.incidentalWriters !== 'suppressed' ||
    policy.expectedCaptureWrites.length !== 3 ||
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
