import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isTenantAdmin, type RiskTier, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientDocumentWriterService } from '../client-documents/client-document-writer.service.js';
import {
  isExactOutreachVersionReview,
  OutreachReviewTransactionsService,
} from '../outreach-review/outreach-review-transactions.service.js';
import {
  DOCX_MIME,
  markdownToMemoDocInput,
  renderMemoDocx,
} from '../intelligence/alert-memo/alert-memo-docx.js';

export type ReviewSurface = 'alert-memo' | 'district-brief' | 'research' | 'outreach';

export interface CreateReviewInput {
  riskTier: RiskTier;
  surface: ReviewSurface;
  subjectType: string;
  subjectId?: string | null;
  clientId?: string | null;
  title: string;
  reason: string;
  payload: Record<string, unknown>;
  requestedBy?: string | null;
}

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientDocuments: ClientDocumentWriterService,
    private readonly outreachReviews: OutreachReviewTransactionsService,
  ) {}

  async createSystem(tenantId: string, input: CreateReviewInput): Promise<string | null> {
    try {
      const row = await this.prisma.withTenant(tenantId, (tx) =>
        tx.reviewRequest.create({
          data: {
            tenantId,
            riskTier: input.riskTier,
            surface: input.surface,
            subjectType: input.subjectType,
            subjectId: input.subjectId ?? null,
            clientId: input.clientId ?? null,
            title: input.title.slice(0, 300),
            reason: input.reason,
            payload: input.payload as Prisma.InputJsonValue,
            requestedBy: input.requestedBy ?? null,
          },
          select: { id: true },
        }),
      );
      return row.id;
    } catch (error) {
      this.logger.warn(`review_request create failed (non-fatal): ${(error as Error).message}`);
      return null;
    }
  }

  async list(ctx: TenantContext, status?: string) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.reviewRequest.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(status ? { status } : {}),
          ...(isTenantAdmin(ctx.role)
            ? {}
            : { OR: [{ requestedBy: ctx.userId }, { assignedTo: ctx.userId }] }),
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          riskTier: true,
          surface: true,
          subjectType: true,
          subjectId: true,
          clientId: true,
          title: true,
          reason: true,
          status: true,
          requestedBy: true,
          assignedTo: true,
          decidedBy: true,
          decidedAt: true,
          createdAt: true,
        },
      }),
    );
  }

  async assign(ctx: TenantContext, id: string, assigneeUserId: string) {
    await this.getPendingOrThrow(ctx.tenantId, id);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.reviewRequest.update({
        where: { id },
        data: { assignedTo: assigneeUserId },
        select: { id: true, assignedTo: true, status: true },
      }),
    );
  }

  async approve(ctx: TenantContext, id: string) {
    const row = await this.getPendingOrThrow(ctx.tenantId, id);
    this.assertMayDecide(ctx, row);

    if (isExactOutreachVersionReview(row)) {
      const version = await this.outreachReviews.decide(ctx, id, 'approved');
      return {
        ok: true,
        id,
        released: {
          draftVersionId: version.id,
          version: version.version,
          auditStatus: version.auditStatus,
          approvalStatus: version.approvalStatus,
          sendUnblocked: true,
        },
      };
    }

    const released = await this.release(ctx, row);
    await this.stamp(ctx, id, 'approved');
    return { ok: true, id, released };
  }

  async reject(ctx: TenantContext, id: string) {
    const row = await this.getPendingOrThrow(ctx.tenantId, id);
    this.assertMayDecide(ctx, row);

    if (isExactOutreachVersionReview(row)) {
      await this.outreachReviews.decide(ctx, id, 'rejected');
      return { ok: true, id };
    }

    await this.stamp(ctx, id, 'rejected');
    return { ok: true, id };
  }

  async detail(ctx: TenantContext, id: string) {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.reviewRequest.findFirst({
        where: { id, tenantId: ctx.tenantId },
        select: {
          id: true,
          riskTier: true,
          surface: true,
          subjectType: true,
          subjectId: true,
          clientId: true,
          title: true,
          reason: true,
          status: true,
          payload: true,
          requestedBy: true,
          assignedTo: true,
          decidedBy: true,
          decidedAt: true,
          createdAt: true,
        },
      }),
    );
    if (!row) throw new NotFoundException('No review with that id for this tenant.');
    if (
      !isTenantAdmin(ctx.role) &&
      row.assignedTo !== ctx.userId &&
      row.requestedBy !== ctx.userId
    ) {
      throw new ForbiddenException('You do not have access to this review.');
    }
    const mayDecide =
      isTenantAdmin(ctx.role) || (!!row.assignedTo && row.assignedTo === ctx.userId);

    if (isExactOutreachVersionReview(row)) {
      const version = await this.outreachReviews.getVersionForReviewerUnchecked(
        ctx.tenantId,
        row.subjectId,
      );
      return {
        ...row,
        mayDecide,
        draftVersion: version
          ? {
              id: version.id,
              artifactId: version.artifactId,
              outreachRecordId: version.outreachRecordId,
              version: version.version,
              generationKey: version.generationKey,
              recipientKey: version.recipientKey,
              audienceKind: version.audienceKind,
              subject: version.subject,
              body: version.body,
              contentHash: version.contentHash,
              generationStatus: version.generationStatus,
              auditStatus: version.auditStatus,
              approvalStatus: version.approvalStatus,
              auditDecision: version.auditDecision,
              auditChecks: version.auditChecks,
              provider: version.provider,
              model: version.model,
              promptSpecVersion: version.promptSpecVersion,
              sendable: version.sendable,
              createdAt: version.createdAt,
            }
          : null,
      };
    }
    return { ...row, mayDecide };
  }

  async hasOpenForSubject(
    tenantId: string,
    subjectType: string,
    subjectId: string,
  ): Promise<boolean> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.reviewRequest.findFirst({
        where: { tenantId, subjectType, subjectId, status: 'pending' },
        select: { id: true },
      }),
    );
    return !!row;
  }

  private assertMayDecide(ctx: TenantContext, row: { assignedTo: string | null }): void {
    if (isTenantAdmin(ctx.role)) return;
    if (row.assignedTo && row.assignedTo === ctx.userId) return;
    throw new ForbiddenException('Only an admin or the assigned reviewer may decide this review.');
  }

  private async release(
    ctx: TenantContext,
    row: { id: string; surface: string; clientId: string | null; payload: unknown },
  ): Promise<Record<string, unknown> | null> {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    if (row.surface === 'alert-memo' || row.surface === 'district-brief') {
      const markdown = String(payload.markdown ?? '');
      const title = String(payload.title ?? 'Memo');
      const clientName = String(payload.clientName ?? 'Client');
      const clientId = row.clientId ?? String(payload.clientId ?? '');
      if (!markdown || !clientId) {
        throw new NotFoundException('Held memo payload is missing markdown/client.');
      }
      const buffer = await renderMemoDocx(markdownToMemoDocInput(markdown, clientName, title));
      const fileName = `${title}.docx`.replace(/[\\/:*?"<>|]+/g, '-');
      const saved = await this.clientDocuments.createAttachmentFromBuffer(ctx, {
        clientId,
        fileName,
        contentType: DOCX_MIME,
        buffer,
        source: row.surface === 'district-brief' ? 'district_brief' : 'intel_memo',
      });
      return { attachmentId: saved.id, fileName: saved.fileName };
    }
    if (row.surface === 'research') {
      const artifactId = String(payload.artifactId ?? '');
      if (!artifactId) throw new NotFoundException('Held research payload is missing artifactId.');
      await this.prisma.withTenant(
        ctx.tenantId,
        (tx) =>
          tx.$executeRaw`
          UPDATE clio_artifacts
          SET metadata_jsonb = (metadata_jsonb - 'heldForReview')
              || jsonb_build_object('reviewClearedBy', ${ctx.userId}::text,
                                    'reviewClearedAt', to_jsonb(now()))
          WHERE id = ${artifactId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        `,
      );
      return { artifactId, heldForReview: false };
    }
    if (row.surface === 'outreach') {
      return { sendUnblocked: true, legacyContentKeyedHold: true };
    }
    return null;
  }

  private async stamp(
    ctx: TenantContext,
    id: string,
    status: 'approved' | 'rejected',
  ): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.reviewRequest.update({
        where: { id },
        data: { status, decidedBy: ctx.userId, decidedAt: new Date() },
      }),
    );
  }

  private async getPendingOrThrow(tenantId: string, id: string) {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.reviewRequest.findFirst({
        where: { id, tenantId, status: 'pending' },
        select: {
          id: true,
          surface: true,
          subjectType: true,
          subjectId: true,
          clientId: true,
          payload: true,
          assignedTo: true,
        },
      }),
    );
    if (!row) throw new NotFoundException('No pending review with that id for this tenant.');
    return row;
  }
}
