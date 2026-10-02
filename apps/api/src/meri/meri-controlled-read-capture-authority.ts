import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import {
  isMeriReadonlyCaptureTenant,
  issueMeriServerReadonlyCapturePolicy,
} from './meri-server-readonly-capture.js';
import {
  isMeriControlledReadCase,
  readMeriControlledFixture,
} from './meri-controlled-read-fixture.js';
import { inspectCaptureProviderBudgetReadiness } from './meri-capture-provider-budget-owner.js';
import { captureBudgetHash } from './meri-capture-provider-budget.js';
import { validateMeriCapturePolicyPair } from './meri-capture-policy-readback.js';

async function current(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
}) {
  const proof = await readMeriControlledFixture(args);
  return {
    fixtureNamespace: proof.fixtureNamespace,
    fixtureVersion: proof.fixtureVersion,
    physicalMapSha256: proof.physicalMapSha256,
    currentVerifySha256: proof.currentVerifySha256,
    seedReceiptId: proof.seedReceiptId,
    resetReceiptId: proof.resetReceiptId,
    sources: proof.definition.reads.map((read) => ({
      logicalId: read.logicalId,
      physicalId: read.physicalId,
      tenantId: args.ctx.tenantId,
      clientId: args.policy.caseId === '72' ? args.policy.clientId : null,
      sourceVersion: read.version,
      contentSha256: read.contentSha256,
      kind: read.kind,
      sourceStorage: 'immutable_source_owned_controlled_adapter',
      ...(args.policy.caseId === '72'
        ? { fault: { httpStatus: 200, error: 'document unavailable', repeated: true } }
        : {}),
    })),
    ...(proof.definition.coverage !== undefined ? { coverage: proof.definition.coverage } : {}),
  };
}
export async function readMeriControlledCaptureAdmission(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  conversationId: string;
}) {
  if (!isMeriReadonlyCaptureTenant(args.ctx)) return undefined;
  const policy = await issueMeriServerReadonlyCapturePolicy(args);
  if (!policy || !isMeriControlledReadCase(policy.caseId)) return undefined;
  const fixture = await current({ ...args, policy });
  const providerBudget = await inspectCaptureProviderBudgetReadiness({ ...args, policy });
  const apiReleaseSha = process.env.GIT_SHA;
  if (!/^[a-f0-9]{40}$/.test(apiReleaseSha ?? ''))
    throw new Error('meri_controlled_read_release_unproved');
  return {
    schemaVersion: 1,
    kind: 'meri-controlled-read-authenticated-admission',
    status: 'READY',
    caseId: policy.caseId,
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
export async function readMeriControlledCaptureReadback(args: {
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
  if (!isMeriControlledReadCase(policy.caseId)) return undefined;
  if (args.message.role !== 'assistant' || policy.conversationId !== args.conversationId)
    throw new Error('meri_controlled_read_message_mismatch');
  const fixture = await current({ ...args, policy });
  const providerBudget = await inspectCaptureProviderBudgetReadiness({ ...args, policy });
  return {
    schemaVersion: 1,
    kind: 'meri-controlled-read-authenticated-readback',
    caseId: policy.caseId,
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
    fixture,
    providerBudget,
  };
}
