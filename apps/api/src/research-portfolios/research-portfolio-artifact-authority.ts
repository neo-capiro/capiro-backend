import { createHash } from 'node:crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  readMeriResearchPortfolioScope,
  MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY,
} from './research-portfolio-meri-scope.service.js';
import { loadAuthorizedResearchPortfolio } from './research-portfolio-access.js';

export const RESEARCH_PORTFOLIO_ARTIFACT_KINDS = [
  'research_portfolio_brief',
  'research_portfolio_meeting',
] as const;
export function isResearchPortfolioArtifact(kind: string): boolean {
  return RESEARCH_PORTFOLIO_ARTIFACT_KINDS.some((value) => value === kind);
}

function validScope(metadata: any) {
  const scope = readMeriResearchPortfolioScope(
    metadata?.[MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY],
  );
  if (!scope) throw new ForbiddenException('Research Portfolio scope is unavailable');
  const expected = createHash('sha256')
    .update(
      JSON.stringify({
        kind: scope.kind,
        researchPortfolioId: scope.researchPortfolioId,
        researchPortfolioName: scope.researchPortfolioName,
        researchPortfolioRevision: scope.researchPortfolioRevision,
      }),
    )
    .digest('hex');
  if (scope.scopeVersion !== expected)
    throw new ForbiddenException('Research Portfolio scope receipt is invalid');
  return scope;
}
/** Ordinary conversations retain existing behavior. RP conversations recheck
 * current active membership and current grant even for archived transcript reads. */
export async function authorizeResearchPortfolioConversation(
  tx: any,
  ctx: TenantContext,
  conversation: any,
) {
  const metadata = conversation?.metadata;
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    !Object.hasOwn(metadata, MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY)
  )
    return null;
  if (
    conversation.tenantId !== ctx.tenantId ||
    conversation.userId !== ctx.userId ||
    conversation.clientId !== null
  )
    throw new NotFoundException('Research Portfolio conversation not found');
  const scope = validScope(metadata);
  await tx.$executeRaw`SELECT id FROM tenant_memberships WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND status='active' FOR SHARE`;
  if (
    !(await tx.tenantMembership.findFirst({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
      select: { id: true },
    }))
  )
    throw new ForbiddenException('Active tenant membership required');
  await tx.$executeRaw`SELECT id FROM research_portfolios WHERE tenant_id=${ctx.tenantId}::uuid AND id=${scope.researchPortfolioId}::uuid FOR SHARE`;
  await tx.$executeRaw`SELECT id FROM research_portfolio_grants WHERE tenant_id=${ctx.tenantId}::uuid AND portfolio_id=${scope.researchPortfolioId}::uuid AND principal_user_id=${ctx.userId}::uuid FOR SHARE`;
  await loadAuthorizedResearchPortfolio(tx, ctx, scope.researchPortfolioId, 'viewer');
  return scope;
}
/** Immutable original and current conversation receipts are independently valid.
 * A later receipt for the same RP permits editing the original captured draft;
 * switching the conversation to another RP never transfers that authority. */
export async function authorizeResearchPortfolioArtifact(
  tx: any,
  ctx: TenantContext,
  artifact: any,
) {
  if (
    !isResearchPortfolioArtifact(artifact.kind) ||
    artifact.tenantId !== ctx.tenantId ||
    artifact.userId !== ctx.userId ||
    artifact.clientId !== null
  )
    throw new NotFoundException('Research Portfolio artifact not found');
  const metadata =
    artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
      ? artifact.metadata
      : {};
  if (metadata.schemaVersion !== 'research_portfolio_institutional_v1' || !metadata.sourceLineage)
    throw new ForbiddenException('Research Portfolio artifact provenance is unavailable');
  const scope = validScope(metadata);
  await tx.$executeRaw`SELECT id FROM clio_conversations WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND id=${artifact.conversationId}::uuid FOR SHARE`;
  const conversation = await tx.clioConversation.findFirst({
    where: { id: artifact.conversationId, tenantId: ctx.tenantId, userId: ctx.userId },
    select: { id: true, tenantId: true, userId: true, clientId: true, metadata: true },
  });
  if (!conversation)
    throw new NotFoundException('Research Portfolio artifact conversation not found');
  const current = await authorizeResearchPortfolioConversation(tx, ctx, conversation);
  if (!current || current.researchPortfolioId !== scope.researchPortfolioId)
    throw new NotFoundException('Research Portfolio artifact conversation not found');
  return { scope, metadata };
}
