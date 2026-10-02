import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  assertMeriServerReadonlyCaptureCurrentAuthority,
  isMeriReadonlyCaptureTenant,
  issueMeriServerReadonlyCapturePolicy,
} from './meri-server-readonly-capture.js';
import { validateMeriCapturePolicyPair } from './meri-capture-policy-readback.js';
import { inspectCaptureProviderBudgetReadiness } from './meri-capture-provider-budget-owner.js';

import { currentMeriCase01FixtureAuthority } from './meri-case01-fixture-authority-registry.js';
export { registerMeriCase01FixtureAuthority } from './meri-case01-fixture-authority-registry.js';

const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function record(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
function denied(): never {
  throw new ForbiddenException('meri_case01_capture_authority_denied');
}
function assertTuple(policy: MeriServerReadonlyCapturePolicy, ctx: TenantContext) {
  if (
    policy.caseId !== '01' ||
    !UUID.test(policy.captureRunId ?? '') ||
    policy.tenantId !== ctx.tenantId ||
    policy.actorUserId !== ctx.userId ||
    policy.tenantSlug !== ctx.tenantSlug ||
    ctx.role !== 'standard_user' ||
    !UUID.test(policy.clientId ?? '') ||
    policy.fixtureNamespace !== 'meri-foundation-20260928' ||
    policy.fixtureVersion !== 'meri-live-v1-2026-09-26.1' ||
    !HASH.test(policy.physicalMapSha256 ?? '') ||
    !/^meri-synthetic-fixture-seed-receipt:sha256:[a-f0-9]{64}$/.test(policy.seedReceiptId ?? '') ||
    !/^meri-synthetic-fixture-reset-receipt:sha256:[a-f0-9]{64}$/.test(policy.resetReceiptId ?? '')
  )
    denied();
}

async function currentFixture(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
}) {
  const { prisma, ctx, policy } = args;
  assertTuple(policy, ctx);
  const owner = currentMeriCase01FixtureAuthority(prisma);
  if (!owner) denied();
  await assertMeriServerReadonlyCaptureCurrentAuthority(args);
  const result = await prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ settings: unknown }>>`
      SELECT settings_jsonb AS settings FROM tenants WHERE id=${ctx.tenantId}::uuid FOR SHARE
    `;
    const binding = record(
      record(record(rows[0]?.settings)?.meriFoundationFixture)?.captureEvidence,
    );
    if (
      rows.length !== 1 ||
      !binding ||
      binding.actorUserId !== ctx.userId ||
      binding.clientId !== policy.clientId ||
      binding.caseId !== '01' ||
      binding.captureRunId !== policy.captureRunId ||
      binding.fixtureVersion !== policy.fixtureVersion ||
      binding.fixtureNamespace !== policy.fixtureNamespace ||
      binding.physicalMapSha256 !== policy.physicalMapSha256 ||
      binding.seedReceiptId !== policy.seedReceiptId ||
      binding.resetReceiptId !== policy.resetReceiptId ||
      !HASH.test(binding.currentVerifySha256 ?? '')
    )
      denied();
    const proof = record(
      await owner.qualifyInTx(tx, ctx, { caseId: '01', clientId: policy.clientId! }),
    );
    if (
      !proof ||
      proof.fixtureReady !== true ||
      !Array.isArray(proof.missing) ||
      proof.missing.length ||
      proof.caseId !== '01' ||
      proof.tenantId !== ctx.tenantId ||
      proof.actorUserId !== ctx.userId ||
      proof.clientId !== policy.clientId ||
      proof.fixtureNamespace !== policy.fixtureNamespace ||
      proof.fixtureVersion !== policy.fixtureVersion ||
      proof.seedReceiptId !== policy.seedReceiptId ||
      proof.resetReceiptId !== policy.resetReceiptId ||
      proof.physicalMapSha256 !== policy.physicalMapSha256 ||
      !record(proof.sourceMap) ||
      hash(proof.sourceMap) !== proof.physicalMapSha256 ||
      !record(proof.currentVerify) ||
      hash(proof.currentVerify) !== proof.currentVerifySha256 ||
      proof.currentVerifySha256 !== binding.currentVerifySha256 ||
      Object.keys(proof.sourceMap).join(',') !== 'MA1-v2'
    )
      denied();
    const source = record(proof.sourceMap['MA1-v2']);
    const correction = record(record(proof.currentVerify.current)?.correction);
    if (
      !source ||
      !correction ||
      source.frozenFixtureId !== 'MA1-v2' ||
      source.kind !== 'memory' ||
      !UUID.test(source.physicalId ?? '') ||
      source.tenantPhysicalId !== ctx.tenantId ||
      source.clientPhysicalId !== policy.clientId ||
      source.physicalId !== correction.itemId ||
      source.version !== correction.sourceVersion ||
      typeof source.version !== 'string' ||
      !source.version ||
      !HASH.test(correction.sourceContentHash ?? '')
    )
      denied();
    return {
      fixtureNamespace: proof.fixtureNamespace as string,
      fixtureVersion: proof.fixtureVersion as string,
      physicalMapSha256: proof.physicalMapSha256 as string,
      currentVerifySha256: proof.currentVerifySha256 as string,
      seedReceiptId: proof.seedReceiptId as string,
      resetReceiptId: proof.resetReceiptId as string,
      sources: [
        {
          logicalId: 'MA1-v2' as const,
          physicalId: source.physicalId as string,
          tenantId: ctx.tenantId,
          clientId: policy.clientId!,
          sourceVersion: source.version as string,
          contentSha256: correction.sourceContentHash as string,
        },
      ],
    };
  });
  await assertMeriServerReadonlyCaptureCurrentAuthority(args);
  return result;
}

/** Read-only preflight on an already-owned conversation. It never reserves/spends. */
export async function readMeriCase01CaptureAdmission(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  conversationId: string;
}) {
  if (!isMeriReadonlyCaptureTenant(args.ctx)) return undefined;
  if (!currentMeriCase01FixtureAuthority(args.prisma))
    return { status: 'NOT_READY', reason: 'CANONICAL_FIXTURE_OWNER_MISSING' } as const;
  const policy = await issueMeriServerReadonlyCapturePolicy(args);
  if (!policy || policy.caseId !== '01')
    return { status: 'NOT_READY', reason: 'CASE01_BINDING_REQUIRED' } as const;
  const fixture = await currentFixture({ ...args, policy });
  const providerBudget = await inspectCaptureProviderBudgetReadiness({ ...args, policy });
  const apiReleaseSha = process.env.GIT_SHA;
  if (!SHA.test(apiReleaseSha ?? '')) denied();
  return {
    schemaVersion: 1,
    kind: 'meri-case01-authenticated-admission',
    status: 'READY',
    caseId: '01',
    captureRunId: policy.captureRunId,
    conversationId: args.conversationId,
    tenantId: args.ctx.tenantId,
    actorUserId: args.ctx.userId,
    clientId: policy.clientId,
    issuedAt: policy.issuedAt,
    expiresAt: Math.min(policy.expiresAt, policy.issuedAt + 60_000),
    apiReleaseSha,
    toolAuthority: policy.toolAuthority,
    toolCatalogSha256: policy.toolCatalogSha256,
    dynamicMcpAllowed: policy.dynamicMcpAllowed,
    incidentalWriters: policy.incidentalWriters,
    fixture,
    providerBudget,
  };
}

/** Called only after the existing message GET has checked the signed policy and
 * receipt, current ordinary actor/client authority and actual persisted turn.
 * Re-validating that signature here also prevents accidental unsafe direct use.
 */
export async function readMeriCase01CaptureReadback(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  conversationId: string;
  message: { id: string; role: string; body: string; metadata: unknown };
}) {
  const metadata = record(args.message.metadata);
  if (!metadata?.serverCaptureEvidenceReceipt || !currentMeriCase01FixtureAuthority(args.prisma))
    return undefined;
  const policy = validateMeriCapturePolicyPair(
    metadata.serverReadonlyCapturePolicy,
    metadata.serverCaptureEvidenceReceipt,
  );
  if (policy.caseId !== '01') return undefined;
  if (args.message.role !== 'assistant' || policy.conversationId !== args.conversationId) denied();
  const fixture = await currentFixture({ ...args, policy });
  const providerBudget = await inspectCaptureProviderBudgetReadiness({ ...args, policy });
  return {
    schemaVersion: 1,
    kind: 'meri-case01-authenticated-readback',
    caseId: '01',
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
    envelopeSha256: hash(metadata.serverCaptureEvidenceReceipt),
    answerSha256: createHash('sha256').update(args.message.body, 'utf8').digest('hex'),
    fixture,
    providerBudget,
  };
}
