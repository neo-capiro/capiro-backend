import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AssignResearchPortfolioReviewDto,
  DecideResearchPortfolioReviewDto,
  BulkResearchPortfolioReviewsDto,
  ReopenResearchPortfolioAnnualReviewDto,
  ResearchPortfolioAnnualReviewDto,
  ResearchPortfolioContinuityLedgerDto,
  ResearchPortfolioContinuityStatus,
  ResearchPortfolioDecisionDto,
  ResearchPortfolioDecisionType,
  ResearchPortfolioReviewBulkItemDto,
  ResearchPortfolioReviewDto,
  ResearchPortfolioReviewEvidenceDto,
  ResearchPortfolioReviewMutationReceiptDto,
  ResearchPortfolioReviewStatus,
  ResearchPortfolioReviewTargetKind,
  ResearchPortfolioReviewTrigger,
  TenantContext,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;
type RequiredRole = 'viewer' | 'editor' | 'owner';

const ROLE_LEVEL: Record<'viewer' | 'editor' | 'owner', number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function fingerprint(operation: string, payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ operation, payload })))
    .digest('hex');
}

function asIso(value: Date): string {
  return value.toISOString();
}

@Injectable()
export class ResearchPortfolioReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async listReviews(
    ctx: TenantContext,
    portfolioId: string,
    lane: 'mine' | 'team' | 'deferred' | 'resolved',
  ): Promise<readonly ResearchPortfolioReviewDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.loadAuthorized(tx, ctx, portfolioId, 'viewer');

      const where: Prisma.ResearchPortfolioReviewWhereInput = {
        tenantId: ctx.tenantId,
        portfolioId,
      };

      switch (lane) {
        case 'mine':
          where.assigneeUserId = ctx.userId;
          where.status = { in: ['open', 'assigned'] };
          break;
        case 'team':
          where.OR = [
            { assigneeUserId: null },
            { assigneeUserId: { not: ctx.userId } },
          ];
          where.status = { in: ['open', 'assigned'] };
          break;
        case 'deferred':
          where.status = 'deferred';
          break;
        case 'resolved':
          where.status = { in: ['resolved', 'cancelled'] };
          break;
      }

      const reviews = await tx.researchPortfolioReview.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });

      return reviews.map((review) => this.reviewDto(review));
    });
  }

  async assignReview(
    ctx: TenantContext,
    portfolioId: string,
    reviewId: string,
    input: AssignResearchPortfolioReviewDto,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    return this.mutateReview(
      ctx,
      portfolioId,
      'review.assign',
      { ...input, reviewId },
      'editor',
      async (tx, isArchived) => {
        if (isArchived) {
          throw new BadRequestException('Cannot assign reviews for archived portfolio');
        }

        const reason = input.reason?.trim();
        if (!reason) throw new BadRequestException('Assignment requires a non-empty reason');
        const review = await tx.researchPortfolioReview.findUnique({
          where: { id: reviewId, tenantId: ctx.tenantId, portfolioId },
        });

        if (!review) {
          throw new NotFoundException('Review not found');
        }

        if (review.status === 'resolved' || review.status === 'cancelled') {
          throw new BadRequestException('Cannot assign a resolved or cancelled review');
        }
        if (review.revision !== input.expectedRevision) throw new ConflictException('Review revision mismatch');

        if (input.assigneeUserId !== null) {
          await this.requireActiveTenantMember(tx, ctx.tenantId, input.assigneeUserId);
        }

        const operationFingerprint = fingerprint('review.assign', {
          reviewId,
          assigneeUserId: input.assigneeUserId,
          reason,
          expectedRevision: input.expectedRevision,
          expectedPortfolioRevision: input.expectedPortfolioRevision,
        });

        const replay = await this.replay(tx, ctx, input.idempotencyKey, operationFingerprint);
        if (replay) return replay;

        const updatedReview = await tx.researchPortfolioReview.update({
          where: {
            id: reviewId,
            tenantId: ctx.tenantId,
            portfolioId,
            revision: review.revision,
          },
          data: {
            assigneeUserId: input.assigneeUserId,
            status: input.assigneeUserId !== null ? 'assigned' : 'open',
            reason,
            revision: { increment: 1 },
          },
        });

        await this.bumpPortfolioRevision(tx, ctx.tenantId, portfolioId, input.expectedPortfolioRevision);

        return this.recordReviewMutation(tx, ctx, {
          portfolioId,
          operationFingerprint,
          idempotencyKey: input.idempotencyKey,
          outcomes: [{
            reviewId,
            status: 'assigned',
            revision: updatedReview.revision,
            decisionId: null,
            message: null,
          }],
        });
      },
    );
  }

  async decideReview(
    ctx: TenantContext,
    portfolioId: string,
    reviewId: string,
    input: DecideResearchPortfolioReviewDto,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    return this.mutateReview(
      ctx,
      portfolioId,
      'review.decide',
      { ...input, reviewId },
      'editor',
      async (tx, isArchived) => {
        if (isArchived) {
          throw new BadRequestException('Cannot decide reviews for archived portfolio');
        }

        const review = await tx.researchPortfolioReview.findUnique({
          where: { id: reviewId, tenantId: ctx.tenantId, portfolioId },
        });

        if (!review) {
          throw new NotFoundException('Review not found');
        }

        if (review.status === 'cancelled' || (review.status === 'resolved' && input.decisionType !== 'reopen')) {
          throw new BadRequestException('Cannot decide a resolved or cancelled review');
        }
        if (review.revision !== input.expectedRevision) throw new ConflictException('Review revision mismatch');

        const reason = input.reason?.trim();
        if (!reason) {
          throw new BadRequestException('Decision requires a non-empty reason');
        }

        if (['include', 'exclude', 'dispute'].includes(input.decisionType)) {
          if (!input.evidenceFor?.length && !input.evidenceAgainst?.length) {
            throw new BadRequestException('Include, exclude, and dispute decisions require evidence');
          }
        }

        const priorDecision = await tx.researchPortfolioDecision.findFirst({
          where: { tenantId: ctx.tenantId, portfolioId, reviewId },
          orderBy: [{ decisionTime: 'desc' }, { id: 'desc' }],
        });

        if (input.priorDecisionId !== undefined && input.priorDecisionId !== (priorDecision?.id ?? null)) {
          throw new ConflictException('Prior decision mismatch');
        }

        const operationFingerprint = fingerprint('review.decide', {
          reviewId,
          decisionType: input.decisionType,
          reason,
          priorDecisionId: priorDecision?.id ?? null,
          expectedRevision: input.expectedRevision,
          expectedPortfolioRevision: input.expectedPortfolioRevision,
          evidenceFor: input.evidenceFor ?? [],
          evidenceAgainst: input.evidenceAgainst ?? [],
        });

        const replay = await this.replay(tx, ctx, input.idempotencyKey, operationFingerprint);
        if (replay) return replay;

        const decision = await tx.researchPortfolioDecision.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId,
            targetKind: review.targetKind,
            targetId: review.targetId,
            decisionType: input.decisionType,
            reason,
            authorUserId: ctx.userId,
            priorDecisionId: priorDecision?.id ?? null,
            supersedesId: priorDecision?.id ?? null,
            evidenceFor: (input.evidenceFor ?? []) as unknown as Prisma.InputJsonValue,
            evidenceAgainst: (input.evidenceAgainst ?? []) as unknown as Prisma.InputJsonValue,
            reviewId,
          },
        });

        let reviewStatus: ResearchPortfolioReviewStatus = 'resolved';
        if (input.decisionType === 'defer') {
          reviewStatus = 'deferred';
        } else if (input.decisionType === 'reopen') {
          reviewStatus = 'open';
        } else if (input.decisionType === 'dispute') {
          reviewStatus = 'open';
        }

        const updatedReview = await tx.researchPortfolioReview.update({
          where: {
            id: reviewId,
            tenantId: ctx.tenantId,
            portfolioId,
            revision: review.revision,
          },
          data: {
            status: reviewStatus,
            resolvedAt: reviewStatus === 'resolved' ? new Date() : null,
            evidenceFor: (input.evidenceFor ?? []) as unknown as Prisma.InputJsonValue,
            evidenceAgainst: (input.evidenceAgainst ?? []) as unknown as Prisma.InputJsonValue,
            revision: { increment: 1 },
          },
        });

        await this.bumpPortfolioRevision(tx, ctx.tenantId, portfolioId, input.expectedPortfolioRevision);

        return this.recordReviewMutation(tx, ctx, {
          portfolioId,
          operationFingerprint,
          idempotencyKey: input.idempotencyKey,
          outcomes: [{
            reviewId,
            status: 'decided',
            revision: updatedReview.revision,
            decisionId: decision.id,
            message: null,
          }],
        });
      },
    );
  }

  async bulkDecideReviews(
    ctx: TenantContext,
    portfolioId: string,
    input: BulkResearchPortfolioReviewsDto,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    if (!input.items.length || input.items.length > 50) {
      throw new BadRequestException('Bulk decisions must contain between 1 and 50 items');
    }

    const items = input.items.map((item) => {
      const reason = item.reason?.trim();
      if (!reason) {
        throw new BadRequestException('Every bulk decision requires a non-empty reason');
      }
      return { ...item, reason };
    });

    const reviewIds = new Set(items.map((item) => item.reviewId));
    if (reviewIds.size !== items.length) {
      throw new BadRequestException('Bulk decisions must not contain duplicate review IDs');
    }

    const decisionTypes = new Set<ResearchPortfolioDecisionType>(items.map((item) => item.decisionType));
    if (decisionTypes.size > 1) throw new BadRequestException('Bulk decisions must use one compatible decision type and scope');

    return this.mutateReview(
      ctx,
      portfolioId,
      'review.bulk-decide',
      { ...input, items },
      'editor',
      async (tx, isArchived) => {
        if (isArchived) {
          throw new BadRequestException('Cannot bulk decide reviews for archived portfolio');
        }

        const operationFingerprint = fingerprint('review.bulk-decide', {
          reviewIds: Array.from(reviewIds),
          decisionTypes: Array.from(decisionTypes),
          expectedRevision: input.expectedRevision,
          items,
        });

        const replay = await this.replay(tx, ctx, input.idempotencyKey, operationFingerprint);
        if (replay) return replay;

        const reviews = await tx.researchPortfolioReview.findMany({
          where: {
            id: { in: Array.from(reviewIds) },
            tenantId: ctx.tenantId,
            portfolioId,
          },
        });

        const reviewMap = new Map(reviews.map((review) => [review.id, review]));
        const missingReviews = Array.from(reviewIds).filter((id) => !reviewMap.has(id));
        if (missingReviews.length > 0) {
          throw new NotFoundException(`Reviews not found: ${missingReviews.join(', ')}`);
        }

        const outcomes = [];
        for (const item of items) {
          const review = reviewMap.get(item.reviewId)!;

          if (review.status === 'cancelled' || (review.status === 'resolved' && item.decisionType !== 'reopen')) {
            outcomes.push({
              reviewId: item.reviewId,
              status: 'failed' as const,
              revision: review.revision,
              decisionId: null,
              message: 'Review is already resolved or cancelled',
            });
            continue;
          }
          if (['include', 'exclude', 'dispute'].includes(item.decisionType)
            && !item.evidenceFor?.length && !item.evidenceAgainst?.length) {
            outcomes.push({
              reviewId: item.reviewId,
              status: 'failed' as const,
              revision: review.revision,
              decisionId: null,
              message: 'Include, exclude, and dispute decisions require evidence',
            });
            continue;
          }
          if (review.revision !== item.expectedRevision) {
            outcomes.push({ reviewId: item.reviewId, status: 'conflict' as const, revision: review.revision, decisionId: null, message: 'Review revision mismatch' });
            continue;
          }
          const priorDecision = await tx.researchPortfolioDecision.findFirst({
            where: { tenantId: ctx.tenantId, portfolioId, reviewId: item.reviewId },
            orderBy: [{ decisionTime: 'desc' }, { id: 'desc' }],
          });
            const decision = await tx.researchPortfolioDecision.create({
              data: {
                tenantId: ctx.tenantId,
                portfolioId,
                targetKind: review.targetKind,
                targetId: review.targetId,
                decisionType: item.decisionType,
                reason: item.reason,
                authorUserId: ctx.userId,
                priorDecisionId: priorDecision?.id ?? null,
                supersedesId: priorDecision?.id ?? null,
                evidenceFor: (item.evidenceFor ?? []) as unknown as Prisma.InputJsonValue,
                evidenceAgainst: (item.evidenceAgainst ?? []) as unknown as Prisma.InputJsonValue,
                reviewId: item.reviewId,
              },
            });

            let reviewStatus: ResearchPortfolioReviewStatus = 'resolved';
            if (item.decisionType === 'defer') {
              reviewStatus = 'deferred';
            } else if (item.decisionType === 'reopen') {
              reviewStatus = 'open';
            } else if (item.decisionType === 'dispute') {
              reviewStatus = 'open';
            }

            const updatedReview = await tx.researchPortfolioReview.update({
              where: {
                id: item.reviewId,
                tenantId: ctx.tenantId,
                portfolioId,
                revision: item.expectedRevision,
              },
              data: {
                status: reviewStatus,
                resolvedAt: reviewStatus === 'resolved' ? new Date() : null,
                revision: { increment: 1 },
              },
            });

            outcomes.push({
              reviewId: item.reviewId,
              status: 'decided' as const,
              revision: updatedReview.revision,
              decisionId: decision.id,
              message: null,
            });
        }

        const successfulReviews = outcomes.filter((o) => o.status === 'decided');
        if (successfulReviews.length > 0) {
          await this.bumpPortfolioRevision(tx, ctx.tenantId, portfolioId, input.expectedRevision);
        }

        return this.recordReviewMutation(tx, ctx, {
          portfolioId,
          operationFingerprint,
          idempotencyKey: input.idempotencyKey,
          outcomes,
        });
      },
    );
  }

  async getAnnualReview(
    ctx: TenantContext,
    portfolioId: string,
  ): Promise<ResearchPortfolioAnnualReviewDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.loadAuthorized(tx, ctx, portfolioId, 'viewer');

      const items = await tx.researchPortfolioContinuityLedger.findMany({
        where: { tenantId: ctx.tenantId, portfolioId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });

      const counts: Record<ResearchPortfolioContinuityStatus, number> = {
        unchanged: 0,
        changed: 0,
        expired: 0,
        renamed: 0,
        renumbered: 0,
        split: 0,
        merged: 0,
        unresolved: 0,
        new: 0,
      };

      for (const item of items) {
        counts[item.status as ResearchPortfolioContinuityStatus]++;
      }

      return {
        items: items.map((item) => this.continuityLedgerDto(item)),
        counts,
      };
    });
  }

  async reopenAnnualReview(
    ctx: TenantContext,
    portfolioId: string,
    input: ReopenResearchPortfolioAnnualReviewDto,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    if (!input.continuityIds.length || input.continuityIds.length > 100) {
      throw new BadRequestException('Continuity IDs must contain between 1 and 100 items');
    }

    const continuityIds = [...new Set(input.continuityIds)];
    if (continuityIds.length !== input.continuityIds.length) {
      throw new BadRequestException('Continuity IDs must not contain duplicates');
    }

    return this.mutateReview(
      ctx,
      portfolioId,
      'annual-review.reopen',
      { ...input, continuityIds },
      'editor',
      async (tx, isArchived) => {
        if (isArchived) {
          throw new BadRequestException('Cannot reopen annual review for archived portfolio');
        }

        const operationFingerprint = fingerprint('annual-review.reopen', {
          continuityIds,
          expectedRevision: input.expectedRevision,
          reason: input.reason?.trim() || null,
        });

        const replay = await this.replay(tx, ctx, input.idempotencyKey, operationFingerprint);
        if (replay) return replay;

        const ledgers = await tx.researchPortfolioContinuityLedger.findMany({
          where: {
            id: { in: continuityIds },
            tenantId: ctx.tenantId,
            portfolioId,
          },
        });

        const ledgerMap = new Map(ledgers.map((ledger) => [ledger.id, ledger]));
        const missingLedgers = continuityIds.filter((id) => !ledgerMap.has(id));
        if (missingLedgers.length > 0) {
          throw new NotFoundException(`Continuity ledgers not found: ${missingLedgers.join(', ')}`);
        }

        const outcomes = [];
        for (const ledgerId of continuityIds) {
          const ledger = ledgerMap.get(ledgerId)!;

          if (ledger.status === 'unchanged' || ledger.status === 'new') {
            outcomes.push({
              reviewId: null,
              status: 'unchanged' as const,
              revision: null,
              decisionId: null,
              message: `Continuity ledger ${ledgerId} is unchanged or new, skipping`,
            });
            continue;
          }

          const triggerFingerprint = fingerprint('annual-continuity', {
            portfolioId,
            continuityKey: ledger.continuityKey,
            dependencyFingerprint: ledger.dependencyFingerprint,
          });

          const existingReview = await tx.researchPortfolioReview.findUnique({
            where: {
              tenantId_portfolioId_triggerFingerprint: {
                tenantId: ctx.tenantId,
                portfolioId,
                triggerFingerprint,
              },
            },
          });

          if (existingReview) {
            outcomes.push({
              reviewId: existingReview.id,
              status: 'unchanged' as const,
              revision: existingReview.revision,
              decisionId: null,
              message: `Review already exists for continuity ledger ${ledgerId}`,
            });
            continue;
          }

          const decision = ledger.currentDecisionId || ledger.priorDecisionId
            ? await tx.researchPortfolioDecision.findFirst({ where: { tenantId: ctx.tenantId, id: ledger.currentDecisionId ?? ledger.priorDecisionId! } })
            : null;
          const review = await tx.researchPortfolioReview.create({
            data: {
              tenantId: ctx.tenantId,
              portfolioId,
              targetKind: decision?.targetKind ?? 'portfolio',
              targetId: decision?.targetId ?? portfolioId,
              trigger: 'annual_continuity',
              triggerIdentity: ledger.continuityKey,
              dependencyIdentity: ledger.dependencyFingerprint,
              reason: input.reason?.trim() || `Annual continuity review reopened due to ${ledger.status}`,
              triggerFingerprint,
              status: 'open',
            },
          });

          await tx.researchPortfolioContinuityLedger.update({
            where: {
              id: ledgerId,
              tenantId: ctx.tenantId,
              portfolioId,
            },
            data: {
              reopeningReason: input.reason?.trim() || `Reopened due to ${ledger.status}`,
              reopeningReviewId: review.id,
            },
          });

          outcomes.push({
            reviewId: review.id,
            status: 'assigned' as const,
            revision: review.revision,
            decisionId: null,
            message: null,
          });
        }

        const successfulReopens = outcomes.filter((o) => o.status === 'assigned');
        if (successfulReopens.length > 0) {
          await this.bumpPortfolioRevision(tx, ctx.tenantId, portfolioId, input.expectedRevision);
        }

        return this.recordReviewMutation(tx, ctx, {
          portfolioId,
          operationFingerprint,
          idempotencyKey: input.idempotencyKey,
          eventKind: 'annual_reopened',
          outcomes,
        });
      },
    );
  }

  // Helper methods
  private async loadAuthorized(
    tx: Tx,
    ctx: TenantContext,
    portfolioId: string,
    requiredRole: RequiredRole,
  ): Promise<{ role: RequiredRole; grantId: string }> {
    const grant = await tx.researchPortfolioGrant.findUnique({
      where: {
        tenantId_portfolioId_principalUserId: {
          tenantId: ctx.tenantId,
          portfolioId,
          principalUserId: ctx.userId,
        },
      },
    });

    if (!grant) {
      throw new ForbiddenException('You do not have access to this portfolio');
    }

    const userRoleLevel = ROLE_LEVEL[grant.role as RequiredRole] ?? 0;
    const requiredRoleLevel = ROLE_LEVEL[requiredRole];

    if (userRoleLevel < requiredRoleLevel) {
      throw new ForbiddenException(`Required role: ${requiredRole}`);
    }

    return { role: grant.role as RequiredRole, grantId: grant.id };
  }

  private async isPortfolioArchived(tx: Tx, tenantId: string, portfolioId: string): Promise<boolean> {
    const portfolio = await tx.researchPortfolio.findUnique({
      where: { id: portfolioId, tenantId },
      select: { lifecycle: true },
    });
    return portfolio?.lifecycle === 'archived';
  }

  private async requireActiveTenantMember(tx: Tx, tenantId: string, userId: string): Promise<void> {
    const membership = await tx.tenantMembership.findFirst({
      where: {
        tenantId,
        userId,
        status: 'active',
      },
    });
    if (!membership) {
      throw new BadRequestException('User is not an active member of this tenant');
    }
  }

  private async bumpPortfolioRevision(
    tx: Tx,
    tenantId: string,
    portfolioId: string,
    expectedRevision: number,
  ): Promise<void> {
    const result = await tx.researchPortfolio.updateMany({
      where: {
        id: portfolioId,
        tenantId,
        revision: expectedRevision,
      },
      data: {
        revision: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw new ConflictException('Portfolio revision mismatch');
    }
  }

  private async replay(
    tx: Tx,
    ctx: TenantContext,
    idempotencyKey: string,
    operationFingerprint: string,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto | null> {
    const existing = await tx.researchPortfolioEvent.findFirst({
      where: {
        tenantId: ctx.tenantId,
        idempotencyKey,
      },
      include: {
        portfolio: {
          select: { id: true },
        },
      },
      orderBy: { occurredAt: 'desc' },
    });

    if (!existing) return null;
    if (existing.payloadFingerprint !== operationFingerprint) {
      throw new ConflictException('Idempotency key was already used for a different operation');
    }

    const outcomes = existing.payload as unknown as {
      reviewId: string;
      status: 'assigned' | 'decided' | 'unchanged' | 'conflict' | 'failed';
      revision: number | null;
      decisionId: string | null;
      message: string | null;
    }[];

    return {
      portfolioId: existing.portfolioId,
      actorUserId: existing.actorUserId,
      occurredAt: asIso(existing.occurredAt),
      outcomes,
    };
  }

  private async recordReviewMutation(
    tx: Tx,
    ctx: TenantContext,
    params: {
      portfolioId: string;
      operationFingerprint: string;
      idempotencyKey: string;
      eventKind?: 'review_updated' | 'annual_reopened';
      outcomes: {
        reviewId: string | null;
        status: 'assigned' | 'decided' | 'unchanged' | 'conflict' | 'failed';
        revision: number | null;
        decisionId: string | null;
        message: string | null;
      }[];
    },
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    const event = await tx.researchPortfolioEvent.create({
      data: {
        tenantId: ctx.tenantId,
        portfolioId: params.portfolioId,
        eventKind: params.eventKind ?? 'review_updated',
        aggregateRevision: await this.getPortfolioRevision(tx, ctx.tenantId, params.portfolioId),
        actorUserId: ctx.userId,
        idempotencyKey: params.idempotencyKey,
        payloadFingerprint: params.operationFingerprint,
        payload: params.outcomes,
      },
    });

    return {
      portfolioId: params.portfolioId,
      actorUserId: ctx.userId,
      occurredAt: asIso(event.occurredAt),
      outcomes: params.outcomes.map((outcome) => ({
        reviewId: outcome.reviewId,
        status: outcome.status,
        revision: outcome.revision,
        decisionId: outcome.decisionId,
        message: outcome.message,
      })),
    };
  }

  private async getPortfolioRevision(tx: Tx, tenantId: string, portfolioId: string): Promise<number> {
    const portfolio = await tx.researchPortfolio.findUnique({
      where: { id: portfolioId, tenantId },
      select: { revision: true },
    });
    return portfolio?.revision ?? 0;
  }

  private async mutateReview(
    ctx: TenantContext,
    portfolioId: string,
    _operation: string,
    _payload: unknown,
    requiredRole: RequiredRole,
    action: (tx: Tx, isArchived: boolean) => Promise<ResearchPortfolioReviewMutationReceiptDto>,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.loadAuthorized(tx, ctx, portfolioId, requiredRole);
      const isArchived = await this.isPortfolioArchived(tx, ctx.tenantId, portfolioId);
      return action(tx, isArchived);
    });
  }

  async addNote(
    ctx: TenantContext,
    portfolioId: string,
    reviewId: string,
    input: { note: string; operationKey: string },
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    const note = input.note?.trim();
    if (!note || note.length === 0) {
      throw new BadRequestException('Note is required');
    }
    if (note.length > 5000) {
      throw new BadRequestException('Note must be less than 5000 characters');
    }
    const operationKey = input.operationKey?.trim();
    if (!operationKey || operationKey.length === 0) {
      throw new BadRequestException('operationKey is required');
    }

    return this.prisma.withTenant(ctx.tenantId, async (tx): Promise<ResearchPortfolioReviewMutationReceiptDto> => {
      await this.loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const isArchived = await this.isPortfolioArchived(tx, ctx.tenantId, portfolioId);
      if (isArchived) {
        throw new BadRequestException('Cannot add notes to reviews for archived portfolio');
      }

      const existing = await tx.researchPortfolioEvent.findFirst({
        where: { tenantId: ctx.tenantId, idempotencyKey: operationKey },
      });
      if (existing) {
        const payload = existing.payload as any;
        if (payload?.noteId) {
          return {
            portfolioId: existing.portfolioId,
            actorUserId: existing.actorUserId,
            occurredAt: asIso(existing.occurredAt),
            outcomes: [
              {
                reviewId,
                status: 'note_added',
                revision: null,
                noteId: payload.noteId,
                message: null,
              },
            ],
          };
        }
        throw new ConflictException('Idempotency key was already used for a different operation');
      }

      const review = await tx.researchPortfolioReview.findUnique({
        where: { id: reviewId, tenantId: ctx.tenantId, portfolioId },
      });
      if (!review) {
        throw new NotFoundException('Review not found');
      }

      const noteRecord = await tx.researchPortfolioReviewNote.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          reviewId,
          authorUserId: ctx.userId,
          body: note,
        },
      });

      await this.bumpPortfolioRevision(tx, ctx.tenantId, portfolioId, review.revision);

      const event = await tx.researchPortfolioEvent.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          eventKind: 'review_note_added',
          aggregateRevision: await this.getPortfolioRevision(tx, ctx.tenantId, portfolioId),
          actorUserId: ctx.userId,
          idempotencyKey: operationKey,
          payloadFingerprint: createHash('sha256')
            .update(JSON.stringify({ operation: 'review.note', reviewId, noteId: noteRecord.id }))
            .digest('hex'),
          payload: { noteId: noteRecord.id, reviewId },
        },
      });

      return {
        portfolioId,
        actorUserId: ctx.userId,
        occurredAt: asIso(event.occurredAt),
        outcomes: [
          {
            reviewId,
            status: 'note_added',
            revision: review.revision,
            noteId: noteRecord.id,
            message: null,
          },
        ],
      };
    });
  }

  private reviewDto(review: any): ResearchPortfolioReviewDto {
    return {
      id: review.id,
      tenantId: review.tenantId,
      portfolioId: review.portfolioId,
      targetKind: review.targetKind,
      targetId: review.targetId,
      trigger: review.trigger,
      triggerIdentity: review.triggerIdentity,
      dependencyIdentity: review.dependencyIdentity,
      assigneeUserId: review.assigneeUserId,
      reason: review.reason,
      evidenceFor: review.evidenceFor as readonly ResearchPortfolioReviewEvidenceDto[],
      evidenceAgainst: review.evidenceAgainst as readonly ResearchPortfolioReviewEvidenceDto[],
      revision: review.revision,
      triggerFingerprint: review.triggerFingerprint,
      status: review.status,
      createdAt: asIso(review.createdAt),
      updatedAt: asIso(review.updatedAt),
      resolvedAt: review.resolvedAt ? asIso(review.resolvedAt) : null,
    };
  }

  private continuityLedgerDto(ledger: any): ResearchPortfolioContinuityLedgerDto {
    return {
      id: ledger.id,
      tenantId: ledger.tenantId,
      portfolioId: ledger.portfolioId,
      priorDecisionId: ledger.priorDecisionId,
      currentDecisionId: ledger.currentDecisionId,
      continuityKey: ledger.continuityKey,
      priorDependencyFingerprint: ledger.priorDependencyFingerprint,
      dependencyFingerprint: ledger.dependencyFingerprint,
      status: ledger.status as ResearchPortfolioContinuityStatus,
      identityMapping: ledger.identityMapping as Readonly<Record<string, unknown>>,
      changedDependencies: ledger.changedDependencies as Readonly<Record<string, unknown>>,
      originalEvidence: ledger.originalEvidence as Readonly<Record<string, unknown>>,
      sourceEdition: ledger.sourceEdition,
      relevantPeriodStart: ledger.relevantPeriodStart ? asIso(ledger.relevantPeriodStart) : null,
      relevantPeriodEnd: ledger.relevantPeriodEnd ? asIso(ledger.relevantPeriodEnd) : null,
      expiryDate: ledger.expiryDate ? asIso(ledger.expiryDate) : null,
      reopeningReason: ledger.reopeningReason,
      reopeningReviewId: ledger.reopeningReviewId,
      createdAt: asIso(ledger.createdAt),
      updatedAt: asIso(ledger.updatedAt),
    };
  }
}
