import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isTenantAdmin, type RiskTier, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { OutreachDraftService } from '../engagement/outreach-draft.service.js';
import { OUTREACH_DRAFT_VERSION_SUBJECT_TYPE } from '../engagement/outreach-draft.types.js';
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
    // Phase 0 3.f1 - exported by EngagementModule. Injected in THIS direction
    // because ReviewsModule already imports EngagementModule; importing
    // ReviewsModule from EngagementModule would be a module cycle.
    private readonly outreachDrafts: OutreachDraftService,
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

    // Phase 0 3.f1 - a held DRAFT VERSION is released ATOMICALLY: the version
    // state and the review decision commit in ONE transaction. Two separate
    // transactions could leave a version released with no recorded decision, or
    // a recorded approval with the version still held; either half-state is a
    // send-gate defect.
    if (isOutreachDraftVersionReview(row)) {
      const version = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const updated = await this.outreachDrafts.decideWithinTx(
          tx,
          ctx.tenantId,
          row.subjectId!,
          id,
          'approved',
        );
        await this.stampWithinTx(tx, ctx, id, 'approved');
        return updated;
      });
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

  /** Reject = deliverable stays unfiled; decision stamped. */
  async reject(ctx: TenantContext, id: string) {
    const row = await this.getPendingOrThrow(ctx.tenantId, id);
    this.assertMayDecide(ctx, row);

    // Same atomicity requirement as approve. A rejected version KEEPS its audit
    // hold - the finding was never resolved - so it stays non-sendable and the
    // author must create a new version to proceed.
    if (isOutreachDraftVersionReview(row)) {
      await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        await this.outreachDrafts.decideWithinTx(tx, ctx.tenantId, row.subjectId!, id, 'rejected');
        await this.stampWithinTx(tx, ctx, id, 'rejected');
      });
      return { ok: true, id };
    }

    await this.stamp(ctx, id, 'rejected');
    return { ok: true, id };
  }

  /**
   * Protected detail view for ONE review (3.f2).
   *
   * Readable by a tenant admin, the ASSIGNED reviewer, or the requester (who may
   * view but - per assertMayDecide - not decide). A held outreach draft returns
   * its real subject/body HERE rather than duplicating it into the review
   * payload, so the content lives in exactly one place behind one access check.
   *
   * Never returns OAuth/provider tokens, raw LLM responses, or unrelated context
   * packet bodies.
   */
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
    // Whether THIS caller may decide, so the UI can render a view-only state for
    // a requester instead of offering buttons that would 403.
    const mayDecide =
      isTenantAdmin(ctx.role) || (!!row.assignedTo && row.assignedTo === ctx.userId);

    if (isOutreachDraftVersionReview(row) && row.subjectId) {
      const version = await this.outreachDrafts.getVersionForReviewerUnchecked(
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
    if (row.surface === 'outreach') {
      // LEGACY, HISTORICAL ROWS ONLY (subjectType='outreach-draft', content-keyed).
      // Phase 0 versioned holds never reach release(): approve() handles
      // 'outreach-draft-version' atomically before this point. For an old row
      // there is nothing to file - flipping status to 'approved' is what the
      // flag-off content-keyed gate in sendBatchEmails checks.
      return { sendUnblocked: true, legacyContentKeyedHold: true };
    }
    return null;
  }

  private async stamp(
    ctx: TenantContext,
    id: string,
    status: 'approved' | 'rejected',
  ): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, (tx) => this.stampWithinTx(tx, ctx, id, status));
  }

  /** Stamp inside a caller-owned transaction (Phase 0 atomic outreach decisions). */
  private async stampWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    id: string,
    status: 'approved' | 'rejected',
  ): Promise<void> {
    await tx.reviewRequest.update({
      where: { id },
      data: { status, decidedBy: ctx.userId, decidedAt: new Date() },
    });
  }

  private async getPendingOrThrow(tenantId: string, id: string) {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.reviewRequest.findFirst({
        where: { id, tenantId, status: 'pending' },
        select: {
          id: true,
          surface: true,
          // Phase 0: the decision path branches on subjectType/subjectId, so both
          // must be loaded here - a versioned hold must never fall through to the
          // generic release() for want of a selected column.
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

/**
 * Is this review governing a Phase 0 IMMUTABLE DRAFT VERSION?
 *
 * Requires surface + subjectType + a present subjectId together: a row missing
 * its subjectId falls through to the legacy path rather than being treated as a
 * versioned hold with nothing to release.
 */
function isOutreachDraftVersionReview(row: {
  surface: string;
  subjectType?: string | null;
  subjectId?: string | null;
}): boolean {
  return (
    row.surface === 'outreach' &&
    row.subjectType === OUTREACH_DRAFT_VERSION_SUBJECT_TYPE &&
    !!row.subjectId
  );
}
