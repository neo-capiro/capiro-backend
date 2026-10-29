import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from './client-ordered-owner.access.js';

/** Background work derives its actor from the saved run, then uses the same
 * current membership, tenant and client-wall checks as interactive review. */
export function resolveFillRunActor(
  prisma: PrismaService,
  tenantId: string,
  clientId: string,
  runId: string,
): Promise<TenantContext> {
  return prisma.withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe<TenantContext[]>(
      `SELECT r.tenant_id AS "tenantId", r.created_by_user_id AS "userId",
        u.clerk_user_id AS "clerkUserId", t.slug AS "tenantSlug", tm.role
       FROM client_profile_fill_run r
       JOIN tenant_memberships tm ON tm.tenant_id=r.tenant_id AND tm.user_id=r.created_by_user_id
       JOIN users u ON u.id=tm.user_id JOIN tenants t ON t.id=tm.tenant_id
       WHERE r.id=$1::uuid AND r.tenant_id=$2::uuid AND r.client_id=$3::uuid
         AND r.status<>'cancelled' AND tm.status::text='active' AND t.status::text='active'`,
      runId,
      tenantId,
      clientId,
    );
    const actor = rows[0];
    if (!actor) throw new ForbiddenException('The research requester no longer has access');
    await requireOwnerClient(tx, actor, clientId, false, false, 'share');
    return actor;
  });
}
