import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

export async function requireOwnerActor(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  write = false,
  lock = false,
) {
  if (!ctx || !isUUID(ctx.tenantId) || !isUUID(ctx.userId) || !ctx.clerkUserId)
    throw new ForbiddenException('Account owner access denied');
  const member = lock
    ? (
        await tx.$queryRaw<Array<{ role: TenantRole }>>`
    SELECT tm.role FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
    JOIN tenants t ON t.id=tm.tenant_id
    WHERE tm.tenant_id=${ctx.tenantId}::uuid AND tm.user_id=${ctx.userId}::uuid
      AND tm.status::text='active' AND u.clerk_user_id=${ctx.clerkUserId} AND t.status::text='active'
    FOR SHARE OF tm, u, t`
      )[0]
    : await tx.tenantMembership.findFirst({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          status: 'active',
          user: { clerkUserId: ctx.clerkUserId },
          tenant: { status: 'active' },
        },
        select: { role: true },
      });
  const rank = member ? ROLE_RANK[member.role] : undefined;
  if (
    typeof rank !== 'number' ||
    member?.role !== ctx.role ||
    rank < ROLE_RANK[write ? 'user_admin' : 'standard_user']
  )
    throw new ForbiddenException('Account owner access denied');
}

export async function requireOwnerClient(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  write = false,
  includeArchived = false,
  lock: 'update' | 'share' = 'update',
) {
  await requireOwnerActor(tx, ctx, write);
  if (!isUUID(clientId)) throw new NotFoundException('Client not found');
  // Client records and ordered/legacy owners retain the exclusive client lock.
  // Batch attachment moves only stabilize authority; SHARE also permits Intel
  // to recheck that same client on its independent read connection.
  // Only the record management owner opts into archived rows for restore/detail;
  // owner editing retains the nonarchived boundary. Readers also lock so their
  // version, ordered rows and legacy projection form one snapshot.
  const rows = await tx.$queryRaw<Array<{ version: number; primary: string | null }>>(Prisma.sql`
    SELECT account_owner_version AS version, account_owner_user_id::text AS primary
    FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=${clientId}::uuid
      AND (${includeArchived} OR status<>'archived') ${lock === 'share' ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR UPDATE`}`);
  if (!rows.length) throw new NotFoundException('Client not found');
  // The client lock may have waited behind another save. Re-read and lock the
  // actor's current membership/identity after that wait, not just before it.
  await requireOwnerActor(tx, ctx, write, true);
  // Revocation is a hard DELETE. Keep an existing grant stable through later
  // owner-member lock waits. The client row lock already protects wall toggles.
  await tx.$queryRaw`SELECT user_id FROM client_memory_access
    WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid
      AND user_id=${ctx.userId}::uuid FOR SHARE`;
  if (!(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId)))
    throw new NotFoundException('Client not found');
  return rows[0]!;
}
