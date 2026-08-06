import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
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

const SUMMARY_LIMIT = 1_000;

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
    prisma: ConstructorParameters<typeof MemoryReviewInboxService>[0],
    private readonly adminAuthorization: MemoryAuthorizationService,
  ) {
    super(prisma, adminAuthorization);
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
    const items = await Promise.all(
      page.items.map((item) => this.withAdminCapabilities(ctx, item)),
    );
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
    return {
      enabled: pending.enabled,
      counts: {
        needsMyReview: pending.items.filter(
          (item) =>
            item.status === 'pending' &&
            (item.capabilities.approve || item.capabilities.reject),
        ).length,
        submittedByMe: pending.items.filter(
          (item) => item.submittedBy.userId === ctx.userId,
        ).length,
        allPending: pending.items.length,
        blocked: pending.items.filter((item) => Boolean(item.blockedReason)).length,
        history: history.items.length,
      },
      truncated: pending.truncated || history.truncated,
    };
  }

  override async detail(
    ctx: TenantContext,
    candidateId: string,
  ): Promise<MemoryReviewDetail> {
    const detail = await super.detail(ctx, candidateId);
    return isMemoryReviewAdminRole(ctx.role)
      ? this.withAdminCapabilities(ctx, detail)
      : detail;
  }

  override async detailByReviewRequest(
    ctx: TenantContext,
    reviewRequestId: string,
  ): Promise<MemoryReviewDetail> {
    const detail = await super.detailByReviewRequest(ctx, reviewRequestId);
    return isMemoryReviewAdminRole(ctx.role)
      ? this.withAdminCapabilities(ctx, detail)
      : detail;
  }

  private async collect(
    ctx: TenantContext,
    view: 'all_pending' | 'history',
  ): Promise<{
    enabled: boolean;
    items: MemoryReviewInboxItem[];
    truncated: boolean;
  }> {
    const items: MemoryReviewInboxItem[] = [];
    let cursor: string | null = null;
    let enabled = true;
    do {
      const page = await this.list(ctx, { view, cursor, limit: 50 });
      enabled = page.enabled;
      items.push(...page.items);
      cursor = page.nextCursor;
      if (items.length >= SUMMARY_LIMIT) {
        return { enabled, items: items.slice(0, SUMMARY_LIMIT), truncated: true };
      }
    } while (cursor);
    return { enabled, items, truncated: false };
  }

  private async withAdminCapabilities<T extends MemoryReviewInboxItem>(
    ctx: TenantContext,
    item: T,
  ): Promise<T> {
    if (item.status !== 'pending') return item;

    const [approve, review] = await Promise.all([
      this.allowed(ctx, item.candidateId, 'approve'),
      this.allowed(ctx, item.candidateId, 'review'),
    ]);
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
    };
  }

  private async allowed(
    ctx: TenantContext,
    candidateId: string,
    operation: 'approve' | 'review',
  ): Promise<boolean> {
    try {
      await this.adminAuthorization.requireCandidate(ctx, candidateId, operation, {
        emitDenialMetrics: false,
      });
      return true;
    } catch {
      return false;
    }
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
