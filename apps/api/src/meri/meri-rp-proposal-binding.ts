import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  authorizeMeriResearchPortfolioScope,
  ResearchPortfolioMeriScopeService,
} from '../research-portfolios/research-portfolio-meri-scope.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRUSTED_SCOPE_KEY = '__meriRpCurrentTurnScope';

export interface ResearchPortfolioProposalTurnScope {
  conversationId: string;
  selectedClientId: string | null;
}

export interface ResearchPortfolioProposalConversationCheckpoint {
  metadata: Prisma.JsonValue;
  clientId: string | null;
}

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
  return RESEARCH_PORTFOLIO_TOOLS.has(tool.trim());
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

export function assertResearchPortfolioProposalTurnScope(
  tool: string,
  scope: ResearchPortfolioProposalTurnScope | undefined,
  outerConversationId: string | undefined,
): ResearchPortfolioProposalTurnScope | undefined {
  if (!isResearchPortfolioProposalTool(tool)) return undefined;
  if (
    !scope ||
    !UUID.test(scope.conversationId) ||
    scope.conversationId !== outerConversationId ||
    (scope.selectedClientId !== null && !UUID.test(scope.selectedClientId))
  ) {
    throw new BadRequestException(
      'Trusted current-turn scope is required for a Research Portfolio action proposal.',
    );
  }
  return scope;
}

export function storeResearchPortfolioProposalTurnScope(
  tool: string,
  preview: Record<string, unknown>,
  scope: ResearchPortfolioProposalTurnScope | undefined,
): Record<string, unknown> {
  if (!isResearchPortfolioProposalTool(tool)) return preview;
  const trusted = assertResearchPortfolioProposalTurnScope(tool, scope, scope?.conversationId)!;
  return {
    ...preview,
    [TRUSTED_SCOPE_KEY]: {
      version: 1,
      conversationId: trusted.conversationId,
      selectedClientId: trusted.selectedClientId,
    },
  };
}

export function readStoredResearchPortfolioProposalTurnScope(
  tool: string,
  preview: unknown,
  outerConversationId: string | null,
): ResearchPortfolioProposalTurnScope | undefined {
  if (!isResearchPortfolioProposalTool(tool)) return undefined;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    throw new BadRequestException('Stored Research Portfolio current-turn scope is missing.');
  }
  const value = (preview as Record<string, unknown>)[TRUSTED_SCOPE_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Stored Research Portfolio current-turn scope is missing.');
  }
  const scope = value as Record<string, unknown>;
  if (
    Object.keys(scope).some(
      (key) => !['version', 'conversationId', 'selectedClientId'].includes(key),
    ) ||
    scope.version !== 1 ||
    typeof scope.conversationId !== 'string' ||
    !UUID.test(scope.conversationId) ||
    scope.conversationId !== outerConversationId ||
    (scope.selectedClientId !== null &&
      (typeof scope.selectedClientId !== 'string' || !UUID.test(scope.selectedClientId)))
  ) {
    throw new BadRequestException('Stored Research Portfolio current-turn scope is invalid.');
  }
  return {
    conversationId: scope.conversationId,
    selectedClientId: scope.selectedClientId as string | null,
  };
}

export function publicResearchPortfolioProposalPreview(preview: unknown): Record<string, unknown> {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return {};
  const { [TRUSTED_SCOPE_KEY]: _scope, ...publicPreview } = preview as Record<string, unknown>;
  return publicPreview;
}

export function researchPortfolioProposalFingerprintInput(
  tool: string,
  input: Record<string, unknown>,
  scope: ResearchPortfolioProposalTurnScope | undefined,
): Record<string, unknown> {
  if (!isResearchPortfolioProposalTool(tool)) return input;
  if (!scope) {
    throw new BadRequestException('Research Portfolio current-turn scope is unavailable.');
  }
  return {
    ...input,
    [TRUSTED_SCOPE_KEY]: {
      version: 1,
      conversationId: scope.conversationId,
      selectedClientId: scope.selectedClientId,
    },
  };
}

export async function authorizeResearchPortfolioProposalConversation(
  prisma: PrismaService,
  scopeService: ResearchPortfolioMeriScopeService,
  ctx: TenantContext,
  conversationId: string,
  trustedSelectedClientId: string | null | undefined,
  policyClientId?: string | null,
): Promise<ResearchPortfolioProposalConversationCheckpoint> {
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

  const scope = await authorizeMeriResearchPortfolioScope(scopeService, ctx, conversation.metadata);
  if (!scope) {
    throw new BadRequestException('This conversation is not scoped to a Research Portfolio');
  }
  const current = await prisma.withTenant(ctx.tenantId, (tx) =>
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
  if (!current) throw new NotFoundException('Meri conversation not found');
  if (
    current.clientId !== conversation.clientId ||
    !isDeepStrictEqual(current.metadata, conversation.metadata)
  ) {
    throw new BadRequestException(
      'The current Research Portfolio conversation authority changed during authorization.',
    );
  }
  if (trustedSelectedClientId !== undefined && current.clientId !== trustedSelectedClientId) {
    throw new BadRequestException(
      'The current conversation client changed after the Research Portfolio proposal turn.',
    );
  }
  if (policyClientId && current.clientId && current.clientId !== policyClientId) {
    throw new BadRequestException(
      'The proposal client does not match the current conversation client.',
    );
  }
  return current;
}
