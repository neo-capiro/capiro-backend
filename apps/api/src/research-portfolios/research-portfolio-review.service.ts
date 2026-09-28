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
  RefreshResearchPortfolioAnnualReviewDto,
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
import { readCanonicalResearchTarget } from './research-portfolio-targets.js';

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
          where.OR = [{ assigneeUserId: null }, { assigneeUserId: { not: ctx.userId } }];
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
        const reason = input.reason?.trim();
        if (!reason) throw new BadRequestException('Assignment requires a non-empty reason');
        const operationFingerprint = fingerprint('review.assign', {
          reviewId,
          assigneeUserId: input.assigneeUserId,
          reason,
          expectedRevision: input.expectedRevision,
          expectedPortfolioRevision: input.expectedPortfolioRevision,
        });

        const replay = await this.replay(
          tx,
          ctx,
          input.idempotencyKey,
          operationFingerprint,
          portfolioId,
        );
        if (replay) return replay;

        if (isArchived) {
          throw new BadRequestException('Cannot assign reviews for archived portfolio');
        }

        const review = await tx.researchPortfolioReview.findUnique({
          where: { id: reviewId, tenantId: ctx.tenantId, portfolioId },
        });

        if (!review) {
          throw new NotFoundException('Review not found');
        }

        if (review.status === 'resolved' || review.status === 'cancelled') {
          throw new BadRequestException('Cannot assign a resolved or cancelled review');
        }
        if (review.revision !== input.expectedRevision)
          throw new ConflictException('Review revision mismatch');

        if (input.assigneeUserId !== null) {
          await this.requireActiveTenantMember(tx, ctx.tenantId, input.assigneeUserId);
        }

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

        await this.bumpPortfolioRevision(
          tx,
          ctx.tenantId,
          portfolioId,
          input.expectedPortfolioRevision,
        );

        return this.recordReviewMutation(tx, ctx, {
          portfolioId,
          operationFingerprint,
          idempotencyKey: input.idempotencyKey,
          outcomes: [
            {
              reviewId,
              status: 'assigned',
              revision: updatedReview.revision,
              decisionId: null,
              message: null,
            },
          ],
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
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      this.decideInTransaction(tx, ctx, portfolioId, reviewId, input),
    );
  }

  async decideInTransaction(
    tx: Tx,
    ctx: TenantContext,
    portfolioId: string,
    reviewId: string,
    input: DecideResearchPortfolioReviewDto,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    await this.loadAuthorized(tx, ctx, portfolioId, 'editor');
    const isArchived = await this.isPortfolioArchived(tx, ctx.tenantId, portfolioId);
    const reason = input.reason?.trim();
    if (!reason) {
      throw new BadRequestException('Decision requires a non-empty reason');
    }

    const request = {
      reviewId,
      decisionType: input.decisionType,
      reason,
      priorDecisionId: input.priorDecisionId ?? null,
      expectedRevision: input.expectedRevision,
      expectedPortfolioRevision: input.expectedPortfolioRevision,
      evidenceFor: input.evidenceFor ?? [],
      evidenceAgainst: input.evidenceAgainst ?? [],
    };
    const operationFingerprint = fingerprint('review.decide', {
      ...request,
      requestVersion: 2,
      portfolioId,
      priorDecisionSpecified: input.priorDecisionId !== undefined,
    });
    const replay = await this.replay(
      tx,
      ctx,
      input.idempotencyKey,
      operationFingerprint,
      portfolioId,
      async (event) => {
        const outcomes = event.payload as { decisionId?: string | null }[];
        const decisionId = Array.isArray(outcomes) ? outcomes[0]?.decisionId : null;
        if (!decisionId) return null;
        const committedDecision = await tx.researchPortfolioDecision.findFirst({
          where: { id: decisionId, tenantId: ctx.tenantId, portfolioId, reviewId },
        });
        if (!committedDecision) return null;
        if (
          input.priorDecisionId !== undefined &&
          input.priorDecisionId !== committedDecision.priorDecisionId
        )
          return null;
        return fingerprint('review.decide', {
          ...request,
          priorDecisionId: committedDecision.priorDecisionId ?? null,
        });
      },
    );
    if (replay) return replay;

    if (isArchived) {
      throw new BadRequestException('Cannot decide reviews for archived portfolio');
    }

    const review = await tx.researchPortfolioReview.findUnique({
      where: { id: reviewId, tenantId: ctx.tenantId, portfolioId },
    });

    if (!review) {
      throw new NotFoundException('Review not found');
    }

    if (
      review.status === 'cancelled' ||
      (review.status === 'resolved' && input.decisionType !== 'reopen')
    ) {
      throw new BadRequestException('Cannot decide a resolved or cancelled review');
    }
    if (review.revision !== input.expectedRevision)
      throw new ConflictException('Review revision mismatch');

    this.validateDecisionEvidence(input.decisionType, input.evidenceFor, input.evidenceAgainst);

    const priorDecision = await tx.researchPortfolioDecision.findFirst({
      where: { tenantId: ctx.tenantId, portfolioId, reviewId },
      orderBy: [{ decisionTime: 'desc' }, { id: 'desc' }],
    });

    if (
      input.priorDecisionId !== undefined &&
      input.priorDecisionId !== (priorDecision?.id ?? null)
    ) {
      throw new ConflictException('Prior decision mismatch');
    }

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
    await this.captureDecisionContinuity(tx, ctx, portfolioId, {
      ...decision,
      targetKind: review.targetKind,
      targetId: review.targetId,
      priorDecisionId: priorDecision?.id ?? null,
      evidenceFor: input.evidenceFor ?? [],
      evidenceAgainst: input.evidenceAgainst ?? [],
      decisionTime: decision.decisionTime ?? new Date(),
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

    await this.bumpPortfolioRevision(
      tx,
      ctx.tenantId,
      portfolioId,
      input.expectedPortfolioRevision,
    );

    return this.recordReviewMutation(tx, ctx, {
      portfolioId,
      operationFingerprint,
      idempotencyKey: input.idempotencyKey,
      outcomes: [
        {
          reviewId,
          status: 'decided',
          revision: updatedReview.revision,
          decisionId: decision.id,
          message: null,
        },
      ],
    });
  }

  /** Reuses the browser decision transaction, including immutable decision lineage. */
  async importReviewInTransaction(
    tx: Tx,
    ctx: TenantContext,
    portfolioId: string,
    row: Record<string, unknown>,
    operationKey: string,
    expectedPortfolioRevision: number,
  ) {
    await this.loadAuthorized(tx, ctx, portfolioId, 'editor');
    if (await this.isPortfolioArchived(tx, ctx.tenantId, portfolioId))
      throw new BadRequestException('Cannot import reviews for archived portfolio');
    const targetKind = String(row.target_kind ?? '') as ResearchPortfolioReviewTargetKind;
    const targetId = String(row.target_id ?? '').trim();
    if (targetKind === 'portfolio') {
      if (targetId !== portfolioId)
        throw new BadRequestException(
          'Portfolio review target must match the authorized portfolio',
        );
    } else if (targetKind === 'rule') {
      if (
        !(await tx.researchPortfolioRuleVersion.findFirst({
          where: { id: targetId, tenantId: ctx.tenantId, portfolioId },
        }))
      )
        throw new NotFoundException('Rule review target not found');
    } else if (
      !['program', 'program_element', 'project', 'budget_line', 'award'].includes(targetKind) ||
      !(await readCanonicalResearchTarget(tx, targetKind as any, targetId))
    ) {
      throw new NotFoundException('Canonical review target not found');
    }
    const reason = String(row.reason ?? '').trim();
    if (!reason || reason.length > 10000)
      throw new BadRequestException('Import review reason must be between 1 and 10000 characters');
    const decisionType = String(row.decision_type ?? 'defer') as ResearchPortfolioDecisionType;
    if (!['include', 'exclude', 'defer', 'reopen', 'dispute'].includes(decisionType))
      throw new BadRequestException('Unsupported review decision type');
    const evidence = (
      value: unknown,
      stance: 'for' | 'against',
    ): ResearchPortfolioReviewEvidenceDto[] => {
      let rows: unknown;
      try {
        rows = value ? (typeof value === 'string' ? JSON.parse(value) : value) : [];
      } catch {
        throw new BadRequestException('Review evidence must contain valid JSON');
      }
      if (!Array.isArray(rows))
        throw new BadRequestException('Review evidence must be a bounded array');
      return this.validateEvidence(
        rows.map((item: any) => ({
          ...item,
          stance: item?.stance ?? stance,
          quote: item?.quote ?? null,
        })),
        stance,
      );
    };
    const evidenceFor = evidence(row.evidence_for, 'for');
    const evidenceAgainst = evidence(row.evidence_against, 'against');
    this.validateDecisionEvidence(decisionType, evidenceFor, evidenceAgainst);
    const triggerFingerprint = fingerprint('review.import', {
      portfolioId,
      operationKey,
      targetKind,
      targetId,
    });
    let review = await tx.researchPortfolioReview.findUnique({
      where: {
        tenantId_portfolioId_triggerFingerprint: {
          tenantId: ctx.tenantId,
          portfolioId,
          triggerFingerprint,
        },
      },
    });
    if (!review)
      review = await tx.researchPortfolioReview.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          targetKind,
          targetId,
          trigger: 'import',
          triggerIdentity: operationKey,
          reason,
          triggerFingerprint,
          status: 'open',
          evidenceFor: evidenceFor as any,
          evidenceAgainst: evidenceAgainst as any,
        },
      });
    return this.decideInTransaction(tx, ctx, portfolioId, review.id, {
      idempotencyKey: operationKey,
      expectedRevision: 1,
      expectedPortfolioRevision,
      decisionType,
      reason,
      priorDecisionId: null,
      evidenceFor,
      evidenceAgainst,
    });
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

    const decisionTypes = new Set<ResearchPortfolioDecisionType>(
      items.map((item) => item.decisionType),
    );
    if (decisionTypes.size > 1)
      throw new BadRequestException(
        'Bulk decisions must use one compatible decision type and scope',
      );

    return this.mutateReview(
      ctx,
      portfolioId,
      'review.bulk-decide',
      { ...input, items },
      'editor',
      async (tx, isArchived) => {
        const operationFingerprint = fingerprint('review.bulk-decide', {
          reviewIds: Array.from(reviewIds),
          decisionTypes: Array.from(decisionTypes),
          expectedRevision: input.expectedRevision,
          items,
        });

        const replay = await this.replay(
          tx,
          ctx,
          input.idempotencyKey,
          operationFingerprint,
          portfolioId,
        );
        if (replay) return replay;

        if (isArchived) {
          throw new BadRequestException('Cannot bulk decide reviews for archived portfolio');
        }

        for (const item of items)
          this.validateDecisionEvidence(item.decisionType, item.evidenceFor, item.evidenceAgainst);

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

          if (
            review.status === 'cancelled' ||
            (review.status === 'resolved' && item.decisionType !== 'reopen')
          ) {
            outcomes.push({
              reviewId: item.reviewId,
              status: 'failed' as const,
              revision: review.revision,
              decisionId: null,
              message: 'Review is already resolved or cancelled',
            });
            continue;
          }
          if (review.revision !== item.expectedRevision) {
            outcomes.push({
              reviewId: item.reviewId,
              status: 'conflict' as const,
              revision: review.revision,
              decisionId: null,
              message: 'Review revision mismatch',
            });
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
          await this.captureDecisionContinuity(tx, ctx, portfolioId, {
            ...decision,
            targetKind: review.targetKind,
            targetId: review.targetId,
            priorDecisionId: priorDecision?.id ?? null,
            evidenceFor: item.evidenceFor ?? [],
            evidenceAgainst: item.evidenceAgainst ?? [],
            decisionTime: decision.decisionTime ?? new Date(),
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
      return this.projectAnnualReview(tx, ctx, portfolioId, this.continuityScope(), false);
    });
  }

  async refreshAnnualReview(
    ctx: TenantContext,
    portfolioId: string,
    input: RefreshResearchPortfolioAnnualReviewDto,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 128)
      throw new BadRequestException('idempotencyKey must be between 1 and 128 characters');
    const scope = this.continuityScope(input);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.loadAuthorized(tx, ctx, portfolioId, 'editor');
      const operationFingerprint = fingerprint('annual-review.refresh', {
        portfolioId,
        ...input,
        decisionIds: scope.decisionIds ?? null,
      });
      const replay = await this.replay(
        tx,
        ctx,
        input.idempotencyKey,
        operationFingerprint,
        portfolioId,
      );
      if (replay) return replay;
      if (await this.isPortfolioArchived(tx, ctx.tenantId, portfolioId))
        throw new BadRequestException('Cannot refresh annual review for archived portfolio');
      if (
        (await this.getPortfolioRevision(tx, ctx.tenantId, portfolioId)) !== input.expectedRevision
      )
        throw new ConflictException('Portfolio revision mismatch');
      const annual = await this.projectAnnualReview(tx, ctx, portfolioId, scope, true);
      await this.bumpPortfolioRevision(tx, ctx.tenantId, portfolioId, input.expectedRevision);
      return this.recordReviewMutation(tx, ctx, {
        portfolioId,
        idempotencyKey: input.idempotencyKey,
        operationFingerprint,
        outcomes: annual.items.map((item) => ({
          reviewId: item.reopeningReviewId,
          status: 'unchanged' as const,
          revision: null,
          decisionId: item.currentDecisionId,
          message: `Continuity ${item.id}: ${item.status}`,
        })),
      });
    });
  }

  private continuityScope(
    input: { asOfFiscalYear?: number; knownAt?: string; decisionIds?: readonly string[] } = {},
  ) {
    const now = new Date();
    const asOfFiscalYear =
      input.asOfFiscalYear ?? now.getUTCFullYear() + (now.getUTCMonth() >= 9 ? 1 : 0);
    const knownAt = input.knownAt ? new Date(input.knownAt) : now;
    if (
      !Number.isInteger(asOfFiscalYear) ||
      asOfFiscalYear < 1900 ||
      asOfFiscalYear > 2200 ||
      Number.isNaN(knownAt.getTime()) ||
      knownAt > now
    )
      throw new BadRequestException(
        'Annual continuity requires a valid fiscal year and a timestamp no later than now',
      );
    if (
      input.decisionIds &&
      (!input.decisionIds.length ||
        input.decisionIds.length > 100 ||
        new Set(input.decisionIds).size !== input.decisionIds.length)
    )
      throw new BadRequestException('Decision scope must contain between 1 and 100 distinct IDs');
    return {
      asOfFiscalYear,
      knownAt,
      requestedHistoricalKnowledge: Boolean(input.knownAt),
      decisionIds: input.decisionIds ? [...input.decisionIds].sort() : undefined,
    };
  }

  /** Checks immutable references and exact locators; does not qualify opaque references as official sources. */
  private validateDecisionEvidence(
    decisionType: ResearchPortfolioDecisionType,
    evidenceFor: unknown,
    evidenceAgainst: unknown,
  ): void {
    if (!['include', 'exclude', 'defer', 'reopen', 'dispute'].includes(decisionType))
      throw new BadRequestException('Unsupported review decision type');
    const lanes = [
      this.validateEvidence(evidenceFor, 'for'),
      this.validateEvidence(evidenceAgainst, 'against'),
    ];
    if (
      ['include', 'exclude', 'dispute'].includes(decisionType) &&
      lanes.every((lane) => lane.length === 0)
    )
      throw new BadRequestException('Include, exclude, and dispute decisions require evidence');
  }

  private validateEvidence(
    value: unknown,
    stance: 'for' | 'against',
  ): ResearchPortfolioReviewEvidenceDto[] {
    const rows = value === undefined || value === null ? [] : value;
    if (!Array.isArray(rows) || rows.length > 100)
      throw new BadRequestException('Review evidence must be a bounded array of at most 100 items');
    return rows.map((item: any) => {
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        typeof item.sourceRevisionId !== 'string' ||
        !item.sourceRevisionId.trim() ||
        item.sourceRevisionId.length > 2048 ||
        item.stance !== stance ||
        (item.quote !== undefined &&
          item.quote !== null &&
          (typeof item.quote !== 'string' || item.quote.length > 10000)) ||
        !this.hasExactReviewLocator(item.locator)
      ) {
        throw new BadRequestException(
          'Review evidence requires an immutable source reference, typed exact locator, matching stance, and bounded text quote',
        );
      }
      return item as ResearchPortfolioReviewEvidenceDto;
    });
  }

  private hasExactReviewLocator(locator: any): boolean {
    if (
      !locator ||
      typeof locator !== 'object' ||
      Array.isArray(locator) ||
      Object.keys(locator).length > 20
    )
      return false;
    try {
      if (JSON.stringify(locator).length > 16384) return false;
    } catch {
      return false;
    }
    const positive = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    const text = (value: unknown) =>
      typeof value === 'string' && Boolean(value.trim()) && value.length <= 2048;
    const range = (start: unknown, end: unknown) =>
      typeof start === 'number' &&
      typeof end === 'number' &&
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      end > start;
    // A supplied malformed coordinate cannot be rescued by another valid coordinate.
    for (const key of ['page', 'pageNumber', 'paragraph'])
      if (locator[key] !== undefined && !positive(locator[key])) return false;
    for (const key of ['xmlPath', 'xpath'])
      if (
        locator[key] !== undefined &&
        !(
          text(locator[key]) &&
          locator[key].trim().startsWith('/') &&
          locator[key].trim().length > 1
        )
      )
        return false;
    for (const key of ['table', 'section', 'row', 'cell'])
      if (locator[key] !== undefined && !(positive(locator[key]) || text(locator[key])))
        return false;
    if (locator.start !== undefined || locator.end !== undefined) {
      if (!range(locator.start, locator.end)) return false;
    }
    if (
      locator.span !== undefined &&
      !(
        locator.span &&
        typeof locator.span === 'object' &&
        !Array.isArray(locator.span) &&
        range(locator.span.start, locator.span.end)
      )
    )
      return false;
    return (
      positive(locator.page) ||
      positive(locator.pageNumber) ||
      positive(locator.paragraph) ||
      text(locator.xmlPath) ||
      text(locator.xpath) ||
      range(locator.start, locator.end) ||
      Boolean(locator.span) ||
      text(locator.section) ||
      ((text(locator.table) || positive(locator.table)) &&
        (text(locator.row) ||
          positive(locator.row) ||
          text(locator.cell) ||
          positive(locator.cell)))
    );
  }

  private hasTypedContinuityLocator(value: any): boolean {
    const locator = value?.locator ?? value;
    if (!locator || typeof locator !== 'object' || Array.isArray(locator)) return false;
    return (
      (Number.isInteger(locator.page) && locator.page > 0) ||
      (Number.isInteger(locator.pageNumber) && locator.pageNumber > 0) ||
      (typeof locator.xmlPath === 'string' &&
        locator.xmlPath.trim().startsWith('/') &&
        locator.xmlPath.trim().length > 1) ||
      (Number.isInteger(locator.start) &&
        Number.isInteger(locator.end) &&
        locator.start >= 0 &&
        locator.end > locator.start) ||
      (typeof locator.table === 'string' &&
        Boolean(locator.table.trim()) &&
        ((Number.isInteger(locator.row) && locator.row >= 0) ||
          (typeof locator.row === 'string' && Boolean(locator.row.trim()))))
    );
  }

  private continuityUrl(value: string | null | undefined): boolean {
    try {
      const url = new URL(value ?? '');
      return ['https:', 'http:'].includes(url.protocol) && Boolean(url.hostname);
    } catch {
      return false;
    }
  }

  private async continuityBasis(
    tx: Tx,
    decision: any,
    scope: { asOfFiscalYear: number; knownAt: Date; requestedHistoricalKnowledge?: boolean },
  ) {
    const supportedKinds = ['program', 'program_element', 'project', 'budget_line'];
    const canonical = supportedKinds.includes(decision.targetKind)
      ? await readCanonicalResearchTarget(tx, decision.targetKind, decision.targetId)
      : null;
    const kind = (
      { program_element: 'pe', project: 'pe_project', budget_line: 'procurement_line' } as Record<
        string,
        string
      >
    )[decision.targetKind];
    const identityWhere =
      decision.targetKind === 'program' && /^[0-9a-f-]{36}$/i.test(decision.targetId)
        ? { programId: decision.targetId }
        : kind
          ? { identityKind: kind, sourceIdentifier: decision.targetId }
          : null;
    const rows = identityWhere
      ? await tx.programIdentityCrosswalk.findMany({
          where: {
            ...identityWhere,
            reviewStatus: 'accepted',
            recordedAt: { lte: scope.knownAt },
            AND: [
              { OR: [{ validFromFy: null }, { validFromFy: { lte: scope.asOfFiscalYear } }] },
              { OR: [{ validToFy: null }, { validToFy: { gte: scope.asOfFiscalYear } }] },
            ],
            revisions: { none: { reviewStatus: 'accepted', recordedAt: { lte: scope.knownAt } } },
          },
          include: {
            program: { select: { id: true, canonicalName: true, status: true } },
            sourceDocument: {
              select: {
                id: true,
                sha256: true,
                fiscalYear: true,
                ingestedAt: true,
                sourceUrl: true,
              },
            },
          },
          orderBy: { id: 'asc' },
          take: 201,
        })
      : [];
    if (rows.length > 200)
      throw new BadRequestException(
        'Continuity supports at most 200 accepted mappings per decision',
      );
    const pe =
      decision.targetKind === 'program_element'
        ? await tx.programElement.findUnique({
            where: { peCode: decision.targetId },
            include: {
              sources: {
                where: { observedAt: { lte: scope.knownAt } },
                include: { sourceDocument: true },
                orderBy: { id: 'asc' },
                take: 201,
              },
            },
          })
        : null;
    if ((pe?.sources?.length ?? 0) > 200)
      throw new BadRequestException(
        'Continuity supports at most 200 canonical PE source records per decision',
      );
    const sourceBasis = (pe?.sources ?? [])
      .filter(
        (source) =>
          source.confidence >= 0.8 &&
          /^[0-9a-f]{64}$/i.test(source.sourceDocument?.sha256 ?? '') &&
          !source.sourceDocument?.supersededByDocumentId &&
          Number.isInteger(source.pageNumber) &&
          (source.pageNumber ?? 0) > 0 &&
          source.observedAt <= scope.knownAt &&
          source.sourceDocument &&
          source.sourceDocument.ingestedAt <= scope.knownAt &&
          this.continuityUrl(source.sourceUrl || source.sourceDocument.sourceUrl),
      )
      .map((source) => ({
        id: source.id,
        sourceDocumentId: source.sourceDocumentId,
        sha256: source.sourceDocument?.sha256,
        fiscalYear: source.fy,
        pageNumber: source.pageNumber,
        pageEnd: source.pageEnd,
        confidence: source.confidence,
        observedAt: source.observedAt.toISOString(),
        ingestedAt: source.sourceDocument?.ingestedAt.toISOString(),
        sourceUrl: source.sourceUrl || source.sourceDocument?.sourceUrl,
      }));
    const mappings = rows.map((row) => ({
      id: row.id,
      programId: row.programId,
      program: row.program,
      identityKind: row.identityKind,
      sourceSystem: row.sourceSystem,
      sourceIdentifier: row.sourceIdentifier,
      relationshipKind: row.relationshipKind,
      validFromFy: row.validFromFy,
      validToFy: row.validToFy,
      recordedAt: row.recordedAt.toISOString(),
      supersedesId: row.supersedesId,
      sourceDocumentId: row.sourceDocumentId,
      sourceDocument: row.sourceDocument,
      source: row.source,
      sourceUrl: row.sourceUrl,
      evidence: row.evidence,
      confidence: row.confidence,
      reviewStatus: row.reviewStatus,
      qualified:
        row.confidence >= 0.8 &&
        row.confidence <= 1 &&
        /^[0-9a-f]{64}$/i.test(row.sourceDocument?.sha256 ?? '') &&
        this.hasTypedContinuityLocator(row.evidence) &&
        this.continuityUrl(row.sourceUrl || row.sourceDocument?.sourceUrl) &&
        Boolean(row.sourceDocument && row.sourceDocument.ingestedAt <= scope.knownAt),
    }));
    const dependency = JSON.parse(
      JSON.stringify({
        targetKind: decision.targetKind,
        targetId: decision.targetId,
        canonical,
        mappings,
        sourceBasis,
        canonicalQualification: pe
          ? { sourceConfidence: pe.sourceConfidence, retiredAt: pe.retiredAt ?? null }
          : null,
      }),
    );
    const dependencyFingerprint = fingerprint('annual-continuity.dependencies.v1', dependency);
    const qualifiedMappings = mappings.filter((mapping) => mapping.qualified);
    const hasSourceBasis =
      decision.targetKind === 'program_element'
        ? Boolean(
            pe &&
            !pe.retiredAt &&
            pe.sourceConfidence != null &&
            pe.sourceConfidence >= 0.8 &&
            sourceBasis.length,
          )
        : qualifiedMappings.length > 0;
    const sourceEditionAvailability =
      sourceBasis.length || qualifiedMappings.length
        ? [
            ...sourceBasis.map((source) => source.fiscalYear),
            ...qualifiedMappings.map((mapping) => mapping.sourceDocument?.fiscalYear),
          ].every((year) => Number.isInteger(year) && (year ?? 0) >= 1900 && (year ?? 0) <= 2200)
          ? 'available'
          : 'partial'
        : 'unavailable';
    const limitations = [
      'Canonical facts are a current projection; only accepted identity mappings support temporal knownAt selection.',
      'Source hashes and locators do not qualify archive retention or corpus coverage.',
      ...(scope.requestedHistoricalKnowledge
        ? ['historical_canonical_source_projection_not_supported']
        : []),
      ...(sourceEditionAvailability !== 'available' ? ['source_edition_not_fully_available'] : []),
      ...(mappings.some((mapping) => !mapping.qualified)
        ? ['accepted_mapping_evidence_not_fully_qualified']
        : []),
    ];
    return {
      ...dependency,
      dependencyFingerprint,
      asOfFiscalYear: scope.asOfFiscalYear,
      knownAt: scope.knownAt.toISOString(),
      knownAtSupport: 'current_projection_with_temporal_identity',
      sourceEditionAvailability,
      limitations,
      mappingAvailable: !scope.requestedHistoricalKnowledge && qualifiedMappings.length > 0,
      available:
        !scope.requestedHistoricalKnowledge &&
        Boolean(canonical && canonical.facts.qualification === 'qualified' && hasSourceBasis),
    };
  }

  private async captureDecisionContinuity(
    tx: Tx,
    ctx: TenantContext,
    portfolioId: string,
    decision: any,
  ): Promise<void> {
    const scope = this.continuityScope();
    const baseline = await this.continuityBasis(tx, decision, scope);
    await tx.researchPortfolioContinuityLedger.create({
      data: {
        tenantId: ctx.tenantId,
        portfolioId,
        priorDecisionId: decision.priorDecisionId ?? null,
        currentDecisionId: decision.id,
        continuityKey: fingerprint('annual-continuity.decision.v1', {
          portfolioId,
          decisionId: decision.id,
        }),
        priorDependencyFingerprint: baseline.dependencyFingerprint,
        dependencyFingerprint: baseline.dependencyFingerprint,
        status: baseline.available ? 'unchanged' : 'unresolved',
        identityMapping: {
          mappings: baseline.mappings,
          asOfFiscalYear: baseline.asOfFiscalYear,
          knownAt: baseline.knownAt,
          knownAtSupport: baseline.knownAtSupport,
          sourceEditionAvailability: baseline.sourceEditionAvailability,
          limitations: baseline.limitations,
        },
        changedDependencies: baseline.available
          ? {}
          : { reasons: ['canonical_identity_continuity_unavailable'] },
        originalEvidence: JSON.parse(
          JSON.stringify({
            baselineVersion: 1,
            baseline,
            evidenceSourceQualification: 'unresolved_reference',
            evidenceQualificationLimitations: [
              'Review source references are retained without source resolution or official provenance qualification.',
            ],
            decisionId: decision.id,
            targetKind: decision.targetKind,
            targetId: decision.targetId,
            decisionType: decision.decisionType ?? null,
            reason: decision.reason ?? null,
            priorDecisionId: decision.priorDecisionId ?? null,
            decisionTime: decision.decisionTime,
            authorUserId: ctx.userId,
            evidenceFor: decision.evidenceFor ?? [],
            evidenceAgainst: decision.evidenceAgainst ?? [],
          }),
        ),
      },
    });
  }

  private async projectAnnualReview(
    tx: Tx,
    ctx: TenantContext,
    portfolioId: string,
    scope: {
      asOfFiscalYear: number;
      knownAt: Date;
      requestedHistoricalKnowledge?: boolean;
      decisionIds?: readonly string[];
    },
    persist: boolean,
  ): Promise<ResearchPortfolioAnnualReviewDto> {
    const decisions = await tx.researchPortfolioDecision.findMany({
      where: {
        tenantId: ctx.tenantId,
        portfolioId,
        ...(scope.decisionIds ? { id: { in: [...scope.decisionIds] } } : {}),
        decisionTime: { lte: scope.knownAt },
      },
      orderBy: [{ decisionTime: 'desc' }, { id: 'desc' }],
      take: 101,
    });
    if (decisions.length > 100)
      throw new BadRequestException(
        'Annual continuity supports at most 100 decisions per request; refresh an explicit decision scope',
      );
    if (scope.decisionIds && decisions.length !== scope.decisionIds.length)
      throw new NotFoundException(
        'One or more scoped decisions were not found in the authorized portfolio and temporal scope',
      );
    const latest = new Map<string, any>();
    for (const decision of decisions)
      if (!latest.has(`${decision.targetKind}:${decision.targetId}`))
        latest.set(`${decision.targetKind}:${decision.targetId}`, decision);
    const ledgers = await tx.researchPortfolioContinuityLedger.findMany({
      where: {
        tenantId: ctx.tenantId,
        portfolioId,
        currentDecisionId: { in: [...latest.values()].map((decision) => decision.id) },
      },
    });
    const ledgerByDecision = new Map(ledgers.map((ledger) => [ledger.currentDecisionId, ledger]));
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
    const items = [];
    for (const decision of latest.values()) {
      const ledger = ledgerByDecision.get(decision.id);
      const original = ledger?.originalEvidence as any;
      const baseline = original?.baselineVersion === 1 ? original.baseline : null;
      const current = await this.continuityBasis(tx, decision, scope);
      let status: ResearchPortfolioContinuityStatus =
        !baseline || !current.available || !baseline.available
          ? 'unresolved'
          : baseline.dependencyFingerprint === current.dependencyFingerprint
            ? 'unchanged'
            : 'changed';
      if (
        baseline?.available &&
        (current.available || current.mappingAvailable) &&
        baseline.dependencyFingerprint !== current.dependencyFingerprint
      ) {
        const originalMappingIds = new Set(baseline.mappings.map((mapping: any) => mapping.id));
        const added = current.mappings.filter(
          (mapping: any) => mapping.qualified && !originalMappingIds.has(mapping.id),
        );
        if (
          added.some((mapping: any) =>
            ['split_from', 'split_into'].includes(mapping.relationshipKind),
          )
        )
          status = 'split';
        else if (
          added.some((mapping: any) =>
            ['merged_into', 'merged_from'].includes(mapping.relationshipKind),
          )
        )
          status = 'merged';
        else if (
          added.some((mapping: any) =>
            ['renumbered_from', 'renumbered_to'].includes(mapping.relationshipKind),
          )
        )
          status = 'renumbered';
        else if (
          added.some((mapping: any) =>
            ['renamed_from', 'renamed_to'].includes(mapping.relationshipKind),
          )
        )
          status = 'renamed';
        else if (
          baseline.mappings.length &&
          !current.mappings.length &&
          baseline.mappings.every(
            (mapping: any) => mapping.validToFy != null && mapping.validToFy < scope.asOfFiscalYear,
          )
        )
          status = 'expired';
      }
      if (
        !scope.requestedHistoricalKnowledge &&
        baseline?.available &&
        current.canonicalQualification?.retiredAt &&
        !['split', 'merged', 'renumbered', 'renamed'].includes(status)
      )
        status = 'expired';
      const data: any = {
        tenantId: ctx.tenantId,
        portfolioId,
        priorDecisionId: decision.priorDecisionId,
        currentDecisionId: decision.id,
        continuityKey: fingerprint('annual-continuity.decision.v1', {
          portfolioId,
          decisionId: decision.id,
        }),
        priorDependencyFingerprint: baseline?.dependencyFingerprint ?? null,
        dependencyFingerprint: current.dependencyFingerprint,
        status,
        identityMapping: {
          mappings: current.mappings,
          asOfFiscalYear: scope.asOfFiscalYear,
          knownAt: scope.knownAt.toISOString(),
          knownAtSupport: current.knownAtSupport,
          sourceEditionAvailability: current.sourceEditionAvailability,
          limitations: current.limitations,
        },
        changedDependencies:
          status === 'unchanged'
            ? {}
            : {
                reasons: !baseline
                  ? ['original_dependency_basis_not_captured']
                  : scope.requestedHistoricalKnowledge
                    ? ['historical_canonical_source_projection_not_supported']
                    : !baseline.available || !current.available
                      ? ['canonical_identity_continuity_unavailable']
                      : ['accepted_identity_or_canonical_source_dependencies_changed'],
                originalDependencyFingerprint: baseline?.dependencyFingerprint ?? null,
                currentDependencyFingerprint: current.dependencyFingerprint,
              },
        originalEvidence: original ?? {
          baselineVersion: null,
          decisionId: decision.id,
          evidenceFor: decision.evidenceFor,
          evidenceAgainst: decision.evidenceAgainst,
        },
        sourceEdition:
          current.mappings
            .map((mapping: any) => mapping.sourceDocument?.fiscalYear)
            .filter(Boolean)
            .join(',')
            .slice(0, 128) || null,
      };
      let result: any = {
        ...ledger,
        ...data,
        id: ledger?.id ?? decision.id,
        createdAt: ledger?.createdAt ?? decision.createdAt,
        updatedAt: ledger?.updatedAt ?? decision.createdAt,
        relevantPeriodStart: ledger?.relevantPeriodStart ?? null,
        relevantPeriodEnd: ledger?.relevantPeriodEnd ?? null,
        expiryDate: ledger?.expiryDate ?? null,
        reopeningReason: ledger?.reopeningReason ?? null,
        reopeningReviewId: ledger?.reopeningReviewId ?? null,
      };
      if (persist) {
        if (ledger) {
          // Original dependency fingerprint/evidence never change during a refresh.
          const {
            originalEvidence: _evidence,
            priorDependencyFingerprint: _originalFingerprint,
            ...currentData
          } = data;
          result = await tx.researchPortfolioContinuityLedger.update({
            where: { id: ledger.id, tenantId: ctx.tenantId, portfolioId },
            data: currentData,
          });
        } else
          result = await tx.researchPortfolioContinuityLedger.create({
            data: { ...data, id: decision.id },
          });
      }
      counts[status]++;
      items.push({ ...this.continuityLedgerDto(result), persisted: persist || Boolean(ledger) });
    }
    return {
      items,
      counts,
      knownAtSupport: 'current_projection_with_temporal_identity',
      limitations: [
        'Canonical facts and source qualification are current projections; historical knownAt applies only to identity mapping selection.',
        'Archive retention and corpus qualification require separate evidence.',
      ],
    };
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

        const replay = await this.replay(
          tx,
          ctx,
          input.idempotencyKey,
          operationFingerprint,
          portfolioId,
        );
        if (replay) return replay;

        let ledgers = await tx.researchPortfolioContinuityLedger.findMany({
          where: {
            id: { in: continuityIds },
            tenantId: ctx.tenantId,
            portfolioId,
          },
        });

        const existingIds = new Set(ledgers.map((ledger) => ledger.id));
        const decisionIds = [
          ...new Set([
            ...ledgers.flatMap((ledger) =>
              ledger.currentDecisionId ? [ledger.currentDecisionId] : [],
            ),
            ...continuityIds.filter((id) => !existingIds.has(id)),
          ]),
        ];
        if (decisionIds.length) {
          await this.projectAnnualReview(
            tx,
            ctx,
            portfolioId,
            { ...this.continuityScope(), decisionIds },
            true,
          );
          ledgers = await tx.researchPortfolioContinuityLedger.findMany({
            where: { id: { in: continuityIds }, tenantId: ctx.tenantId, portfolioId },
          });
        }
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

          const decision =
            ledger.currentDecisionId || ledger.priorDecisionId
              ? await tx.researchPortfolioDecision.findFirst({
                  where: {
                    tenantId: ctx.tenantId,
                    id: ledger.currentDecisionId ?? ledger.priorDecisionId!,
                  },
                })
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
              reason:
                input.reason?.trim() || `Annual continuity review reopened due to ${ledger.status}`,
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

  private async isPortfolioArchived(
    tx: Tx,
    tenantId: string,
    portfolioId: string,
  ): Promise<boolean> {
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
    portfolioId: string,
    legacyFingerprint?: (event: any) => Promise<string | null>,
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
    if (existing.actorUserId !== ctx.userId || existing.portfolioId !== portfolioId) {
      throw new ConflictException('Idempotency key was already used by another actor or portfolio');
    }
    if (existing.payloadFingerprint !== operationFingerprint) {
      const legacy = legacyFingerprint ? await legacyFingerprint(existing) : null;
      if (!legacy || existing.payloadFingerprint !== legacy) {
        throw new ConflictException('Idempotency key was already used for a different operation');
      }
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

  private async getPortfolioRevision(
    tx: Tx,
    tenantId: string,
    portfolioId: string,
  ): Promise<number> {
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

    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx): Promise<ResearchPortfolioReviewMutationReceiptDto> => {
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
      },
    );
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
