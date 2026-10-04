import {
  isMeriControlledReadCase,
  assertMeriControlledReadBindingInTx,
} from './meri-controlled-read-fixture.js';
import type { TenantContext } from '@capiro/shared';
import { assertMeriCase14BindingInTx } from './meri-case14-capture-authority.js';
import { assertMeriCase12BindingInTx } from './meri-case12-capture-authority.js';
import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import { assertMeriServerReadonlyCaptureCurrentAuthority } from './meri-server-readonly-capture.js';
import {
  admitCaptureProviderBudget,
  captureBudgetHash,
  captureProviderBudgetCoverage,
  readCaptureProviderBudget,
  reserveCaptureProviderAttempt,
  settleCaptureProviderAttempt,
  validateCaptureBudgetQualification,
  type CaptureProviderSettlement,
} from './meri-capture-provider-budget.js';
import type { ResearchProviderReservationBinding } from './meri-research-tool-budget.js';

type Operation =
  | { kind: 'admit' }
  | { kind: 'read' }
  | { kind: 'reserve'; binding: ResearchProviderReservationBinding }
  | { kind: 'settle'; input: CaptureProviderSettlement };
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Read-only preflight. A ready reply is not a reservation or a live-run result. */
export async function inspectCaptureProviderBudgetReadiness(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
}) {
  await assertMeriServerReadonlyCaptureCurrentAuthority(args);
  if (args.policy.expectedCaptureWrites[3] !== 'provider_budget_ledger')
    throw new Error('meri_capture_provider_budget_not_qualified');
  return args.prisma.withTenantUser(args.ctx.tenantId, args.ctx.userId, async (tx) => {
    if (isMeriControlledReadCase(args.policy.caseId))
      await assertMeriControlledReadBindingInTx(tx, args.ctx, args.policy);
    if (args.policy.caseId === '14')
      await assertMeriCase14BindingInTx(args.prisma,tx,args.ctx,args.policy);
    if (args.policy.caseId === '12')
      await assertMeriCase12BindingInTx(args.prisma,tx,args.ctx,args.policy);
    const tenant = await tx.tenant.findUnique({
      where: { id: args.ctx.tenantId },
      select: { settings: true },
    });
    const fixture = record(record(tenant?.settings).meriFoundationFixture);
    const binding = record(fixture.captureEvidence);
    const q = validateCaptureBudgetQualification(fixture.captureProviderBudget, args.policy);
    if (
      binding.actorUserId !== args.ctx.userId ||
      binding.clientId !== args.policy.clientId ||
      binding.fixtureNamespace !== args.policy.fixtureNamespace ||
      binding.currentVerifySha256 !== q.currentVerifySha256
    )
      throw new Error('meri_capture_provider_budget_current_fixture_binding_missing');
    return {
      ready: true as const,
      qualificationSha256: captureBudgetHash(q),
      currentVerifySha256: q.currentVerifySha256,
      maxCostMicros: q.maxCostMicros,
      coverage: captureProviderBudgetCoverage(args.policy.caseId),
    };
  });
}

/**
 * All writes share the current tenant/actor/turn authority transaction. Row locks
 * serialize parallel reservations (including multiple API replicas), preserve
 * unrelated metadata, and fence fixture rebinding before the provider can run.
 * The arithmetic reuses the research ledger; no ResearchSession/Run is created.
 */
export async function captureProviderBudgetOwner(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
  operation: Operation;
}) {
  const { prisma, ctx, policy, operation } = args;
  if (
    !policy.caseId ||
    !policy.captureRunId ||
    policy.expectedCaptureWrites[3] !== 'provider_budget_ledger'
  )
    throw new Error('meri_capture_provider_budget_binding_missing');
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${ctx.tenantId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.userId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT user_id FROM tenant_memberships WHERE tenant_id = ${ctx.tenantId}::uuid AND user_id = ${ctx.userId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM clio_conversations WHERE id = ${policy.conversationId}::uuid AND tenant_id = ${ctx.tenantId}::uuid AND user_id = ${ctx.userId}::uuid FOR UPDATE`;
    if (policy.clientId) {
      await tx.$queryRaw`SELECT id FROM clients WHERE id = ${policy.clientId}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT user_id FROM client_memory_access WHERE client_id = ${policy.clientId}::uuid AND user_id = ${ctx.userId}::uuid FOR SHARE`;
    }
    const scoped = {
      withTenant: async (_tenant: string, fn: (inner: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaService;
    await assertMeriServerReadonlyCaptureCurrentAuthority({ prisma: scoped, ctx, policy });
    if (isMeriControlledReadCase(args.policy.caseId))
      await assertMeriControlledReadBindingInTx(tx, args.ctx, args.policy);
    if (args.policy.caseId === '14')
      await assertMeriCase14BindingInTx(args.prisma,tx,args.ctx,args.policy);
    if (args.policy.caseId === '12')
      await assertMeriCase12BindingInTx(args.prisma,tx,args.ctx,args.policy);
    const tenant = await tx.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { settings: true },
    });
    const fixture = record(record(tenant?.settings).meriFoundationFixture);
    const binding = record(fixture.captureEvidence);
    const qualification = record(fixture.captureProviderBudget);
    if (
      binding.actorUserId !== ctx.userId ||
      binding.clientId !== policy.clientId ||
      binding.fixtureNamespace !== policy.fixtureNamespace ||
      typeof binding.currentVerifySha256 !== 'string' ||
      qualification.currentVerifySha256 !== binding.currentVerifySha256
    )
      throw new Error('meri_capture_provider_budget_current_fixture_binding_missing');
    const rows = await tx.$queryRaw<Array<{ metadata: unknown }>>`
      SELECT metadata_jsonb AS metadata FROM clio_conversations
      WHERE id = ${policy.conversationId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        AND user_id = ${ctx.userId}::uuid AND archived_at IS NULL
        AND client_id IS NOT DISTINCT FROM ${policy.clientId}::uuid
      FOR UPDATE`;
    if (rows.length !== 1)
      throw new Error('meri_capture_provider_budget_owned_conversation_missing');
    if (policy.turnId) {
      const turns = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM clio_messages
        WHERE id = ${policy.turnId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
          AND user_id = ${ctx.userId}::uuid AND conversation_id = ${policy.conversationId}::uuid
          AND client_id IS NOT DISTINCT FROM ${policy.clientId}::uuid AND role = 'user' FOR SHARE`;
      if (turns.length !== 1) throw new Error('meri_capture_provider_budget_owned_turn_missing');
    }
    const metadata = record(rows[0]!.metadata);
    const result =
      operation.kind === 'admit'
        ? admitCaptureProviderBudget(metadata, policy, qualification)
        : operation.kind === 'reserve'
          ? reserveCaptureProviderAttempt(metadata, policy, qualification, operation.binding)
          : operation.kind === 'settle'
            ? settleCaptureProviderAttempt(metadata, policy, qualification, operation.input)
            : { metadata, state: readCaptureProviderBudget(metadata, policy, qualification) };
    if (!result.state) throw new Error('meri_capture_provider_budget_admission_missing');
    if (
      operation.kind !== 'read' &&
      captureBudgetHash(metadata) !== captureBudgetHash(result.metadata)
    ) {
      // JSON text avoids Prisma's lossy floating-point JSON serialization. This
      // ledger stores integer micros and token counts, and preserves other fields.
      const json = JSON.stringify(result.metadata);
      const count =
        await tx.$executeRaw`UPDATE clio_conversations SET metadata_jsonb = ${json}::jsonb
        WHERE id = ${policy.conversationId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
          AND user_id = ${ctx.userId}::uuid AND archived_at IS NULL
          AND client_id IS NOT DISTINCT FROM ${policy.clientId}::uuid`;
      if (count !== 1) throw new Error('meri_capture_provider_budget_write_missing');
    }
    return { ...result, state: result.state };
  });
}
