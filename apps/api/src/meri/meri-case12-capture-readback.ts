import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { verifyMeriCaptureEvidenceReceipt, type MeriCaptureEvidenceReceipt,
  type MeriServerReadonlyCapturePolicy, type SignedMeriCaptureEvidenceReceipt } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import { assertMeriCase12BindingInTx } from './meri-case12-capture-authority.js';
import { assertMeriServerReadonlyCaptureCurrentAuthority,
  issueMeriServerReadonlyCapturePolicy } from './meri-server-readonly-capture.js';
import { inspectCaptureProviderBudgetReadiness } from './meri-capture-provider-budget-owner.js';
import { validateMeriCapturePolicyPair } from './meri-capture-policy-readback.js';
import { captureBudgetHash } from './meri-capture-provider-budget.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function denied(): never { throw new ForbiddenException('meri_case12_capture_readback_denied'); }
type Fixture = Awaited<ReturnType<typeof assertMeriCase12BindingInTx>>;

/** Input receipt must already have passed signature and policy verification.
 * A signed excerpt or a signed different memory is not the required MA510 read. */
function exactPassage(receipt: MeriCaptureEvidenceReceipt, fixture: Fixture): boolean {
  const target = fixture.sources[0];
  if (!target || target.logicalId !== 'MA510' || fixture.sources.length !== 1) return false;
  const sources = receipt.sources.filter(row => row.sourceId === target.physicalId);
  if (sources.length !== 1) return false;
  const source = sources[0]!;
  const expectedVersion = 'content:' + hash(fixture.approvedText + '\0' + target.sourceVersion);
  const calls = receipt.toolCalls.filter(call => call.callId === source.toolCallId);
  const invocations = receipt.semanticClock?.invocations?.filter(call => call.callId === source.toolCallId);
  return source.tenantId.status === 'OBSERVED' && source.tenantId.value === target.tenantId &&
    source.clientId.status === 'OBSERVED' && source.clientId.value === target.clientId &&
    source.currentVersion.status === 'OBSERVED' && source.currentVersion.value === expectedVersion &&
    source.fullRead.status === 'OBSERVED' && source.fullRead.value === true &&
    source.locator.status === 'OBSERVED' && source.locator.value === `characters 0-${fixture.approvedText.length}` &&
    source.passageSha256.status === 'OBSERVED' && source.passageSha256.value === fixture.approvedPassageSha256 &&
    source.byteSha256.status === 'OBSERVED' && source.byteSha256.value === fixture.approvedPassageSha256 &&
    calls.length === 1 && calls[0]!.name === 'search_memory' && calls[0]!.readOnly &&
    calls[0]!.attempt === 1 && calls[0]!.status === 'complete' &&
    calls[0]!.sourceIds.filter(id => id === target.physicalId).length === 1 &&
    invocations?.length === 1 && invocations[0]!.tool === 'search_memory' &&
    invocations[0]!.outcome === 'returned' && invocations[0]!.httpAttempts === 1 &&
    invocations[0]!.httpStatus === 200;
}

async function current(args: {prisma: PrismaService; ctx: TenantContext; policy: MeriServerReadonlyCapturePolicy}) {
  await assertMeriServerReadonlyCaptureCurrentAuthority(args);
  const fixture = await args.prisma.withTenantUser(args.ctx.tenantId, args.ctx.userId,
    tx => assertMeriCase12BindingInTx(args.prisma, tx, args.ctx, args.policy));
  const providerBudget = await inspectCaptureProviderBudgetReadiness(args);
  await assertMeriServerReadonlyCaptureCurrentAuthority(args);
  return {fixture, providerBudget};
}

/** Read-only preflight. It neither reserves nor consumes a setup/capture claim. */
export async function readMeriCase12CaptureAdmission(args: {
  prisma: PrismaService; ctx: TenantContext; conversationId: string;
}) {
  const policy = await issueMeriServerReadonlyCapturePolicy(args);
  if (policy?.caseId !== '12') return undefined;
  if (!/^[a-f0-9]{40}$/.test(process.env.GIT_SHA ?? '')) denied();
  return {schemaVersion: 1, kind: 'meri-case12-authenticated-admission', status: 'READY',
    caseId: '12', captureRunId: policy.captureRunId, conversationId: args.conversationId,
    tenantId: args.ctx.tenantId, actorUserId: args.ctx.userId, clientId: policy.clientId,
    issuedAt: policy.issuedAt, expiresAt: Math.min(policy.expiresAt, policy.issuedAt + 60_000),
    apiReleaseSha: process.env.GIT_SHA, toolAuthority: policy.toolAuthority,
    toolCatalogSha256: policy.toolCatalogSha256, dynamicMcpAllowed: policy.dynamicMcpAllowed,
    incidentalWriters: policy.incidentalWriters, ...(await current({...args, policy}))};
}

/** Called after ordinary message ownership and persisted-turn authorization.
 * Failed capture evidence remains readable as BLOCKED; it cannot become a pass. */
export async function readMeriCase12CaptureReadback(args: {
  prisma: PrismaService; ctx: TenantContext; conversationId: string;
  message: {id: string; role: string; body: string; metadata: unknown};
}) {
  const metadata = args.message.metadata as Record<string, unknown> | null;
  if (!metadata?.serverCaptureEvidenceReceipt) return undefined;
  const policy = validateMeriCapturePolicyPair(metadata.serverReadonlyCapturePolicy,
    metadata.serverCaptureEvidenceReceipt);
  if (policy.caseId !== '12') return undefined;
  if (args.message.role !== 'assistant' || policy.conversationId !== args.conversationId) denied();
  const receipt = verifyMeriCaptureEvidenceReceipt(
    metadata.serverCaptureEvidenceReceipt as SignedMeriCaptureEvidenceReceipt,
    policy, process.env.INTERNAL_SERVICE_SECRET);
  const proof = await current({...args, policy});
  const passageQualified = exactPassage(receipt, proof.fixture);
  return {schemaVersion: 1, kind: 'meri-case12-authenticated-readback',
    status: passageQualified && receipt.status === 'COMPLETE' ? 'QUALIFIED' : 'BLOCKED',
    caseId: '12', captureRunId: policy.captureRunId, conversationId: policy.conversationId,
    tenantId: policy.tenantId, actorUserId: policy.actorUserId, clientId: policy.clientId,
    messageId: args.message.id, turnId: policy.turnId, policyId: policy.policyId,
    requestId: policy.requestId, traceId: policy.traceId, verifiedAt: Date.now(),
    envelopeSha256: captureBudgetHash(metadata.serverCaptureEvidenceReceipt),
    answerSha256: hash(args.message.body), ma510FullPassageQualified: passageQualified,
    humanAcceptance: 'NOT_RUN', ...proof};
}
