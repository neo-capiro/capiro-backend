import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { TenantContext, ResearchPortfolioAnalyticsDto } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';
import {
  authorizeResearchPortfolioArtifact,
  authorizeResearchPortfolioConversation,
} from './research-portfolio-artifact-authority.js';
import { loadAuthorizedResearchPortfolio } from './research-portfolio-access.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface PrepareResearchPortfolioInstitutionalInput {
  conversationId: string;
  operationKey: string;
  confirmed: true;
  kind: 'brief' | 'meeting';
  meetingId?: string;
  selectedReviewIds?: string[];
}
export interface ResearchPortfolioInstitutionalReceipt {
  artifactId: string;
  conversationId: string;
  meetingPrepId: string | null;
  taskIds: string[];
  sourceLineage: Record<string, unknown>;
  reviewStatus: 'unreviewed_draft';
  replayed: boolean;
}
/** Provider-free, owner-private editable drafts. Server captures current public
 * projection and exact sources; user edits never change source qualification. */
@Injectable()
export class ResearchPortfolioInstitutionalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: ResearchPortfolioAnalyticsService,
    private readonly engagement: EngagementService,
  ) {}
  async prepare(
    ctx: TenantContext,
    input: PrepareResearchPortfolioInstitutionalInput,
  ): Promise<ResearchPortfolioInstitutionalReceipt> {
    if (
      !input ||
      Object.keys(input).some(
        (key) =>
          ![
            'conversationId',
            'operationKey',
            'confirmed',
            'kind',
            'meetingId',
            'selectedReviewIds',
          ].includes(key),
      )
    )
      throw new BadRequestException('Unknown institutional preparation input');
    if (
      input.confirmed !== true ||
      !['brief', 'meeting'].includes(input.kind) ||
      !UUID.test(input.conversationId) ||
      typeof input.operationKey !== 'string' ||
      !input.operationKey.trim() ||
      input.operationKey.length > 128
    )
      throw new BadRequestException(
        'Explicit confirmation, conversation and original operationKey are required',
      );
    if (input.meetingId && (!UUID.test(input.meetingId) || input.kind !== 'meeting'))
      throw new BadRequestException('meetingId requires meeting preparation');
    const reviewIds = input.selectedReviewIds ?? [];
    if (
      !Array.isArray(reviewIds) ||
      reviewIds.length > 20 ||
      new Set(reviewIds).size !== reviewIds.length ||
      reviewIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
      (input.kind === 'brief' && reviewIds.length)
    )
      throw new BadRequestException('Choose up to 20 distinct owned reviews for meeting tasks');
    const selection = [...reviewIds].sort(),
      requestFingerprint = digest({
        conversationId: input.conversationId,
        kind: input.kind,
        meetingId: input.meetingId ?? null,
        selectedReviewIds: selection,
      });
    const kind = 'research_portfolio_' + input.kind;
    const read = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const { scope } = await this.authority(tx, ctx, input.conversationId);
      const replay = await this.replay(tx, ctx, input, kind, requestFingerprint);
      if (replay) return { scope, replay };
      return { scope, replay: null };
    });
    if (read.replay) return read.replay;
    const projection = await this.analytics.analytics(ctx, read.scope.researchPortfolioId);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const { scope, portfolio } = await this.authority(tx, ctx, input.conversationId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + '|' + ctx.userId + '|rp-institutional|' + input.operationKey},0))`;
      const replay = await this.replay(tx, ctx, input, kind, requestFingerprint);
      if (replay) return replay;
      if (portfolio.lifecycle !== 'active')
        throw new ConflictException('Archived Research Portfolio is read only');
      if (
        scope.researchPortfolioId !== read.scope.researchPortfolioId ||
        portfolio.revision !== projection.portfolioRevision
      )
        throw new ConflictException('Research Portfolio changed; reload current preparation');
      for (const reviewId of selection)
        await tx.$executeRaw`SELECT id FROM research_portfolio_reviews WHERE tenant_id=${ctx.tenantId}::uuid AND portfolio_id=${portfolio.id}::uuid AND id=${reviewId}::uuid FOR SHARE`;
      const reviews = selection.length
        ? await tx.researchPortfolioReview.findMany({
            where: {
              tenantId: ctx.tenantId,
              portfolioId: portfolio.id,
              id: { in: selection },
              assigneeUserId: ctx.userId,
              status: { in: ['open', 'assigned'] },
            },
            orderBy: { id: 'asc' },
          })
        : [];
      if (reviews.length !== selection.length)
        throw new NotFoundException('One or more selected owned reviews are unavailable');
      if (input.meetingId)
        await this.engagement.assertOwnedResearchPortfolioMeeting(tx, ctx, input.meetingId);
      const capturedAt = new Date().toISOString();
      const sourceLineage = {
        schemaVersion: 'research_portfolio_institutional_sources_v1',
        portfolioId: portfolio.id,
        portfolioRevision: portfolio.revision,
        calculationVersion: projection.calculationVersion,
        capturedAt,
        projectionReadAt: projection.readAt,
        observedAt: projection.observedAt,
        projectionDigest: digest(projection),
        sourceRevisionIds: [
          ...new Set(projection.contributions.flatMap((entry) => entry.sourceRevisionIds)),
        ].sort(),
        projection,
        selectedReviews: reviews.map((review) => ({
          id: review.id,
          revision: review.revision,
          targetKind: review.targetKind,
          targetId: review.targetId,
          evidenceFor: review.evidenceFor,
          evidenceAgainst: review.evidenceAgainst,
        })),
      };
      const bodyText = this.render(input.kind, portfolio, projection, reviews, sourceLineage);
      if (Buffer.byteLength(bodyText, 'utf8') > 500000)
        throw new PayloadTooLargeException('Preparation exceeds the editable draft limit');
      const artifact = await tx.clioArtifact.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: null,
          conversationId: input.conversationId,
          title: (portfolio.name + ' ' + input.kind + ' draft').slice(0, 255),
          kind,
          contentType: 'text/markdown',
          bodyText,
          metadata: JSON.parse(
            JSON.stringify({
              schemaVersion: 'research_portfolio_institutional_v1',
              researchPortfolioScope: scope,
              sourceLineage,
              operationKey: input.operationKey,
              requestFingerprint,
              meetingId: input.meetingId ?? null,
              reviewStatus: 'unreviewed_draft',
              meetingPrepId: null,
              taskIds: [],
            }),
          ),
        },
      });
      const taskIds: string[] = [];
      for (const review of reviews) {
        const task = await this.engagement.createOwnedResearchPortfolioTask(tx, ctx, {
          artifactId: artifact.id,
          reviewId: review.id,
          title: 'Review evidence: ' + review.targetKind + ' ' + review.targetId,
          description: review.reason + '\nCaptured source appendix: ' + artifact.id,
        });
        taskIds.push(task.id);
      }
      const prep = input.meetingId
        ? await this.engagement.createOwnedResearchPortfolioMeetingPrep(tx, ctx, {
            meetingId: input.meetingId,
            artifactId: artifact.id,
            summary: bodyText,
            agenda: [
              'Review captured portfolio evidence',
              'Review source coverage and limitations',
              'Discuss explicitly selected review actions',
            ],
            followUps: reviews.map(
              (review, index) =>
                'Task ' + taskIds[index] + ': ' + review.targetKind + ' ' + review.targetId,
            ),
          })
        : null;
      const completed = await tx.clioArtifact.update({
        where: { id: artifact.id },
        data: {
          metadata: {
            ...(artifact.metadata as Record<string, unknown>),
            meetingPrepId: prep?.id ?? null,
            taskIds,
          },
        },
      });
      return this.receipt(completed, false);
    });
  }
  private async authority(tx: any, ctx: TenantContext, conversationId: string) {
    await tx.$executeRaw`SELECT id FROM clio_conversations WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND id=${conversationId}::uuid FOR SHARE`;
    const conversation = await tx.clioConversation.findFirst({
      where: { id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId, archivedAt: null },
    });
    if (!conversation) throw new NotFoundException('Meri conversation not found');
    const scope = await authorizeResearchPortfolioConversation(tx, ctx, conversation);
    if (!scope) throw new BadRequestException('A Research Portfolio conversation is required');
    const portfolio = await loadAuthorizedResearchPortfolio(
      tx,
      ctx,
      scope.researchPortfolioId,
      'viewer',
    );
    return { scope, portfolio };
  }
  private async replay(
    tx: any,
    ctx: TenantContext,
    input: PrepareResearchPortfolioInstitutionalInput,
    kind: string,
    fingerprint: string,
  ) {
    const artifact = await tx.clioArtifact.findFirst({
      where: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        parentArtifactId: null,
        kind: { in: ['research_portfolio_brief', 'research_portfolio_meeting'] },
        metadata: { path: ['operationKey'], equals: input.operationKey },
      },
    });
    if (!artifact) return null;
    await authorizeResearchPortfolioArtifact(tx, ctx, artifact);
    const metadata = artifact.metadata as Record<string, unknown>;
    if (
      artifact.kind !== kind ||
      artifact.conversationId !== input.conversationId ||
      metadata.requestFingerprint !== fingerprint
    )
      throw new ConflictException(
        'This institutional operation key was used for different content',
      );
    if (input.meetingId)
      await this.engagement.assertOwnedResearchPortfolioMeeting(tx, ctx, input.meetingId);
    return this.receipt(artifact, true);
  }
  private receipt(artifact: any, replayed: boolean): ResearchPortfolioInstitutionalReceipt {
    const metadata = artifact.metadata;
    return {
      artifactId: artifact.id,
      conversationId: artifact.conversationId,
      meetingPrepId: metadata.meetingPrepId ?? null,
      taskIds: [...metadata.taskIds],
      sourceLineage: metadata.sourceLineage,
      reviewStatus: 'unreviewed_draft',
      replayed,
    };
  }
  private render(
    kind: string,
    portfolio: any,
    projection: ResearchPortfolioAnalyticsDto,
    reviews: any[],
    lineage: Record<string, unknown>,
  ) {
    const lines = [
      '# ' + portfolio.name + ' ' + kind + ' draft',
      '',
      'Review status: unreviewed draft',
      'Purpose: ' + (portfolio.purpose ?? 'Not specified'),
      'Captured portfolio revision: ' + portfolio.revision,
      'Evidence availability: ' + projection.availability,
      '',
      '## Compatible totals',
      ...projection.totals.map((total) => '- ' + JSON.stringify(total.basis) + ': ' + total.value),
      '',
      '## Coverage and limitations',
      ...projection.limitations.map((text) => '- ' + text),
      JSON.stringify(projection.coverage),
      '',
      '## Retained financial observations',
      ...projection.contributions.map(
        (entry) =>
          '- ' +
          (entry.label ?? entry.targetId) +
          ': ' +
          (entry.value ?? 'unavailable') +
          '; ' +
          entry.disposition +
          '; source ' +
          (entry.sourceDisposition ?? 'unspecified') +
          '; ' +
          entry.reason,
      ),
      '',
      '## Explicit review actions',
      ...reviews.map(
        (review) => '- ' + review.targetKind + ' ' + review.targetId + ': ' + review.reason,
      ),
      '',
      '## Exact source appendix',
      '```json',
      JSON.stringify(lineage, null, 2),
      '```',
    ];
    return lines.join('\n');
  }
}
