import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { MANAGEMENT_VERSION, parseListRequest, type ConversationMetadata } from './contract.js';
import { assertManagedMembership, metadata, visibleBinding } from './service.js';

/** Search native owned titles, never rendered messages or a page-local subset. */
export async function listManagedConversations(prisma: PrismaService, ctx: TenantContext, raw: unknown, managementAvailable = false) {
  const request = parseListRequest(raw);
  return prisma.withTenant(ctx.tenantId, async tx => {
    await assertManagedMembership(tx, ctx);
    const result: ConversationMetadata[] = [];
    let before = request.before;
    for (let batch = 0; batch < 20; batch++) {
      const where: Prisma.ClioConversationWhereInput = { tenantId: ctx.tenantId, userId: ctx.userId, status: request.status,
        bootstrapReceipt: { isNot: null }, ...(request.title ? { title: { contains: request.title, mode: 'insensitive' } } : {}),
        ...(before ? { OR: [{ updatedAt: { lt: new Date(before.updatedAt) } },
          { updatedAt: new Date(before.updatedAt), id: { lt: before.conversationId } }] } : {}) };
      const rows = await tx.clioConversation.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 50, include: { bootstrapReceipt: true } });
      for (const row of rows) {
        before = { updatedAt: row.updatedAt.toISOString(), conversationId: row.id };
        try { await visibleBinding(tx, ctx, row); } catch (e) { if (e instanceof NotFoundException) continue; throw e; }
        result.push(metadata(row));
        if (result.length === 20) return { version: MANAGEMENT_VERSION, conversations: result, nextBefore: before, managementAvailable };
      }
      if (rows.length < 50) return { version: MANAGEMENT_VERSION, conversations: result, nextBefore: null, managementAvailable };
    }
    // Bound work without declaring an incomplete authorized search complete.
    throw new ServiceUnavailableException('Chat search could not be completed');
  });
}
