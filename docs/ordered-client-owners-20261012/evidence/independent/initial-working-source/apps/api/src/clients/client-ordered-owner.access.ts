import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
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
  const member = lock ? (await tx.$queryRaw<Array<{ role: TenantRole }>>`
    SELECT tm.role FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
    WHERE tm.tenant_id=${ctx.tenantId}::uuid AND tm.user_id=${ctx.userId}::uuid
      AND tm.status::text='active' AND u.clerk_user_id=${ctx.clerkUserId}
    FOR SHARE OF tm, u`)[0] : await tx.tenantMembership.findFirst({
    where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active',
      user: { clerkUserId: ctx.clerkUserId } },
    select: { role: true },
  });
  const rank = member ? ROLE_RANK[member.role] : undefined;
  if (typeof rank !== 'number' || rank < ROLE_RANK[write ? 'user_admin' : 'standard_user'])
    throw new ForbiddenException('Account owner access denied');
}

export async function requireOwnerClient(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  write = false,
) {
  await requireOwnerActor(tx, ctx, write);
  if (!isUUID(clientId)) throw new NotFoundException('Client not found');
  // All ordered and legacy mutations take the SAME client lock. Readers also
  // lock so their version, ordered rows and legacy projection form one snapshot.
  const rows = await tx.$queryRaw<Array<{ version: number; primary: string | null }>>`
    SELECT account_owner_version AS version, account_owner_user_id::text AS primary
    FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=${clientId}::uuid
      AND status<>'archived' FOR UPDATE`;
  if (!rows.length) throw new NotFoundException('Client not found');
  // The client lock may have waited behind another save. Re-read and lock the
  // actor's current membership/identity after that wait, not just before it.
  await requireOwnerActor(tx, ctx, write, true);
  if (!(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId)))
    throw new NotFoundException('Client not found');
  return rows[0]!;
}
