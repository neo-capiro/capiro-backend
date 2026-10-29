import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { assertManagedMembership, visibleBinding } from '../conversation-management/service.js';
export async function requireWorkflowAdmin(tx: Prisma.TransactionClient, ctx: TenantContext) {
  await tx.$executeRaw`SELECT id FROM tenant_memberships WHERE tenant_id=${ctx.tenantId}::uuid
    AND user_id=${ctx.userId}::uuid ORDER BY id FOR SHARE`;
  await tx.$executeRaw`SELECT id FROM tenants WHERE id=${ctx.tenantId}::uuid FOR SHARE`;
  const member = await tx.tenantMembership.findFirst({ where: { tenantId: ctx.tenantId,
    userId: ctx.userId, role: 'capiro_admin', status: 'active', tenant: { status: 'active' } }, select: { id: true } });
  if (!member) throw new ForbiddenException('Current Capiro administrator access required');
}
export async function requireWorkflowConversation(tx: Prisma.TransactionClient, ctx: TenantContext, conversationId: string) {
  await assertManagedMembership(tx, ctx);
  const row = await tx.clioConversation.findFirst({ where: { id: conversationId, tenantId: ctx.tenantId,
    userId: ctx.userId, status: 'active' }, include: { bootstrapReceipt: true } });
  if (!row) throw new NotFoundException('Active chat not found');
  await visibleBinding(tx, ctx, row);
}

