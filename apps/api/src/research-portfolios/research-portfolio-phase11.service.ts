import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateResearchPortfolioBookmarkDto,
  CreateResearchPortfolioReviewNoteDto,
  ResearchPortfolioBookmarkDto,
  ResearchPortfolioFitDto,
  ResearchPortfolioOperationDto,
  ResearchPortfolioOperationKind,
  ResearchPortfolioReviewNoteDto,
  ResearchPortfolioTourStateDto,
  ResearchPortfolioWatchConversionPreviewDto,
  ResearchPortfolioWatchConversionResultDto,
  TenantContext,
  UpdateResearchPortfolioBookmarkDto,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { loadAuthorizedResearchPortfolio as loadAuthorized } from './research-portfolio-access.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asIso(date: Date): string {
  return date.toISOString();
}

/**
 * Phase 11 supplementary services: bookmarks, review notes, fit, operations,
 * watch-conversion, and tour state. Each method reauthorizes through the
 * shared loadAuthorized helper.
 */
@Injectable()
export class ResearchPortfolioPhase11Service {
  constructor(private readonly prisma: PrismaService) {}

  // --- Bookmarks ---

  async listBookmarks(ctx: TenantContext, portfolioId: string): Promise<readonly ResearchPortfolioBookmarkDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const rows = await tx.researchPortfolioBookmark.findMany({
        where: { tenantId: ctx.tenantId, portfolioId, userId: ctx.userId },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((row: any) => this.bookmarkDto(row));
    });
  }

  async createBookmark(
    ctx: TenantContext,
    portfolioId: string,
    dto: CreateResearchPortfolioBookmarkDto,
  ): Promise<ResearchPortfolioBookmarkDto> {
    if (!dto.targetKind || !dto.targetId) throw new BadRequestException('Bookmark requires targetKind and targetId');
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const existing = await tx.researchPortfolioBookmark.findFirst({
        where: { tenantId: ctx.tenantId, portfolioId, userId: ctx.userId, targetKind: dto.targetKind, targetId: dto.targetId },
      });
      if (existing) return this.bookmarkDto(existing);
      const row = await tx.researchPortfolioBookmark.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          userId: ctx.userId,
          targetKind: dto.targetKind,
          targetId: dto.targetId,
          label: dto.label?.trim() || null,
          note: dto.note?.trim() || null,
        },
      });
      return this.bookmarkDto(row);
    });
  }

  async updateBookmark(
    ctx: TenantContext,
    portfolioId: string,
    bookmarkId: string,
    dto: UpdateResearchPortfolioBookmarkDto,
  ): Promise<ResearchPortfolioBookmarkDto> {
    if (!UUID.test(bookmarkId)) throw new NotFoundException('Bookmark not found');
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const existing = await tx.researchPortfolioBookmark.findFirst({
        where: { id: bookmarkId, tenantId: ctx.tenantId, portfolioId, userId: ctx.userId },
      });
      if (!existing) throw new NotFoundException('Bookmark not found');
      const row = await tx.researchPortfolioBookmark.update({
        where: { id: bookmarkId },
        data: {
          ...(dto.label !== undefined ? { label: dto.label?.trim() || null } : {}),
          ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
        },
      });
      return this.bookmarkDto(row);
    });
  }

  async deleteBookmark(ctx: TenantContext, portfolioId: string, bookmarkId: string): Promise<void> {
    if (!UUID.test(bookmarkId)) throw new NotFoundException('Bookmark not found');
    await this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const existing = await tx.researchPortfolioBookmark.findFirst({
        where: { id: bookmarkId, tenantId: ctx.tenantId, portfolioId, userId: ctx.userId },
      });
      if (!existing) throw new NotFoundException('Bookmark not found');
      await tx.researchPortfolioBookmark.delete({ where: { id: bookmarkId } });
    });
  }

  // --- Review notes ---

  async addReviewNote(
    ctx: TenantContext,
    portfolioId: string,
    reviewId: string,
    dto: CreateResearchPortfolioReviewNoteDto,
  ): Promise<ResearchPortfolioReviewNoteDto> {
    if (!UUID.test(reviewId)) throw new NotFoundException('Review not found');
    const body = dto.body?.trim();
    if (!body) throw new BadRequestException('Note body must not be empty');
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const review = await tx.researchPortfolioReview.findFirst({
        where: { tenantId: ctx.tenantId, id: reviewId, portfolioId },
      });
      if (!review) throw new NotFoundException('Review not found');
      if (review.revision !== dto.expectedRevision) {
        throw new ConflictException('Review revision mismatch');
      }
      const note = await tx.researchPortfolioReviewNote.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          reviewId,
          authorUserId: ctx.userId,
          body,
        },
      });
      return { id: note.id, reviewId: note.reviewId, authorUserId: note.authorUserId, body: note.body, createdAt: asIso(note.createdAt) };
    });
  }

  // --- Fit ---

  async getFit(ctx: TenantContext, portfolioId: string): Promise<ResearchPortfolioFitDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const portfolio = await tx.researchPortfolio.findFirst({
        where: { tenantId: ctx.tenantId, id: portfolioId },
        include: { clientLinks: true },
      });
      if (!portfolio) throw new NotFoundException('Portfolio not found');
      // Fit evaluation returns the linked clients with their current rule match state.
      // Full implementation requires the rule engine; return placeholder structure.
      const clientFits = portfolio.clientLinks.map((link: any) => ({
        portfolioId,
        clientId: link.clientId,
        clientName: link.clientId, // resolved at display time
        fitScore: null,
        ruleMatches: [],
        refreshedAt: null,
      }));
      return { portfolioId, clientFits, calculatedAt: new Date().toISOString() };
    });
  }

  async refreshFit(ctx: TenantContext, portfolioId: string): Promise<ResearchPortfolioFitDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'editor');
      // Refreshing recalculates fit against current rules. Placeholder until rule engine is qualified.
      return this.getFit(ctx, portfolioId);
    });
  }

  // --- Watch-conversion ---

  async previewWatchConversion(ctx: TenantContext, portfolioId: string): Promise<ResearchPortfolioWatchConversionPreviewDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'editor');
      const subscriptions = await tx.researchPortfolioSubscription.findMany({
        where: { tenantId: ctx.tenantId, portfolioId },
      });
      return {
        portfolioId,
        legacyWatches: 0,
        convertibleWatches: 0,
        alreadyConverted: subscriptions.length,
        previewItems: [],
      };
    });
  }

  async applyWatchConversion(ctx: TenantContext, portfolioId: string): Promise<ResearchPortfolioWatchConversionResultDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'editor');
      return { portfolioId, convertedCount: 0, skippedCount: 0 };
    });
  }

  // --- Operations ---

  async getOperation(ctx: TenantContext, portfolioId: string, operationId: string): Promise<ResearchPortfolioOperationDto> {
    if (!UUID.test(operationId)) throw new NotFoundException('Operation not found');
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      // Operations are a union view of import jobs, recompute jobs, output jobs, and snapshots.
      const importJob = await tx.researchPortfolioImportJob.findFirst({
        where: { tenantId: ctx.tenantId, portfolioId, id: operationId },
      });
      if (importJob) return this.operationDto(importJob, 'import');

      const recomputeJob = await tx.researchPortfolioRecomputeJob.findFirst({
        where: { tenantId: ctx.tenantId, portfolioId, id: operationId },
      });
      if (recomputeJob) return this.operationDto(recomputeJob, 'recompute');

      const outputJob = await tx.researchPortfolioOutputJob.findFirst({
        where: { tenantId: ctx.tenantId, portfolioId, id: operationId },
      });
      if (outputJob) return this.operationDto(outputJob, 'output');

      const snapshot = await tx.researchPortfolioSnapshot.findFirst({
        where: { tenantId: ctx.tenantId, portfolioId, id: operationId },
      });
      if (snapshot) {
        return {
          id: snapshot.id,
          portfolioId: snapshot.portfolioId,
          kind: 'snapshot' as const,
          status: 'completed' as const,
          actorUserId: snapshot.createdByUserId,
          label: snapshot.name,
          startedAt: asIso(snapshot.createdAt),
          completedAt: asIso(snapshot.createdAt),
          lastErrorCode: null,
          lastError: null,
          retryCount: 0,
          createdAt: asIso(snapshot.createdAt),
          updatedAt: asIso(snapshot.createdAt),
        };
      }
      throw new NotFoundException('Operation not found');
    });
  }

  async reconcileOperation(ctx: TenantContext, portfolioId: string, operationId: string): Promise<ResearchPortfolioOperationDto> {
    if (!UUID.test(operationId)) throw new NotFoundException('Operation not found');
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'editor');
      // Attempt to reconcile the operation. For now, just return current status.
      return this.getOperation(ctx, portfolioId, operationId);
    });
  }

  // --- Tour state ---

  async getTourState(ctx: TenantContext, tourVersion: string): Promise<ResearchPortfolioTourStateDto> {
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      return tx.researchPortfolioTourState.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, tourVersion },
      });
    });
    if (!row) return { tourVersion, status: 'active', completedAt: null };
    return { tourVersion: row.tourVersion, status: row.status as 'active' | 'dismissed' | 'completed', completedAt: row.completedAt ? asIso(row.completedAt) : null };
  }

  async updateTourState(
    ctx: TenantContext,
    tourVersion: string,
    status: 'dismissed' | 'completed',
  ): Promise<ResearchPortfolioTourStateDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      const existing = await tx.researchPortfolioTourState.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, tourVersion },
      });
      const completedAt = status === 'completed' ? new Date() : null;
      if (existing) {
        const row = await tx.researchPortfolioTourState.update({
          where: { id: existing.id },
          data: { status, completedAt },
        });
        return { tourVersion: row.tourVersion, status: row.status as 'dismissed' | 'completed', completedAt: row.completedAt ? asIso(row.completedAt) : null };
      }
      const row = await tx.researchPortfolioTourState.create({
        data: { tenantId: ctx.tenantId, userId: ctx.userId, tourVersion, status, completedAt },
      });
      return { tourVersion: row.tourVersion, status: row.status as 'dismissed' | 'completed', completedAt: row.completedAt ? asIso(row.completedAt) : null };
    });
  }

  // --- Helpers ---

  private bookmarkDto(row: any): ResearchPortfolioBookmarkDto {
    return {
      id: row.id,
      portfolioId: row.portfolioId,
      userId: row.userId,
      targetKind: row.targetKind,
      targetId: row.targetId,
      label: row.label,
      note: row.note,
      createdAt: asIso(row.createdAt),
      updatedAt: asIso(row.updatedAt),
    };
  }

  private operationDto(row: any, kind: ResearchPortfolioOperationKind): ResearchPortfolioOperationDto {
    return {
      id: row.id,
      portfolioId: row.portfolioId,
      kind,
      status: row.status ?? 'completed',
      actorUserId: row.actorUserId ?? row.createdByUserId ?? '',
      label: row.label ?? row.fileName ?? null,
      startedAt: row.startedAt ? asIso(row.startedAt) : null,
      completedAt: row.completedAt ? asIso(row.completedAt) : null,
      lastErrorCode: row.lastErrorCode ?? null,
      lastError: row.lastError ?? null,
      retryCount: row.retryCount ?? row.attemptNumber ?? 0,
      createdAt: asIso(row.createdAt),
      updatedAt: asIso(row.updatedAt),
    };
  }
}
