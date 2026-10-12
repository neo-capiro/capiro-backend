import { NotFoundException } from '@nestjs/common';
import { ROLE_RANK, type TenantContext } from '@capiro/shared';
import type { ClientActivityCommand, Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';

export type CommandTx = Prisma.TransactionClient;
const missing = () => new NotFoundException('Activity command not found');

export async function requireCommandActor(tx: CommandTx, ctx: TenantContext, clientId: string) {
  if (
    !ctx ||
    !isUUID(ctx.tenantId) ||
    !isUUID(ctx.userId) ||
    typeof ctx.clerkUserId !== 'string' ||
    !ctx.clerkUserId
  )
    throw missing();
  const member = await tx.tenantMembership.findFirst({
    where: {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      status: 'active',
      user: { clerkUserId: ctx.clerkUserId },
    },
    select: { role: true },
  });
  const rank = member ? ROLE_RANK[member.role] : undefined;
  if (typeof rank !== 'number' || rank < ROLE_RANK.standard_user) throw missing();
  const client = await tx.client.findFirst({
    where: { tenantId: ctx.tenantId, id: clientId, status: { not: 'archived' } },
    select: { id: true },
  });
  if (!client || !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId)))
    throw missing();
}

export async function commandAssignee(
  tx: CommandTx,
  ctx: TenantContext,
  clientId: string,
  userId: string,
) {
  const member = await tx.tenantMembership.findFirst({
    where: { tenantId: ctx.tenantId, userId, status: 'active' },
    select: { user: { select: { clerkUserId: true } } },
  });
  if (!member?.user.clerkUserId || !(await clientMemoryAllowed(tx, ctx.tenantId, userId, clientId)))
    return null;
  return member.user.clerkUserId;
}

export async function commandIssue(tx: CommandTx, ctx: TenantContext, row: ClientActivityCommand) {
  const activity = await tx.clientActivity.findFirst({
    where: { id: row.activityId, tenantId: ctx.tenantId, clientId: row.clientId },
    select: { id: true, personId: true },
  });
  if (!activity) return 'activity_removed';
  if (
    row.personId &&
    (activity.personId !== row.personId ||
      !(await tx.clientPerson.findFirst({
        where: { id: row.personId, tenantId: ctx.tenantId, clientId: row.clientId },
        select: { id: true },
      })))
  )
    return 'person_unavailable';
  if (
    row.assigneeUserId &&
    (await commandAssignee(tx, ctx, row.clientId, row.assigneeUserId)) !== row.assigneeClerkUserId
  )
    return 'assignee_unavailable';
  return null;
}
