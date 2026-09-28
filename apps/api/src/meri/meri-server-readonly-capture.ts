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
  clientId: string | null;
  now?: number;
}): Promise<MeriServerReadonlyCapturePolicy | null> {
  const expectedSlug = SYNTHETIC_TENANTS.get(args.ctx.tenantId);
  if (!expectedSlug && !isMeriReadonlyCaptureTenant(args.ctx)) return null;
  if (expectedSlug !== args.ctx.tenantSlug) throw captureDenied('tenant_identity_rebound');

  const [tenant, actor] = await Promise.all([
    args.prisma.tenant.findUnique({
      where: { id: args.ctx.tenantId },
      select: { id: true, slug: true, settings: true },
    }),
    args.prisma.user.findUnique({
      where: { id: args.ctx.userId },
      select: { id: true, clerkUserId: true, email: true, firstName: true, lastName: true },
    }),
  ]);
  const settings = asRecord(tenant?.settings);
  const fixture = asRecord(settings?.meriFoundationFixture);
  const actorName = `${actor?.firstName ?? ''} ${actor?.lastName ?? ''}`.trim();
  if (
    tenant?.id !== args.ctx.tenantId ||
    tenant.slug !== expectedSlug ||
    fixture?.fixtureNamespace !== MERI_CAPTURE_POLICY_NAMESPACE ||
    actor?.id !== args.ctx.userId ||
    actor.clerkUserId !== args.ctx.clerkUserId ||
    !actor.email.toLowerCase().endsWith('@example.com') ||
    !/synthetic/i.test(actorName)
  ) {
    throw captureDenied('server_current_fixture_authority_missing');
  }
  const issuedAt = args.now ?? Date.now();
  return Object.freeze({
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: randomUUID(),
    fixtureNamespace: MERI_CAPTURE_POLICY_NAMESPACE,
    tenantId: args.ctx.tenantId,
    tenantSlug: expectedSlug,
    actorUserId: args.ctx.userId,
    conversationId: args.conversationId,
    clientId: args.clientId,
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
  });
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

function captureDenied(reason: string): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: 'meri_server_readonly_capture_denied',
    reason,
    message: 'Server-owned read-only capture authority was denied before dispatch.',
  });
}
