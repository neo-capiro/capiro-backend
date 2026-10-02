import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from '../memory/memory-authorization.service.js';
import { qualifyCase14RecallInTx } from '../memory/case14-fixture-evidence.js';
import { captureBudgetHash } from './meri-capture-provider-budget.js';
import {
  assertMeriServerReadonlyCaptureCurrentAuthority,
  issueMeriServerReadonlyCapturePolicy,
} from './meri-server-readonly-capture.js';
import { inspectCaptureProviderBudgetReadiness } from './meri-capture-provider-budget-owner.js';
import { validateMeriCapturePolicyPair } from './meri-capture-policy-readback.js';

function denied(): never {
  throw new ForbiddenException('meri_case14_current_approval_required');
}
export async function qualifyMeriCase14RecallInTx(
  prisma: PrismaService,
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  scope: { caseId: '14'; clientId: string; captureRunId: string },
) {
  return qualifyCase14RecallInTx(tx, ctx, new MemoryAuthorizationService(prisma), scope);
}
export async function assertMeriCase14BindingInTx(
  prisma: PrismaService,
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  policy: MeriServerReadonlyCapturePolicy,
) {
  if (
    policy.caseId !== '14' ||
    !policy.clientId ||
    !policy.captureRunId ||
    policy.actorUserId !== ctx.userId ||
    ctx.role !== 'user_admin'
  )
    denied();
  const proof = await qualifyMeriCase14RecallInTx(prisma, tx, ctx, {
    caseId: '14',
    clientId: policy.clientId,
    captureRunId: policy.captureRunId,
  });
  const rows = await tx.$queryRaw<
    Array<{ binding: unknown }>
  >`SELECT settings_jsonb #> '{meriFoundationFixture,captureEvidence}' AS binding FROM tenants WHERE id=${ctx.tenantId}::uuid`;
  const binding = rows[0]?.binding as Record<string, unknown> | undefined;
  if (
    rows.length !== 1 ||
    !binding ||
    proof.fixtureReady !== true ||
    proof.missing.length ||
    proof.tenantId !== ctx.tenantId ||
    proof.actorUserId !== ctx.userId ||
    proof.clientId !== policy.clientId ||
    proof.fixtureNamespace !== policy.fixtureNamespace ||
    proof.fixtureVersion !== policy.fixtureVersion ||
    proof.seedReceiptId !== policy.seedReceiptId ||
    proof.resetReceiptId !== policy.resetReceiptId ||
    proof.physicalMapSha256 !== policy.physicalMapSha256 ||
    captureBudgetHash(proof.sourceMap) !== proof.physicalMapSha256 ||
    captureBudgetHash(proof.currentVerify) !== proof.currentVerifySha256 ||
    binding.caseId !== '14' ||
    binding.captureRunId !== policy.captureRunId ||
    binding.actorUserId !== ctx.userId ||
    binding.clientId !== policy.clientId ||
    binding.currentVerifySha256 !== proof.currentVerifySha256
  )
    denied();
  const owner = proof.currentVerify.canonicalOwner;
  if (owner.state !== 'approved' || !owner.item || !owner.decision) denied();
  return {
    fixtureNamespace: proof.fixtureNamespace,
    fixtureVersion: proof.fixtureVersion,
    physicalMapSha256: proof.physicalMapSha256,
    currentVerifySha256: proof.currentVerifySha256,
    seedReceiptId: proof.seedReceiptId,
    resetReceiptId: proof.resetReceiptId,
    decision: owner.decision,
    candidateId: owner.candidateId,
    approvedText: owner.text,
    sources: [
      {
        logicalId: 'MEM-PROPOSAL-14',
        physicalId: owner.item.id,
        tenantId: ctx.tenantId,
        clientId: policy.clientId,
        sourceVersion: owner.item.sourceVersion,
        contentSha256: owner.item.contentSha256,
      },
    ],
  };
}
async function current(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
}) {
  await assertMeriServerReadonlyCaptureCurrentAuthority(args);
  const fixture = await args.prisma.withTenantUser(args.ctx.tenantId, args.ctx.userId, (tx) =>
    assertMeriCase14BindingInTx(args.prisma, tx, args.ctx, args.policy),
  );
  const providerBudget = await inspectCaptureProviderBudgetReadiness(args);
  await assertMeriServerReadonlyCaptureCurrentAuthority(args);
  return { fixture, providerBudget };
}
export async function readMeriCase14CaptureAdmission(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  conversationId: string;
}) {
  const policy = await issueMeriServerReadonlyCapturePolicy(args);
  if (policy?.caseId !== '14') return undefined;
  if (!/^[a-f0-9]{40}$/.test(process.env.GIT_SHA ?? '')) denied();
  const proof = await current({ ...args, policy });
  return {
    schemaVersion: 1,
    kind: 'meri-case14-authenticated-admission',
    status: 'READY',
    caseId: '14',
    captureRunId: policy.captureRunId,
    conversationId: args.conversationId,
    tenantId: args.ctx.tenantId,
    actorUserId: args.ctx.userId,
    clientId: policy.clientId,
    issuedAt: policy.issuedAt,
    expiresAt: Math.min(policy.expiresAt, policy.issuedAt + 60_000),
    apiReleaseSha: process.env.GIT_SHA,
    toolAuthority: policy.toolAuthority,
    toolCatalogSha256: policy.toolCatalogSha256,
    dynamicMcpAllowed: policy.dynamicMcpAllowed,
    incidentalWriters: policy.incidentalWriters,
    ...proof,
  };
}
export async function readMeriCase14CaptureReadback(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  conversationId: string;
  message: { id: string; role: string; body: string; metadata: unknown };
}) {
  const metadata = args.message.metadata as Record<string, unknown> | null;
  if (!metadata?.serverCaptureEvidenceReceipt) return undefined;
  const policy = validateMeriCapturePolicyPair(
    metadata.serverReadonlyCapturePolicy,
    metadata.serverCaptureEvidenceReceipt,
  );
  if (policy.caseId !== '14') return undefined;
  if (args.message.role !== 'assistant' || policy.conversationId !== args.conversationId) denied();
  return {
    schemaVersion: 1,
    kind: 'meri-case14-authenticated-readback',
    caseId: '14',
    captureRunId: policy.captureRunId,
    conversationId: policy.conversationId,
    tenantId: policy.tenantId,
    actorUserId: policy.actorUserId,
    clientId: policy.clientId,
    messageId: args.message.id,
    turnId: policy.turnId,
    policyId: policy.policyId,
    requestId: policy.requestId,
    traceId: policy.traceId,
    verifiedAt: Date.now(),
    envelopeSha256: captureBudgetHash(metadata.serverCaptureEvidenceReceipt),
    answerSha256: createHash('sha256').update(args.message.body, 'utf8').digest('hex'),
    ...(await current({ ...args, policy })),
  };
}
