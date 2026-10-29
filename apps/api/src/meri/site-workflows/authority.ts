import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { assertManagedMembership, visibleBinding } from '../conversation-management/service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
export type WorkflowAdminAuthority = Awaited<ReturnType<TenantContextMiddleware['readApplicationAuthoritySession']>>;

/** HQ staff act through the existing native impersonation session. The canonical
 * authority closure retains the selected membership/session; JSON cannot provide it. */
export async function withWorkflowAdmin<T>(prisma: PrismaService, ctx: TenantContext,
  read: (tx: Prisma.TransactionClient) => Promise<T>, authority?: WorkflowAdminAuthority): Promise<T> {
  if (!authority) return prisma.withTenant(ctx.tenantId, async tx => {
    await requireWorkflowAdmin(tx, ctx);
    return read(tx);
  });
  if (ctx.role !== 'capiro_admin') throw new ForbiddenException('Current Capiro administrator access required');
  return prisma.withSystem(async tx => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${ctx.tenantId}, true)`;
    // Stabilize the actual staff membership, home/target tenant and selected
    // impersonation lifecycle until the configuration or receipt read commits.
    await tx.$executeRaw`SELECT id FROM tenant_memberships
      WHERE user_id=${ctx.userId}::uuid ORDER BY id FOR SHARE`;
    await tx.$executeRaw`SELECT id FROM tenants WHERE id=${ctx.tenantId}::uuid OR id IN
      (SELECT tenant_id FROM tenant_memberships WHERE user_id=${ctx.userId}::uuid) ORDER BY id FOR SHARE`;
    await tx.$executeRaw`SELECT id FROM impersonation_sessions
      WHERE actor_user_id=${ctx.userId}::uuid AND tenant_id=${ctx.tenantId}::uuid ORDER BY id FOR SHARE`;
    await authority.readCurrent(tx);
    // All configuration queries retain explicit ctx.tenantId predicates in this system transaction.
    return read(tx);
  });
}
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

