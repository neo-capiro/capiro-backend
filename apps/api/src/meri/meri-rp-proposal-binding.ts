import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  authorizeMeriResearchPortfolioScope,
  ResearchPortfolioMeriScopeService,
} from '../research-portfolios/research-portfolio-meri-scope.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RESEARCH_PORTFOLIO_TOOLS = new Set([
  'manage_research_portfolio',
  'get_research_portfolio',
  'get_research_portfolio_analytics',
  'get_research_portfolio_changes',
  'create_research_portfolio_snapshot',
  'request_research_portfolio_output',
  'save_research_portfolio_output_to_client',
  'watch_research_portfolio',
  'update_research_portfolio_change_state',
  'get_research_portfolio_bookmarks',
  'create_research_portfolio_bookmark',
  'get_research_portfolio_fit',
  'get_research_portfolio_reviews',
  'add_research_portfolio_review_note',
  'get_research_portfolio_rules',
  'get_research_portfolio_imports',
  'get_research_portfolio_operations',
  'prepare_research_portfolio_brief',
  'prepare_research_portfolio_meeting',
]);

export function isResearchPortfolioProposalTool(tool: string): boolean {
  return RESEARCH_PORTFOLIO_TOOLS.has(tool);
}

export function bindResearchPortfolioProposalInput(
  tool: string,
  rawInput: unknown,
  outerConversationId: string | undefined,
): unknown {
  if (!isResearchPortfolioProposalTool(tool)) return rawInput;
  if (!outerConversationId || !UUID.test(outerConversationId)) {
    throw new BadRequestException(
      'A verified outer conversationId is required for a Research Portfolio action proposal.',
    );
  }
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new BadRequestException('Research Portfolio action input must be an object.');
  }
  const input = rawInput as Record<string, unknown>;
  if (
    Object.hasOwn(input, 'conversationId') &&
    input.conversationId !== undefined &&
    input.conversationId !== outerConversationId
  ) {
    throw new BadRequestException(
      'Research Portfolio action conversationId must match the proposal conversationId.',
    );
  }
  return { ...input, conversationId: outerConversationId };
}

export function bindStoredResearchPortfolioProposalInput(
  tool: string,
  rawInput: unknown,
  outerConversationId: string | null,
): unknown {
  if (!isResearchPortfolioProposalTool(tool)) return rawInput;
  if (
    !rawInput ||
    typeof rawInput !== 'object' ||
    Array.isArray(rawInput) ||
    (rawInput as Record<string, unknown>).conversationId !== outerConversationId
  ) {
    throw new BadRequestException(
      'The stored Research Portfolio action is not bound to its proposal conversation.',
    );
  }
  return bindResearchPortfolioProposalInput(tool, rawInput, outerConversationId ?? undefined);
}

export async function authorizeResearchPortfolioProposalConversation(
  prisma: PrismaService,
  scopeService: ResearchPortfolioMeriScopeService,
  ctx: TenantContext,
  conversationId: string,
  policyClientId?: string | null,
): Promise<void> {
  const conversation = await prisma.withTenant(ctx.tenantId, (tx) =>
    tx.clioConversation.findFirst({
      where: {
        id: conversationId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        archivedAt: null,
      },
      select: { metadata: true, clientId: true },
    }),
  );
  if (!conversation) throw new NotFoundException('Meri conversation not found');

  const scope = await authorizeMeriResearchPortfolioScope(
    scopeService,
    ctx,
    conversation.metadata,
  );
  if (!scope) {
    throw new BadRequestException('This conversation is not scoped to a Research Portfolio');
  }
  if (
    policyClientId &&
    conversation.clientId &&
    conversation.clientId !== policyClientId
  ) {
    throw new BadRequestException(
      'The proposal client does not match the current conversation client.',
    );
  }
}
