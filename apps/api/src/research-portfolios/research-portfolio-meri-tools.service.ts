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
import { ResearchPortfolioReviewService } from './research-portfolio-review.service.js';
import { ResearchPortfolioRulesService } from './research-portfolio-rules.service.js';
import { ResearchPortfolioPhase11Service } from './research-portfolio-phase11.service.js';

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
  | 'update_research_portfolio_change_state'
  | 'get_research_portfolio_bookmarks'
  | 'create_research_portfolio_bookmark'
  | 'get_research_portfolio_fit'
  | 'get_research_portfolio_reviews'
  | 'add_research_portfolio_review_note'
  | 'get_research_portfolio_rules'
  | 'get_research_portfolio_imports'
  | 'get_research_portfolio_operations'
  | 'prepare_research_portfolio_brief'
  | 'prepare_research_portfolio_meeting';

const NAMES = new Set<ResearchPortfolioMeriToolName>([
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
    private readonly reviews: ResearchPortfolioReviewService,
    private readonly rules: ResearchPortfolioRulesService,
    private readonly phase11: ResearchPortfolioPhase11Service,
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
      case 'get_research_portfolio_bookmarks':
        return this.phase11.listBookmarks(ctx, portfolioId);
      case 'create_research_portfolio_bookmark':
        return this.phase11.createBookmark(ctx, portfolioId, {
          idempotencyKey: requiredText(input, 'operationKey'),
          targetKind: requiredText(input, 'targetKind') as any,
          targetId: requiredText(input, 'targetId'),
          label: (input.label as string | undefined) ?? null,
          note: (input.note as string | undefined) ?? null,
        });
      case 'get_research_portfolio_fit':
        return this.phase11.getFit(ctx, portfolioId);
      case 'get_research_portfolio_reviews': {
        const lane = (input.lane as string) ?? 'mine';
        if (!['mine', 'team', 'deferred', 'resolved'].includes(lane)) {
          throw new BadRequestException('lane must be mine, team, deferred, or resolved');
        }
        return this.reviews.listReviews(ctx, portfolioId, lane as 'mine' | 'team' | 'deferred' | 'resolved');
      }
      case 'add_research_portfolio_review_note':
        return this.phase11.addReviewNote(ctx, portfolioId, requiredText(input, 'reviewId'), {
          idempotencyKey: requiredText(input, 'operationKey'),
          expectedRevision: requiredInteger(input, 'expectedRevision'),
          body: requiredText(input, 'body'),
        });
      case 'get_research_portfolio_rules':
        return this.rules.listRules(ctx, portfolioId);
      case 'get_research_portfolio_imports':
        // Return the most recent import job if a jobId is given
        if (input.jobId) {
          return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
            const job = await tx.researchPortfolioImportJob.findFirst({
              where: { tenantId: ctx.tenantId, portfolioId, id: input.jobId as string },
            });
            return job ?? { message: 'Import job not found' };
          });
        }
        return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
          return tx.researchPortfolioImportJob.findMany({
            where: { tenantId: ctx.tenantId, portfolioId },
            orderBy: { createdAt: 'desc' },
            take: 20,
          });
        });
      case 'get_research_portfolio_operations':
        return this.phase11.getOperation(ctx, portfolioId, requiredText(input, 'operationId'));
      case 'prepare_research_portfolio_brief': {
        const [detail, analyticsResult, changesResult, reviewsResult] = await Promise.all([
          this.portfolios.detail(ctx, portfolioId),
          this.analytics.analytics(ctx, portfolioId),
          this.changes.listChanges(ctx, portfolioId, null, 10),
          this.reviews.listReviews(ctx, portfolioId, 'mine'),
        ]);
        return {
          portfolio: { id: detail.id, name: detail.name, purpose: detail.purpose, lifecycle: detail.lifecycle, revision: detail.revision },
          memberCount: detail.memberCount,
          analytics: { availability: analyticsResult.availability, totalCount: analyticsResult.totals.length },
          recentChanges: changesResult.items.length,
          openReviews: reviewsResult.length,
          preparedAt: new Date().toISOString(),
        };
      }
      case 'prepare_research_portfolio_meeting': {
        const [detailM, analyticsM, reviewsMine, reviewsTeam] = await Promise.all([
          this.portfolios.detail(ctx, portfolioId),
          this.analytics.analytics(ctx, portfolioId),
          this.reviews.listReviews(ctx, portfolioId, 'mine'),
          this.reviews.listReviews(ctx, portfolioId, 'team'),
        ]);
        return {
          portfolio: { id: detailM.id, name: detailM.name, lifecycle: detailM.lifecycle },
          analytics: { availability: analyticsM.availability },
          myOpenReviews: reviewsMine.filter((r: any) => r.status === 'open' || r.status === 'assigned').length,
          teamOpenReviews: reviewsTeam.filter((r: any) => r.status === 'open' || r.status === 'assigned').length,
          actionItems: [],
          preparedAt: new Date().toISOString(),
        };
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
