import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

/** Domain admission, using current membership rather than a cached request role. */
export async function currentMeetingActor(tx: Prisma.TransactionClient, ctx: TenantContext): Promise<TenantContext> {
  const member = await tx.tenantMembership.findFirst({
    where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active', user: { clerkUserId: ctx.clerkUserId } },
    select: { role: true },
  });
  if (!member) throw new NotFoundException('Meeting not found');
  return { ...ctx, role: member.role };
}

export function visibleMeetingClientWhere(ctx: TenantContext): Prisma.MeetingWhereInput {
  return { OR: [
    { clientId: null },
    { client: { is: { tenantId: ctx.tenantId, status: { not: 'archived' }, OR: [
      { memoryWall: false },
      { memoryAccessGrants: { some: { tenantId: ctx.tenantId, userId: ctx.userId } } },
    ] } } },
  ] };
}

export async function assertMeetingClient(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string | null) {
  if (clientId === null) return;
  const client = await tx.client.findFirst({
    where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } }, select: { id: true },
  });
  if (!client || !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId))) {
    throw new NotFoundException('Meeting not found');
  }
}
