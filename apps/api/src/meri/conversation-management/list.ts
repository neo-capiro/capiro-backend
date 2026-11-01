import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { MANAGEMENT_VERSION, parseListRequest, type ConversationMetadata } from './contract.js';
import { assertManagedMembership, metadata, visibleBinding } from './service.js';

/** Search native owned titles, never rendered messages or a page-local subset. */
export async function listManagedConversations(prisma: PrismaService, ctx: TenantContext, raw: unknown) {
  const request = parseListRequest(raw);
  return prisma.withTenant(ctx.tenantId, async tx => {
    await assertManagedMembership(tx, ctx);
    const result: ConversationMetadata[] = [];
    const before = request.before;
      const where: Prisma.ClioConversationWhereInput = { tenantId: ctx.tenantId, userId: ctx.userId, status: request.status,
        AND: [{ OR: [{ bootstrapReceipt: { isNot: null } },
          { metadata: { path: ['researchPortfolioScope', 'kind'], equals: 'research_portfolio' } }] }],
        ...(request.title ? { title: { contains: request.title, mode: 'insensitive' } } : {}),
        ...(before ? { OR: [{ updatedAt: { lt: new Date(before.updatedAt) } },
          { updatedAt: new Date(before.updatedAt), id: { lt: before.conversationId } }] } : {}) };
      const rows = await tx.clioConversation.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 21, include: { bootstrapReceipt: true } });
      for (const row of rows.slice(0, 20)) {
        // Status is an intentional owner filter. Lost access or an unavailable
        // authority is not an archive result and must withhold the page.
        const scope = await visibleBinding(tx, ctx, row, { research: true });
        result.push(metadata(row, scope));
      }
      const last = result.at(-1);
      return { version: MANAGEMENT_VERSION, conversations: result,
        nextBefore: rows.length > 20 && last ? { updatedAt: last.updatedAt, conversationId: last.conversationId } : null };
  });
}
