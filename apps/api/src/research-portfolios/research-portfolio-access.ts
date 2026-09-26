import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ResearchPortfolioGrantRole, TenantContext } from '@capiro/shared';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

type Tx = any;
type RequiredRole = ResearchPortfolioGrantRole;

const ROLE_LEVEL: Record<ResearchPortfolioGrantRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export async function loadAuthorizedResearchPortfolio(
  tx: Tx,
  ctx: TenantContext,
  portfolioId: string,
  requiredRole: RequiredRole = 'viewer',
) {
  const row = await tx.researchPortfolio.findFirst({
    where: {
      id: portfolioId,
      tenantId: ctx.tenantId,
      grants: { some: { principalUserId: ctx.userId } },
    },
    include: {
      grants: { where: { principalUserId: ctx.userId }, select: { role: true }, take: 1 },
      clientLinks: { select: { clientId: true } },
    },
  });
  if (!row || !row.grants[0]) throw new NotFoundException('Research portfolio not found');
  const role = row.grants[0].role as ResearchPortfolioGrantRole;
  if (ROLE_LEVEL[role] < ROLE_LEVEL[requiredRole]) {
    throw new ForbiddenException(`Research portfolio ${requiredRole} access required`);
  }
  return { ...row, myRole: role };
}

/**
 * Recheck the client memory wall when an operation targets client-private
 * material. Public portfolio projections stay usable when an unrelated linked
 * client is later revoked; filing to a client remains fail closed.
 */
export async function assertResearchPortfolioClientAccess(
  tx: Tx,
  ctx: TenantContext,
  clientIds: readonly string[],
): Promise<void> {
  for (const clientId of clientIds) {
    if (!(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId))) {
      throw new NotFoundException('Research portfolio output is no longer available');
    }
  }
}
