import { NotFoundException } from '@nestjs/common';
import { prospectResourceScope, requireProspectBriefFeatureInTx } from '@capiro/shared';
import type {
  TenantContext,
  PrepareBriefRefreshInput,
  RetainedBriefRefreshIdentity,
} from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { composeRefresh } from './composition.js';
import { refreshConflict } from './composition.js';
import { sha256Hex } from '../bizdev-brief.util.js';

export type RetainedRefresh = RetainedBriefRefreshIdentity & ReturnType<typeof composeRefresh>;
export type RefreshTransaction = Prisma.TransactionClient;
export const refreshVersionKey = (proposalId: string) => 'brief-refresh:' + proposalId;
export const refreshFingerprint = (p: Pick<RetainedRefresh, 'proposalId' | 'proposalHash'>) =>
  sha256Hex({ op: 'accept', proposalId: p.proposalId, proposalHash: p.proposalHash });

export async function requireRefreshScope(
  tx: RefreshTransaction,
  ctx: TenantContext,
  prospectId: string,
  mode: 'read' | 'write',
) {
  // Same lock order as all existing brief writers.
  await tx.$queryRawUnsafe(
    'SELECT id FROM business_development_prospects WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE',
    ctx.tenantId,
    prospectId,
  );
  const scope = await prospectResourceScope(
    tx,
    ctx.tenantId,
    { userId: ctx.userId },
    prospectId,
    mode,
  );
  if (!scope) throw new NotFoundException('Brief not found');
  await requireProspectBriefFeatureInTx(tx, scope);
}
export async function readRetainedRefresh(
  tx: RefreshTransaction,
  ctx: TenantContext,
  prospectId: string,
  proposalId: string,
) {
  const rows = await tx.$queryRawUnsafe<Array<{ payload: RetainedRefresh }>>(
    'SELECT p.payload FROM business_development_brief_refresh_proposals p JOIN business_development_briefs b ON b.tenant_id=p.tenant_id AND b.id=p.brief_id WHERE p.tenant_id=$1::uuid AND b.prospect_id=$2::uuid AND p.id=$3::uuid AND p.created_by_user_id=$4::uuid',
    ctx.tenantId,
    prospectId,
    proposalId,
    ctx.userId,
  );
  const p = rows[0]?.payload;
  if (p && sha256Hex({ ...p, proposalHash: undefined }) !== p.proposalHash)
    refreshConflict('The retained refresh could not be verified.');
  return p ?? null;
}
export function assertPrepareReplay(p: RetainedRefresh, input: PrepareBriefRefreshInput) {
  if (
    p.expectedVersionNumber !== input.expectedVersionNumber ||
    p.keepUserEdits !== input.keepUserEdits
  )
    refreshConflict('This refresh request already belongs to a different version or edit choice.');
}
export async function retainRefresh(tx: RefreshTransaction, p: RetainedRefresh) {
  await tx.$executeRawUnsafe(
    'INSERT INTO business_development_brief_refresh_proposals (id,tenant_id,brief_id,base_version_id,created_by_user_id,payload,proposal_hash) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::jsonb,$7)',
    p.proposalId,
    p.tenantId,
    p.briefId,
    p.baseVersionId,
    p.createdByUserId,
    JSON.stringify(p),
    p.proposalHash,
  );
}
