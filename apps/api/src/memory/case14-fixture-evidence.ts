import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { memoryReviewSurfaceEnabled } from './memory-review-switch.js';
import { readCase14ReviewerPreflightInTx } from './case14-reviewer-preflight.js';
import { assertSyntheticCandidateWithdrawalInTx } from './synthetic-candidate-withdrawal.helpers.js';
import { assertSyntheticApprovedMemoryInTx } from './synthetic-approved-memory.helpers.js';

export interface Case14MemoryEvidence {
  kind: 'meri-case14-current-memory-owner';
  schemaVersion: 1;
  caseId: '14';
  fixtureNamespace: string;
  fixtureVersion: string;
  fixtureInstanceId: string;
  manifestContentSha256: string;
  recipeSha256: string;
  seedPlanSha256: string;
  setupReceiptSha256: string;
  tenantId: string;
  clientId: string;
  proposerUserId: string;
  reviewerUserId: string;
  reviewerRole: 'user_admin';
  logicalSourceId: 'MEM-PROPOSAL-14';
  candidateId: string;
  candidateRowVersion: string;
  revision: 1;
  ownershipMarkerSha256: string;
  payloadSha256: string;
  text: string;
  state: 'pending' | 'approved';
  approvalBasis?: string;
  item: null | {
    id: string;
    clioMemoryId: string;
    rowVersion: string;
    sourceVersion: string;
    contentSha256: string;
    status: string;
    governedStatus: string;
  };
  decision: null | { transitionAuditId: string; actorUserId: string; decision: 'approved' };
  currentVerifySha256: string;
}

interface FixedOwnerModule {
  readCase14MemoryOwnerInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    ports: object,
    scope: { candidateId?: string },
  ): Promise<Case14MemoryEvidence | null>;
  qualifyCase14RecallInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    ports: object,
    scope: Case14RecallScope,
  ): Promise<Case14RecallProof>;
  inspectCase14RecallBindingInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    ports: object,
    scope: Case14RecallScope,
  ): Promise<Record<string, unknown>>;
  installCase14RecallBindingInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    ports: object,
    scope: Case14RecallScope & { expectedPlanSha256: string; confirmation: string },
  ): Promise<Record<string, unknown>>;
}
let ownerModule: Promise<FixedOwnerModule> | undefined;
export type Case14RecallScope = { caseId: '14'; clientId: string; captureRunId: string };
export interface Case14RecallProof {
  fixtureReady: true;
  missing: string[];
  liveAcceptance: 'NOT_RUN';
  fixtureNamespace: string;
  fixtureVersion: string;
  tenantId: string;
  actorUserId: string;
  clientId: string;
  caseId: '14';
  captureRunId: string;
  sourceMap: Record<
    string,
    {
      frozenFixtureId: string;
      kind: string;
      physicalId: string;
      tenantPhysicalId: string;
      clientPhysicalId: string;
      version: string;
    }
  >;
  physicalMapSha256: string;
  currentVerify: {
    kind: string;
    schemaVersion: number;
    canonicalOwner: Case14MemoryEvidence;
    seedReceiptSha256: string;
    resetReceiptSha256: string;
  };
  currentVerifySha256: string;
  seedReceiptId: string;
  resetReceiptId: string;
}
function fixedOwner() {
  ownerModule ??= import(
    pathToFileURL(
      resolve(
        __dirname,
        '../../../../evals/meri/live-v1/fixture-provisioning/case14-memory-owner.mjs',
      ),
    ).href
  ) as Promise<FixedOwnerModule>;
  return ownerModule;
}
function ports(authorization: MemoryAuthorizationService) {
  return {
    authorization,
    readCase14ReviewerPreflightInTx,
    assertSyntheticCandidateWithdrawalInTx,
    assertSyntheticApprovedMemoryInTx,
  };
}
export async function qualifyCase14RecallInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  authorization: MemoryAuthorizationService,
  scope: Case14RecallScope,
) {
  return (await fixedOwner()).qualifyCase14RecallInTx(tx, ctx, ports(authorization), scope);
}
export async function inspectCase14RecallBindingInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  authorization: MemoryAuthorizationService,
  scope: Case14RecallScope,
) {
  return (await fixedOwner()).inspectCase14RecallBindingInTx(tx, ctx, ports(authorization), scope);
}
export async function installCase14RecallBindingInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  authorization: MemoryAuthorizationService,
  scope: Case14RecallScope & { expectedPlanSha256: string; confirmation: string },
) {
  return (await fixedOwner()).installCase14RecallBindingInTx(tx, ctx, ports(authorization), scope);
}

/** Optional data on the existing protected review detail. The ordinary actor,
 * participant, wall and content-read checks still run before this owner. */
export async function readCase14FixtureEvidenceInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  authorization: MemoryAuthorizationService,
  candidateId?: string,
): Promise<Case14MemoryEvidence | null> {
  if (
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== 'meri-foundation-20260928' ||
    ctx.tenantId !== 'f2d6cf8f-057c-479a-8110-62fe5086d43f' ||
    ctx.tenantSlug !== 'meri-foundation-20260928-t1' ||
    ctx.role !== 'user_admin' ||
    !memoryReviewSurfaceEnabled()
  )
    return null;
  return (await fixedOwner()).readCase14MemoryOwnerInTx(tx, ctx, ports(authorization), {
    candidateId,
  });
}
