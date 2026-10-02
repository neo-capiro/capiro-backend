import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { memoryReviewSurfaceEnabled } from './memory-review-switch.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function denied(): never {
  throw new Error('CASE14_REVIEWER_CURRENT_AUTHORITY_REQUIRED');
}

export interface Case14ReviewerPreflightInput {
  authorization: MemoryAuthorizationService;
  ctx: TenantContext;
  candidateId: string;
  proposerUserId: string;
  clientId: string;
}

/** Read simulation only. The existing approval endpoint must authorize again;
 * this function issues no database capability, grant, decision or LIVE receipt. */
export async function readCase14ReviewerPreflightInTx(
  tx: Prisma.TransactionClient,
  { authorization, ctx, candidateId, proposerUserId, clientId }: Case14ReviewerPreflightInput,
) {
  if (
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== 'meri-foundation-20260928' ||
    !memoryReviewSurfaceEnabled() ||
    ctx.tenantId !== 'f2d6cf8f-057c-479a-8110-62fe5086d43f' ||
    ctx.tenantSlug !== 'meri-foundation-20260928-t1' ||
    ctx.role !== 'user_admin' ||
    !/^user_[A-Za-z0-9]+$/u.test(ctx.clerkUserId ?? '') ||
    ![ctx.userId, candidateId, proposerUserId, clientId].every((id) => UUID.test(id)) ||
    ctx.userId === proposerUserId
  )
    denied();
  const members = await tx.$queryRawUnsafe<Array<{ role: string; clerkUserId: string }>>(
    `SELECT tm.role,u.clerk_user_id AS "clerkUserId" FROM tenant_memberships tm
     JOIN users u ON u.id=tm.user_id
     WHERE tm.tenant_id=$1::uuid AND tm.user_id=$2::uuid AND tm.status='active'`,
    ctx.tenantId,
    ctx.userId,
  );
  if (
    members.length !== 1 ||
    members[0]?.role !== ctx.role ||
    members[0]?.clerkUserId !== ctx.clerkUserId
  )
    denied();
  const candidates = await tx.$queryRawUnsafe<
    Array<{
      proposedBy: string;
      clientId: string | null;
      status: string;
      scope: string;
      revision: number;
      rowVersion: string;
    }>
  >(
    `SELECT proposed_by::text AS "proposedBy",client_id::text AS "clientId",status,scope,
       revision_number AS revision,xmin::text AS "rowVersion" FROM memory_candidate
     WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    ctx.tenantId,
    candidateId,
  );
  const row = candidates[0];
  if (
    candidates.length !== 1 ||
    !row ||
    row.proposedBy !== proposerUserId ||
    row.clientId !== clientId ||
    row.status !== 'pending' ||
    row.scope !== 'client' ||
    row.revision !== 1 ||
    !/^[0-9]{1,10}$/u.test(row.rowVersion) ||
    Number(row.rowVersion) > 0xffffffff
  )
    denied();
  const subject = await authorization.loadCandidateInTx(tx, ctx.tenantId, candidateId);
  if (
    !subject ||
    subject.id !== candidateId ||
    subject.tenantId !== ctx.tenantId ||
    subject.clientId !== clientId ||
    subject.proposedByUserId !== proposerUserId ||
    subject.legacyCandidateStatus !== 'pending'
  )
    denied();
  const decision = await authorization.evaluateInTx(tx, ctx, subject, 'approve', {
    emitDenialMetrics: false,
  });
  if (!decision.allowed) denied();
  return {
    candidateId,
    clientId,
    proposerUserId,
    reviewerUserId: ctx.userId,
    reviewerRole: 'user_admin' as const,
    rowVersion: row.rowVersion,
    revision: 1 as const,
    basis: decision.basis,
  };
}

export async function readCase14ReviewerPreflight(
  args: Case14ReviewerPreflightInput & { prisma: PrismaService },
) {
  return args.prisma.withTenantUser(args.ctx.tenantId, args.ctx.userId, (tx) =>
    readCase14ReviewerPreflightInTx(tx, args),
  );
}
