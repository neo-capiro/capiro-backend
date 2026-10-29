import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { assertManagedMembership, visibleBinding } from '../conversation-management/service.js';

export type OfficeAuthority = Awaited<ReturnType<TenantContextMiddleware['readApplicationAuthoritySession']>>;
/** Use the current conversation owner. Locks retain its facts through the draft commit. */
export async function authorizeDraft(tx: Prisma.TransactionClient, ctx: TenantContext,
  conversationId: string, authority: OfficeAuthority) {
  const hint = await tx.clioConversation.findFirst({ where: { id: conversationId,
    tenantId: ctx.tenantId, userId: ctx.userId }, select: { clientId: true } });
  if (!hint) throw new NotFoundException('OFFICE_DRAFT_UNAVAILABLE');
  if (hint.clientId !== null) await tx.$executeRaw`SELECT id FROM clients
    WHERE tenant_id=${ctx.tenantId}::uuid AND id=${hint.clientId}::uuid FOR SHARE`;
  await tx.$executeRaw`SELECT id FROM tenant_memberships WHERE tenant_id=${ctx.tenantId}::uuid
    AND user_id=${ctx.userId}::uuid ORDER BY id FOR SHARE`;
  await tx.$executeRaw`SELECT id FROM tenants WHERE id=${ctx.tenantId}::uuid FOR SHARE`;
  if (hint.clientId !== null) await tx.$executeRaw`SELECT id FROM client_memory_access
    WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${hint.clientId}::uuid
    AND user_id=${ctx.userId}::uuid ORDER BY id FOR SHARE`;
  await tx.$executeRaw`SELECT id FROM clio_conversations WHERE id=${conversationId}::uuid
    AND tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
  await assertManagedMembership(tx, ctx);
  const row = await tx.clioConversation.findFirst({ where: { id: conversationId, tenantId: ctx.tenantId,
    userId: ctx.userId, status: 'active' }, include: { bootstrapReceipt: true } });
  if (!row || row.clientId !== hint.clientId) throw new NotFoundException('OFFICE_DRAFT_UNAVAILABLE');
  await visibleBinding(tx, ctx, row);
  const current = await authority.readCurrent(tx);
  const clocks = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const now = clocks[0]!.now;
  if (current.principal.tenantId !== ctx.tenantId || current.principal.actorId !== ctx.userId ||
      current.expiresAtMs <= now.getTime()) throw new ForbiddenException('OFFICE_DRAFT_AUTHORITY');
  return now;
}
