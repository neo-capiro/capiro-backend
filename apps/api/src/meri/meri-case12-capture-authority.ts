import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { meriCase12SetupBindingsEqual, validateMeriCase12SetupPolicyBinding,
  type MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from '../memory/memory-authorization.service.js';
import { assertSyntheticApprovedMemoryInTx } from '../memory/synthetic-approved-memory.helpers.js';
import { assertCase12SyntheticApprovedMemorySetInTx } from '../memory/case12-synthetic-approved-memory-set.read.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { readCase12CanonicalEligibilityInTx } from '../retrieval/adapters/case12-memory-eligibility.read.js';
import { captureBudgetHash } from './meri-capture-provider-budget.js';
import { readCase12SetupCompletionInTx } from './meri-case12-setup-completion.read.js';

interface CorpusProof {
  corpusQualified: boolean;
  caseId: string;
  fixtureNamespace: string;
  fixtureVersion: string;
  fixtureInstanceId: string;
  tenantId: string;
  actorUserId: string;
  clientId: string;
  physicalMapSha256: string;
  setupPlanSha256: string;
  setupClaimSha256: string;
  currentVerifySha256: string;
  sourceMap: Record<string, {frozenFixtureId: string; kind: string; physicalId: string;
    tenantPhysicalId: string; clientPhysicalId: string; version: string; contentSha256: string}>;
  currentVerify: {inventoryCount: number; eligibleMemberCount: number; newerEligibleCount: number;
    target: {physicalId: string; candidateId: string; itemRowVersion: string; sourceVersion: string; contentSha256: string};
    observations: Array<{logicalId: string; physicalId: string; sectionsSha256: string}>};
}
interface OwnerModule {
  createCase12CurrentMemoryOwner(deps: object): {
    inspectInTx(tx: Prisma.TransactionClient, ctx: TenantContext, scope: {caseId: '12'; clientId: string}): Promise<CorpusProof>;
  };
}
let ownerModule: Promise<OwnerModule> | undefined;
function fixedOwner() {
  return ownerModule ??= import(pathToFileURL(resolve(__dirname,
    '../../../../evals/meri/live-v1/fixture-provisioning/case12-memory-current-owner.mjs')).href) as Promise<OwnerModule>;
}
function denied(): never { throw new ForbiddenException('meri_case12_current_setup_and_corpus_required'); }

/** Operator/current-reader seam: completion and current corpus are observed in
 * the supplied native transaction before any capture binding is installed. */
export async function readMeriCase12CompletedCorpusInTx(
  prisma: PrismaService, tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string,
) {
  if (ctx.tenantId !== 'f2d6cf8f-057c-479a-8110-62fe5086d43f' ||
      ctx.tenantSlug !== 'meri-foundation-20260928-t1' || ctx.role !== 'standard_user' ||
      typeof ctx.clerkUserId !== 'string' || !/^user_[A-Za-z0-9_-]+$/.test(ctx.clerkUserId) ||
      process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== 'meri-foundation-20260928') denied();
  const actors = await tx.$queryRaw<Array<{id: string}>>`
    SELECT id FROM users WHERE id=${ctx.userId}::uuid AND clerk_user_id=${ctx.clerkUserId} FOR SHARE`;
  if (actors.length !== 1) denied();
  const owner = (await fixedOwner()).createCase12CurrentMemoryOwner({
    assertSyntheticApprovedMemoryInTx, memoryAuthorization: new MemoryAuthorizationService(prisma),
    assertSyntheticApprovedMemorySetInTx: assertCase12SyntheticApprovedMemorySetInTx,
    readCase12CanonicalEligibilityInTx, clientMemoryAllowed,
  });
  const proof = await owner.inspectInTx(tx, ctx, {caseId: '12', clientId});
  const completion = await readCase12SetupCompletionInTx(tx, ctx, proof);
  return {proof, completion};
}

export type MeriCase12CaptureBinding = Pick<MeriServerReadonlyCapturePolicy,
  'caseId' | 'captureRunId' | 'clientId' | 'tenantId' | 'actorUserId' | 'fixtureNamespace' |
  'fixtureVersion' | 'physicalMapSha256' | 'resetReceiptId' | 'seedReceiptId' |
  'case12Setup' | 'syntheticReadBudget' | 'semanticClock'>;

/** Current native source binding only. Provider admission and aggregate settlement
 * remain separate. The supplied transaction owns every database read below. */
export async function assertMeriCase12BindingInTx(
  prisma: PrismaService, tx: Prisma.TransactionClient, ctx: TenantContext, policy: MeriCase12CaptureBinding,
) {
  try {
    validateMeriCase12SetupPolicyBinding(policy);
    if (policy.caseId !== '12' || policy.syntheticReadBudget || !policy.clientId || !policy.captureRunId ||
        ctx.tenantId !== 'f2d6cf8f-057c-479a-8110-62fe5086d43f' ||
        ctx.tenantSlug !== 'meri-foundation-20260928-t1' || ctx.role !== 'standard_user' ||
        policy.tenantId !== ctx.tenantId || policy.actorUserId !== ctx.userId ||
        process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== 'meri-foundation-20260928') denied();
    const {proof, completion} = await readMeriCase12CompletedCorpusInTx(prisma, tx, ctx, policy.clientId);
    const rows = await tx.$queryRaw<Array<{binding: Record<string, any>}>>`
      SELECT t.settings_jsonb #> '{meriFoundationFixture,captureEvidence}' AS binding
      FROM tenants t JOIN users u ON u.id=${ctx.userId}::uuid AND u.clerk_user_id=${ctx.clerkUserId}
      WHERE t.id=${ctx.tenantId}::uuid FOR SHARE OF t,u
    `;
    const binding = rows[0]?.binding;
    if (rows.length !== 1 || !binding ||
        proof.corpusQualified !== true || proof.caseId !== '12' ||
        proof.tenantId !== ctx.tenantId || proof.actorUserId !== ctx.userId || proof.clientId !== policy.clientId ||
        proof.fixtureNamespace !== policy.fixtureNamespace || proof.fixtureVersion !== policy.fixtureVersion ||
        proof.physicalMapSha256 !== policy.physicalMapSha256 || captureBudgetHash(proof.sourceMap) !== proof.physicalMapSha256 ||
        captureBudgetHash(proof.currentVerify) !== proof.currentVerifySha256 ||
        proof.currentVerify.inventoryCount !== 510 || proof.currentVerify.eligibleMemberCount < 501 ||
        proof.currentVerify.newerEligibleCount < 500 || Object.keys(proof.sourceMap).join('|') !== 'MA510' ||
        binding.caseId !== '12' || binding.captureRunId !== policy.captureRunId || binding.actorUserId !== ctx.userId ||
        binding.clientId !== policy.clientId || binding.currentVerifySha256 !== proof.currentVerifySha256 ||
        binding.fixtureVersion !== proof.fixtureVersion || binding.physicalMapSha256 !== proof.physicalMapSha256 ||
        binding.resetReceiptId !== null || binding.seedReceiptId !== null ||
        !meriCase12SetupBindingsEqual(binding.case12Setup, completion.binding) ||
        !meriCase12SetupBindingsEqual(policy.case12Setup, completion.binding) ||
        (policy.semanticClock && policy.semanticClock.currentVerifySha256 !== proof.currentVerifySha256)) denied();
    const source = proof.sourceMap.MA510!, target = proof.currentVerify.target;
    const currentRows = await tx.$queryRaw<Array<{title: string; sections: unknown; version: string; hash: string; rowVersion: string}>>`
      SELECT title,sections_jsonb AS sections,source_version AS version,source_content_hash AS hash,xmin::text AS "rowVersion"
      FROM memory_items WHERE id=${source.physicalId}::uuid AND tenant_id=${ctx.tenantId}::uuid
        AND client_id=${policy.clientId}::uuid FOR SHARE
    `;
    const actual = currentRows[0], sections = actual?.sections;
    if (currentRows.length !== 1 || source.frozenFixtureId !== 'MA510' || source.kind !== 'memory' ||
        source.tenantPhysicalId !== ctx.tenantId || source.clientPhysicalId !== policy.clientId ||
        source.physicalId !== target.physicalId || source.version !== target.sourceVersion ||
        source.contentSha256 !== target.contentSha256 || actual?.version !== target.sourceVersion ||
        actual.hash !== target.contentSha256 || actual.rowVersion !== target.itemRowVersion ||
        !Array.isArray(sections) || sections.length !== 1 || sections[0]?.key !== 'memory' ||
        sections[0]?.heading !== 'Memory' || sections[0]?.owner !== 'human' ||
        typeof sections[0]?.body !== 'string' || !sections[0].body.trim() || typeof actual.title !== 'string' ||
        proof.currentVerify.observations[0]?.physicalId !== source.physicalId ||
        captureBudgetHash(sections) !== proof.currentVerify.observations[0]?.sectionsSha256) denied();
    const approvedText: string = sections[0].body;
    if (createHash('sha256').update(actual.title + '\0' + approvedText, 'utf8').digest('hex') !== target.contentSha256) denied();
    return {
      fixtureNamespace: proof.fixtureNamespace, fixtureVersion: proof.fixtureVersion,
      physicalMapSha256: proof.physicalMapSha256, currentVerifySha256: proof.currentVerifySha256,
      case12Setup: completion.binding, approvedText,
      approvedPassageSha256: createHash('sha256').update(approvedText, 'utf8').digest('hex'),
      sources: [{logicalId: 'MA510' as const, physicalId: source.physicalId, tenantId: ctx.tenantId,
        clientId: policy.clientId, sourceVersion: source.version, contentSha256: source.contentSha256}],
    };
  } catch { return denied(); }
}
