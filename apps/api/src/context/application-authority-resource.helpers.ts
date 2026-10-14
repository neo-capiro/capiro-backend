import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { authorizeResearchPortfolioConversation } from '../research-portfolios/research-portfolio-artifact-authority.js';

/** Shared current resource reads; ordinary legacy callers retain their 404s. */
export async function loadOwnedActiveClioConversation(
  prisma: PrismaService,
  ctx: TenantContext,
  conversationId: string,
) {
  const conversation = await prisma.withTenant(ctx.tenantId, async (tx) => {
    const row = await tx.clioConversation.findFirst({
      where: {
        id: conversationId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        archivedAt: null,
      },
      include: { client: { select: { id: true, name: true } } },
    });
    if (row) await authorizeResearchPortfolioConversation(tx, ctx, row);
    return row;
  });
  if (!conversation) throw new NotFoundException('Meri conversation not found');
  return conversation;
}

export async function assertCurrentClientVisible(
  prisma: PrismaService,
  ctx: TenantContext,
  clientId: string,
) {
  const client = await prisma.withTenant(ctx.tenantId, (tx) =>
    tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
      select: { id: true },
    }),
  );
  if (!client) throw new NotFoundException('Client not found');
}
