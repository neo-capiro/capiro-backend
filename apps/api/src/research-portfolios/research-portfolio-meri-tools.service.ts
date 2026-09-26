import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  authorizeMeriResearchPortfolioScope,
  ResearchPortfolioMeriScopeService,
} from './research-portfolio-meri-scope.service.js';
import { ResearchPortfoliosService } from './research-portfolios.service.js';
import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';
import { ResearchPortfolioChangesService } from './research-portfolio-changes.service.js';
import { ResearchPortfolioOutputService } from './research-portfolio-output.service.js';

const requiredText = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${key} is required`);
  }
  return value.trim();
};

const optionalText = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const requiredInteger = (input: Record<string, unknown>, key: string): number => {
  const value = input[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BadRequestException(`${key} must be a non-negative integer`);
  }
  return value as number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHORITY_KEYS = [
  'tenantId',
  'userId',
  'portfolioId',
  'researchPortfolioId',
  'scopeVersion',
] as const;

const requiredConversationId = (input: Record<string, unknown>): string => {
  const value = input.conversationId;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestException(
      'A valid conversationId for this Research Portfolio chat is required',
    );
  }
  return value;
};

export type ResearchPortfolioMeriToolName =
  | 'get_research_portfolio'
  | 'get_research_portfolio_analytics'
  | 'get_research_portfolio_changes'
  | 'create_research_portfolio_snapshot'
  | 'request_research_portfolio_output'
  | 'save_research_portfolio_output_to_client'
  | 'watch_research_portfolio'
  | 'update_research_portfolio_change_state';

const NAMES = new Set<ResearchPortfolioMeriToolName>([
  'get_research_portfolio',
  'get_research_portfolio_analytics',
  'get_research_portfolio_changes',
  'create_research_portfolio_snapshot',
  'request_research_portfolio_output',
  'save_research_portfolio_output_to_client',
  'watch_research_portfolio',
  'update_research_portfolio_change_state',
]);

export function isResearchPortfolioMeriTool(name: string): name is ResearchPortfolioMeriToolName {
  return NAMES.has(name as ResearchPortfolioMeriToolName);
}

/** Thin Meri adapter. Domain policy, access, idempotency and projection logic stay in the portfolio services. */
@Injectable()
export class ResearchPortfolioMeriToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: ResearchPortfolioMeriScopeService,
    private readonly portfolios: ResearchPortfoliosService,
    private readonly analytics: ResearchPortfolioAnalyticsService,
    private readonly changes: ResearchPortfolioChangesService,
    private readonly outputs: ResearchPortfolioOutputService,
  ) {}

  async execute(
    ctx: TenantContext,
    name: ResearchPortfolioMeriToolName,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const portfolioId = await this.authorizeScope(ctx, input);
    switch (name) {
      case 'get_research_portfolio':
        return this.portfolios.detail(ctx, portfolioId);
      case 'get_research_portfolio_analytics':
        return this.analytics.analytics(ctx, portfolioId);
      case 'get_research_portfolio_changes':
        return this.changes.listChanges(
          ctx,
          portfolioId,
          optionalText(input, 'cursor') ?? null,
          Math.min(
            Math.max(typeof input.limit === 'number' ? Math.floor(input.limit) : 25, 1),
            100,
          ),
        );
      case 'create_research_portfolio_snapshot':
        return this.analytics.createSnapshot(ctx, portfolioId, {
          operationKey: requiredText(input, 'operationKey'),
          name: requiredText(input, 'name'),
          expectedRevision: requiredInteger(input, 'expectedRevision'),
        });
      case 'request_research_portfolio_output':
        return this.outputs.create(ctx, portfolioId, {
          operationKey: requiredText(input, 'operationKey'),
          snapshotId: optionalText(input, 'snapshotId') ?? null,
          selectedSections: ['contributions', 'totals'],
          includeSourceAppendix: true,
          format: 'csv',
        });
      case 'save_research_portfolio_output_to_client':
        return this.outputs.saveToClient(ctx, portfolioId, requiredText(input, 'outputId'), {
          operationKey: requiredText(input, 'operationKey'),
          clientId: requiredText(input, 'clientId'),
        });
      case 'watch_research_portfolio':
        return this.changes.createSubscription(ctx, portfolioId, {
          targetKind: 'portfolio',
          targetId: portfolioId,
          channel: 'in_app',
          cadence: 'immediate',
        });
      case 'update_research_portfolio_change_state': {
        const action = requiredText(input, 'action');
        if (!['seen', 'acknowledged', 'dismissed', 'undo'].includes(action)) {
          throw new BadRequestException('action must be seen, acknowledged, dismissed, or undo');
        }
        return this.changes.updateEventState(ctx, portfolioId, requiredText(input, 'eventId'), {
          action: action as 'seen' | 'acknowledged' | 'dismissed' | 'undo',
          ...(input.expectedRevision === undefined
            ? {}
            : { expectedRevision: requiredInteger(input, 'expectedRevision') }),
        });
      }
    }
  }

  private async authorizeScope(
    ctx: TenantContext,
    input: Record<string, unknown>,
  ): Promise<string> {
    for (const key of AUTHORITY_KEYS) {
      if (key in input) {
        throw new BadRequestException(`${key} is controlled by the server and may not be supplied`);
      }
    }
    const conversationId = requiredConversationId(input);
    const conversation = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        select: { metadata: true },
      }),
    );
    if (!conversation) throw new NotFoundException('Meri conversation not found');
    const scope = await authorizeMeriResearchPortfolioScope(
      this.scopeService,
      ctx,
      conversation.metadata,
    );
    if (!scope) {
      throw new BadRequestException('This conversation is not scoped to a Research Portfolio');
    }
    return scope.researchPortfolioId;
  }
}
