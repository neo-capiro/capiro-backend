import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { authorizeResearchPortfolioConversation } from '../research-portfolios/research-portfolio-artifact-authority.js';

// Only this resource owner can record a successful portfolio check. Neither
// request bodies nor persisted metadata can manufacture this runtime evidence.
type ResearchPortfolioAuthorityScope = readonly ['research_portfolio', string, string, number, string];
const verifiedResearchPortfolioScopes = new WeakMap<object, ResearchPortfolioAuthorityScope>();
export function readApplicationAuthorityResearchPortfolioScope(conversation: object): ResearchPortfolioAuthorityScope | null {
  return verifiedResearchPortfolioScopes.get(conversation) ?? null;
}

/** Shared current resource reads; ordinary legacy callers retain their 404s. */
export async function loadOwnedActiveClioConversation(
  prisma: PrismaService,
  ctx: TenantContext,
  conversationId: string,
  transaction?: Prisma.TransactionClient,
) {
  const read = async (tx: Prisma.TransactionClient) => {
    const row = await tx.clioConversation.findFirst({
      where: {
        id: conversationId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        archivedAt: null,
      },
      include: { client: { select: { id: true, name: true } } },
    });
    if (row) {
      verifiedResearchPortfolioScopes.delete(row);
      // The supplied transaction is /current's read-only consistent snapshot.
      // Legacy callers keep the existing membership/portfolio/grant locks.
      if (transaction) {
        const scope = await authorizeResearchPortfolioConversation(tx, ctx, row, { lock: false });
        if (scope) verifiedResearchPortfolioScopes.set(row, Object.freeze([
          scope.kind, scope.researchPortfolioId, scope.researchPortfolioName, scope.researchPortfolioRevision, scope.scopeVersion,
        ] as const));
      } else await authorizeResearchPortfolioConversation(tx, ctx, row);
    }
    return row;
  };
  const conversation = transaction ? await read(transaction) : await prisma.withTenant(ctx.tenantId, read);
  if (!conversation) throw new NotFoundException('Meri conversation not found');
  return conversation;
}

export async function assertCurrentClientVisible(
  prisma: PrismaService,
  ctx: TenantContext,
  clientId: string,
  transaction?: Prisma.TransactionClient,
) {
  const read = (tx: Prisma.TransactionClient) =>
    tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
      select: { id: true },
    });
  const client = transaction ? await read(transaction) : await prisma.withTenant(ctx.tenantId, read);
  if (!client) throw new NotFoundException('Client not found');
}
