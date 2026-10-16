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

function authorizedPortfolioWhere(ctx: TenantContext, portfolioId: string) {
  return {
    id: portfolioId,
    tenantId: ctx.tenantId,
    grants: { some: { principalUserId: ctx.userId } },
  };
}

function requirePortfolioRole(row: any, requiredRole: RequiredRole): ResearchPortfolioGrantRole {
  if (!row || !row.grants[0]) throw new NotFoundException('Research portfolio not found');
  const role = row.grants[0].role as ResearchPortfolioGrantRole;
  if (ROLE_LEVEL[role] < ROLE_LEVEL[requiredRole]) {
    throw new ForbiddenException(`Research portfolio ${requiredRole} access required`);
  }
  return role;
}

export async function loadAuthorizedResearchPortfolio(
  tx: Tx,
  ctx: TenantContext,
  portfolioId: string,
  requiredRole: RequiredRole = 'viewer',
) {
  const row = await tx.researchPortfolio.findFirst({
    where: authorizedPortfolioWhere(ctx, portfolioId),
    include: {
      grants: { where: { principalUserId: ctx.userId }, select: { role: true }, take: 1 },
      clientLinks: { select: { clientId: true } },
    },
  });
  const role = requirePortfolioRole(row, requiredRole);
  return { ...row, myRole: role };
}

/** Resource-observation bound, not a portfolio/client capacity policy. */
export const RESEARCH_PORTFOLIO_AUTHORITY_MAX_CLIENTS = 4096;

/** Current resource facts only. The caller supplies genuine current principal
 * and capture authority; this loader does not establish membership or a run. */
export async function loadAuthorizedResearchPortfolioCurrentFacts(
  tx: Tx,
  ctx: TenantContext,
  portfolioId: string,
  includeClientLinks: boolean,
) {
  const row = await tx.researchPortfolio.findFirst({
    where: authorizedPortfolioWhere(ctx, portfolioId),
    select: {
      id: true,
      tenantId: true,
      name: true,
      revision: true,
      lifecycle: true,
      grants: {
        where: { principalUserId: ctx.userId },
        select: { id: true, role: true, updatedAt: true },
        take: 1,
      },
      ...(includeClientLinks ? {
        clientLinks: {
          select: { clientId: true },
          orderBy: { clientId: 'asc' },
          take: RESEARCH_PORTFOLIO_AUTHORITY_MAX_CLIENTS + 1,
        },
      } : {}),
    },
  });
  const role = requirePortfolioRole(row, 'viewer');
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
