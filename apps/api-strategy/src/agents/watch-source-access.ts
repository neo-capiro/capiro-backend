import { NotFoundException } from '@nestjs/common';
import { clientMemoryAllowed } from '@capiro/shared';
import type { Prisma } from '../../generated/prisma-client/index.js';

/** Current Core-owned membership/client/wall rows, held through the caller's
 * short transaction. Uses the canonical shared wall predicate, not a cached
 * TenantGuard result or an old mission creator's implicit authority. */
export async function requireWatchSourceAccess(
  tx: Prisma.TransactionClient, tenantId: string, clientId: string, clerkUserId: string | null | undefined,
): Promise<void> {
  const unavailable = () => { throw new NotFoundException('Strategy sources unavailable'); };
  if (!clerkUserId) return unavailable();
  // Same client -> current actor -> grant order as Core's client record owner.
  const clients = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM clients WHERE tenant_id=$1::uuid AND id=$2::uuid
     AND status::text<>'archived' FOR SHARE`, tenantId, clientId);
  if (clients.length !== 1) return unavailable();
  const members = await tx.$queryRawUnsafe<Array<{ userId: string }>>(
    `SELECT u.id::text AS "userId" FROM tenant_memberships m JOIN users u ON u.id=m.user_id
     JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1::uuid
     AND u.clerk_user_id=$2 AND m.status::text='active' AND t.status::text='active'
     AND m.role::text IN ('standard_user','user_admin','capiro_admin') FOR SHARE OF m,u,t`,
    tenantId, clerkUserId);
  if (members.length !== 1) return unavailable();
  const userId = members[0]!.userId;
  await tx.$queryRawUnsafe(
    `SELECT id FROM client_memory_access WHERE tenant_id=$1::uuid
     AND client_id=$2::uuid AND user_id=$3::uuid FOR SHARE`, tenantId, clientId, userId);
  if (!(await clientMemoryAllowed(tx, tenantId, userId, clientId))) return unavailable();
}
