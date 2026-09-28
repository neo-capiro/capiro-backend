import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { authorizeResearchPortfolioArtifact } from '../research-portfolios/research-portfolio-artifact-authority.js';
export const RESEARCH_PORTFOLIO_TASK_SOURCE = 'research_portfolio_action';
export async function assertOwnedResearchPortfolioTask(tx: any, ctx: TenantContext, task: any) {
  if (task.sourceType !== RESEARCH_PORTFOLIO_TASK_SOURCE) return;
  if (
    task.tenantId !== ctx.tenantId ||
    task.createdByUserId !== ctx.userId ||
    task.ownerUserId !== ctx.userId
  )
    throw new NotFoundException('Task not found');
  const artifactId = typeof task.sourceId === 'string' ? task.sourceId.split('|')[0] : null;
  const artifact = artifactId
    ? await tx.clioArtifact.findFirst({
        where: { id: artifactId, tenantId: ctx.tenantId, userId: ctx.userId },
      })
    : null;
  if (!artifact) throw new NotFoundException('Task source is no longer available');
  await authorizeResearchPortfolioArtifact(tx, ctx, artifact);
}
