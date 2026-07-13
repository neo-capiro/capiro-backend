import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isTenantAdmin, type RiskTier, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import {
  DOCX_MIME,
  markdownToMemoDocInput,
  renderMemoDocx,
} from '../intelligence/alert-memo/alert-memo-docx.js';

export type ReviewSurface = 'alert-memo' | 'district-brief' | 'research';

export interface CreateReviewInput {
  riskTier: RiskTier;
  surface: ReviewSurface;
  subjectType: string;
  subjectId?: string | null;
  clientId?: string | null;
  title: string;
  reason: string;
  /** Everything approve needs to RELEASE the deliverable (see release()). */
  payload: Record<string, unknown>;
  requestedBy?: string | null;
}

/**
 * G4 — named-reviewer routing (blueprint §3.3). The memory_candidate lifecycle
 * generalized to HELD DELIVERABLES: the enforce flip made the grounding
 * auditor genuinely hold client-facing work, but a held item previously had
 * NO review/release path anywhere. Now every hold creates a pending
 * review_request; a user_admin assigns a named reviewer; approve RELEASES the
 * deliverable (files the held memo docx / clears a research artifact's
 * heldForReview); reject leaves it unfiled with decided stamps.
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
  ) {}

  /** System emitter for hold sites. Fail-open: a review-request failure must
   *  never break the generation that produced the hold. */
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
    } catch (e) {
      this.logger.warn(`review_request create failed (non-fatal): ${(e as Error).message}`);
      return null;
    }
  }

  /** user_admin sees the whole queue; everyone else their own requests + assignments. */
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
        // The reviewer queue never needs the full release payload; keep the
        // list light + avoid leaking held content into a broad listing.
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

  /** user_admin names the reviewer (may be themself). */
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

  /** Approve = RELEASE the deliverable, then stamp the decision. */
  async approve(ctx: TenantContext, id: string) {
    const row = await this.getPendingOrThrow(ctx.tenantId, id);
    this.assertMayDecide(ctx, row);
    const released = await this.release(ctx, row);
    await this.stamp(ctx, id, 'approved');
    return { ok: true, id, released };
  }

  /** Reject = deliverable stays unfiled; decision stamped. */
  async reject(ctx: TenantContext, id: string) {
    const row = await this.getPendingOrThrow(ctx.tenantId, id);
    this.assertMayDecide(ctx, row);
    await this.stamp(ctx, id, 'rejected');
    return { ok: true, id };
  }

  /** The saveEdited guard: is there an open review on this subject? */
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

  // ── internals ──────────────────────────────────────────────────────────────

  private assertMayDecide(ctx: TenantContext, row: { assignedTo: string | null }): void {
    // user_admin OR the NAMED reviewer. Deliberately excludes the requester —
    // the entire point of §3.3 is that held high-risk work gets a second set
    // of eyes, not a self-release.
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
      // File the held memo exactly like the skipped auto-file would have:
      // render docx from the stored markdown + attach to client Documents.
      const markdown = String(payload.markdown ?? '');
      const title = String(payload.title ?? 'Memo');
      const clientName = String(payload.clientName ?? 'Client');
      const clientId = row.clientId ?? String(payload.clientId ?? '');
      if (!markdown || !clientId) {
        throw new NotFoundException('Held memo payload is missing markdown/client.');
      }
      const buffer = await renderMemoDocx(markdownToMemoDocInput(markdown, clientName, title));
      const fileName = `${title}.docx`.replace(/[\\/:*?"<>|]+/g, '-');
      const saved = await this.engagement.createAttachmentFromBuffer(ctx, {
        clientId,
        fileName,
        contentType: DOCX_MIME,
        buffer,
        // Preserve each surface's own Documents provenance on release so an
        // approved brief is tagged the same as an auto-filed one would have been.
        source: row.surface === 'district-brief' ? 'district_brief' : 'intel_memo',
      });
      return { attachmentId: saved.id, fileName: saved.fileName };
    }
    if (row.surface === 'research') {
      // Clear heldForReview on the persisted report artifact.
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
