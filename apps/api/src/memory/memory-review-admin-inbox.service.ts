import { withMemoryConversationRetention } from './conversation-serving/transaction.js';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { isMemoryReviewAdminRole } from './memory-review-admin-policy.js';
import {
  memoryReviewNextAction,
  type MemoryReviewInboxView,
} from './memory-review-inbox.helpers.js';
import {
  MemoryReviewInboxService,
  type MemoryReviewDetail,
  type MemoryReviewInboxItem,
  type MemoryReviewInboxPage,
  type MemoryReviewInboxSummary,
} from './memory-review-inbox.service.js';

/**
 * Admin policy adapter for the canonical Review Inbox.
 *
 * The base service remains the only tenant/body/notification read model. This
 * adapter only broadens decision capabilities after the base service has
 * already established active membership, tenant scope, participant/admin
 * visibility, ethical-wall access, and client status. Non-admin callers use the
 * byte-identical base behavior.
 */
@Injectable()
export class MemoryReviewAdminInboxService extends MemoryReviewInboxService {
  constructor(
    private readonly adminPrisma: PrismaService,
    private readonly adminAuthorization: MemoryAuthorizationService,
  ) {
    super(adminPrisma, adminAuthorization);
  }

  override async list(
    ctx: TenantContext,
    input: { view?: unknown; cursor?: unknown; limit?: unknown },
  ): Promise<MemoryReviewInboxPage> {
    if (!isMemoryReviewAdminRole(ctx.role)) return super.list(ctx, input);

    const requestedView = normalizeView(input.view);
    const baseView: MemoryReviewInboxView =
      requestedView === 'needs_my_review' ? 'all_pending' : requestedView;
    const page = await super.list(ctx, { ...input, view: baseView });
    const items = await this.withAdminCapabilities(ctx, page.items);
    return {
      ...page,
      view: requestedView,
      items:
        requestedView === 'needs_my_review'
          ? items.filter(
              (item) =>
                item.status === 'pending' &&
                (item.capabilities.approve || item.capabilities.reject),
            )
          : requestedView === 'blocked'
            ? items.filter((item) => Boolean(item.blockedReason))
            : items,
    };
  }

  override async summary(ctx: TenantContext): Promise<MemoryReviewInboxSummary> {
    if (!isMemoryReviewAdminRole(ctx.role)) return super.summary(ctx);

    const pending = await this.collect(ctx, 'all_pending');
    const history = await this.collect(ctx, 'history');
    const enabled = pending.enabled && history.enabled;
    return {
      enabled,
      counts: {
        needsMyReview: enabled ? pending.needsMyReview : 0,
        submittedByMe: enabled ? pending.submittedByMe : 0,
        allPending: enabled ? pending.count : 0,
        blocked: enabled ? pending.blocked : 0,
        history: enabled ? history.count : 0,
      },
      truncated: false,
    };
  }

  override async detail(ctx: TenantContext, candidateId: string): Promise<MemoryReviewDetail> {
    const detail = await super.detail(ctx, candidateId);
    if (!isMemoryReviewAdminRole(ctx.role)) return detail;
    const [projected] = await this.withAdminCapabilities(ctx, [detail]);
    return projected ?? detail;
  }

  override async detailByReviewRequest(
    ctx: TenantContext,
    reviewRequestId: string,
  ): Promise<MemoryReviewDetail> {
    const detail = await super.detailByReviewRequest(ctx, reviewRequestId);
    if (!isMemoryReviewAdminRole(ctx.role)) return detail;
    const [projected] = await this.withAdminCapabilities(ctx, [detail]);
    return projected ?? detail;
  }

  private async collect(
    ctx: TenantContext,
    view: 'all_pending' | 'history',
  ): Promise<{
    enabled: boolean;
    count: number;
    needsMyReview: number;
    submittedByMe: number;
    blocked: number;
  }> {
    const counts = { count: 0, needsMyReview: 0, submittedByMe: 0, blocked: 0 };
    let cursor: string | null = null;
    let enabled = true;
    do {
      const page = await this.list(ctx, { view, cursor, limit: 50 });
      enabled = page.enabled;
      for (const item of page.items) {
        counts.count++;
        if (item.status === 'pending' && (item.capabilities.approve || item.capabilities.reject))
          counts.needsMyReview++;
        if (item.submittedBy.userId === ctx.userId) counts.submittedByMe++;
        if (item.blockedReason) counts.blocked++;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { enabled, ...counts };
  }

  private async withAdminCapabilities<T extends MemoryReviewInboxItem>(
    ctx: TenantContext,
    items: T[],
  ): Promise<T[]> {
    const pending = items.filter((item) => item.status === 'pending');
    if (pending.length === 0) return items;

    const projectedByCandidate = await withMemoryConversationRetention(
      this.adminPrisma,
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const projected = new Map<string, T>();
        for (const item of pending) {
          projected.set(item.candidateId, await this.projectInTx(tx, ctx, item));
        }
        return projected;
      },
    );
    return items.map((item) => projectedByCandidate.get(item.candidateId) ?? item);
  }

  private async projectInTx<T extends MemoryReviewInboxItem>(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    item: T,
  ): Promise<T> {
    const subject = await this.adminAuthorization.loadCandidateInTx(
      tx,
      ctx.tenantId,
      item.candidateId,
    );
    if (!subject) return item;

    const [approveDecision, reviewDecision] = await Promise.all([
      this.adminAuthorization.evaluateInTx(tx, ctx, subject, 'approve', {
        emitDenialMetrics: false,
      }),
      this.adminAuthorization.evaluateInTx(tx, ctx, subject, 'review', {
        emitDenialMetrics: false,
      }),
    ]);
    const approve = approveDecision.allowed;
    const review = reviewDecision.allowed;
    const capabilities = {
      ...item.capabilities,
      approve,
      reject: review,
      requestChanges: review,
      reassign: review,
    };
    return {
      ...item,
      blockedReason: approve || review ? null : item.blockedReason,
      nextAction: memoryReviewNextAction({
        status: item.status,
        viewerIsSubmitter: item.submittedBy.userId === ctx.userId,
        viewerIsAssignedReviewer: item.assignedReviewer?.userId === ctx.userId,
        viewerIsAdmin: true,
        canApprove: capabilities.approve,
        canReject: capabilities.reject,
        canRevise: capabilities.revise,
        canReassign: capabilities.reassign,
      }),
      capabilities,
    } as T;
  }
}

function normalizeView(value: unknown): MemoryReviewInboxView {
  return value === 'submitted_by_me' ||
    value === 'all_pending' ||
    value === 'blocked' ||
    value === 'history'
    ? value
    : 'needs_my_review';
}
