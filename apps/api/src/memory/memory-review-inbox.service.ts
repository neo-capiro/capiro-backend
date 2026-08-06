import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext, TenantRole } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  MemoryAuthorizationService,
  type GovernedMemorySubjectRow,
} from './memory-authorization.service.js';
import {
  decodeMemoryReviewCursor,
  encodeMemoryReviewCursor,
  memoryReviewBlockedReason,
  memoryReviewCandidateKindFromSource,
  memoryReviewNextAction,
  memoryReviewStatusFromDb,
  parseMemoryReviewInboxView,
  parseMemoryReviewPageSize,
  type MemoryReviewBlockedReason,
  type MemoryReviewInboxView,
  type MemoryReviewNextAction,
  type MemoryReviewPublicStatus,
} from './memory-review-inbox.helpers.js';
import { settingsMemoryReviewEnabledForTenant } from './memory-settings-review-readiness.service.js';
import type { MemorySection } from './memory.types.js';

const MAX_SUMMARY_SCAN = 1_000;
const MAX_NOTIFICATION_SCAN = 1_000;

interface ActiveViewer {
  tenantId: string;
  userId: string;
  role: TenantRole;
}

interface InboxRow {
  reviewRequestId: string;
  candidateId: string;
  clientId: string | null;
  clientName: string | null;
  clientStatus: string | null;
  title: string;
  workflowStatus: string;
  requestedBy: string;
  assignedTo: string | null;
  decidedBy: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  candidateKind: string | null;
  sourceKind: string;
  scope: string;
  revisionNumber: number;
  rootCandidateId: string;
  predecessorCandidateId: string | null;
  supersededById: string | null;
  assignedReviewerActive: boolean;
  assignedReviewerRole: string | null;
  submitterEmail: string;
  submitterFirstName: string | null;
  submitterLastName: string | null;
  reviewerEmail: string | null;
  reviewerFirstName: string | null;
  reviewerLastName: string | null;
  deciderEmail: string | null;
  deciderFirstName: string | null;
  deciderLastName: string | null;
}

interface DetailRow extends InboxRow {
  payload: unknown;
  feedbackReason: string;
}

interface TimelineRow {
  candidateId: string;
  reviewRequestId: string;
  revisionNumber: number;
  predecessorCandidateId: string | null;
  supersededById: string | null;
  title: string;
  workflowStatus: string;
  createdAt: Date;
  decidedAt: Date | null;
  requestedBy: string;
  assignedTo: string | null;
  decidedBy: string | null;
  submitterEmail: string;
  submitterFirstName: string | null;
  submitterLastName: string | null;
  reviewerEmail: string | null;
  reviewerFirstName: string | null;
  reviewerLastName: string | null;
  deciderEmail: string | null;
  deciderFirstName: string | null;
  deciderLastName: string | null;
}

interface ActiveMemberRow {
  userId: string;
  role: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

interface NotificationRow {
  id: string;
  reviewRequestId: string;
  candidateId: string;
  clientId: string | null;
  eventType: string;
  title: string;
  readAt: Date | null;
  createdAt: Date;
}

export interface MemoryReviewIdentity {
  userId: string;
  name: string;
}

export interface MemoryReviewInboxItem {
  candidateId: string;
  reviewRequestId: string;
  candidateKind: 'standard' | 'correction' | 'restore' | 'contradiction';
  scope: 'firm' | 'client';
  client: { id: string; name: string; status: string | null } | null;
  title: string;
  status: MemoryReviewPublicStatus;
  revisionNumber: number;
  rootCandidateId: string;
  predecessorCandidateId: string | null;
  submittedBy: MemoryReviewIdentity;
  assignedReviewer: MemoryReviewIdentity | null;
  decidedBy: MemoryReviewIdentity | null;
  createdAt: string;
  decidedAt: string | null;
  blockedReason: MemoryReviewBlockedReason;
  nextAction: MemoryReviewNextAction;
  capabilities: {
    open: boolean;
    approve: boolean;
    reject: boolean;
    requestChanges: boolean;
    revise: boolean;
    reassign: boolean;
    withdraw: boolean;
  };
}

export interface MemoryReviewInboxPage {
  enabled: boolean;
  view: MemoryReviewInboxView;
  items: MemoryReviewInboxItem[];
  nextCursor: string | null;
}

export interface MemoryReviewInboxSummary {
  enabled: boolean;
  counts: {
    needsMyReview: number;
    submittedByMe: number;
    allPending: number;
    blocked: number;
    history: number;
  };
  truncated: boolean;
}

export interface MemoryReviewProposalContent {
  key: string | null;
  value: string | null;
  canonicalItem: {
    type: string;
    slug: string;
    title: string;
    sections: MemorySection[];
  } | null;
}

export interface MemoryReviewDetail extends MemoryReviewInboxItem {
  proposal: MemoryReviewProposalContent;
  feedbackReason: string | null;
  eligibleReviewers: Array<MemoryReviewIdentity & { role: TenantRole }>;
  timeline: Array<{
    candidateId: string;
    reviewRequestId: string;
    revisionNumber: number;
    predecessorCandidateId: string | null;
    supersededById: string | null;
    title: string;
    status: MemoryReviewPublicStatus;
    submittedBy: MemoryReviewIdentity;
    assignedReviewer: MemoryReviewIdentity | null;
    decidedBy: MemoryReviewIdentity | null;
    createdAt: string;
    decidedAt: string | null;
  }>;
  controllingMemory: { itemId: string; version: number | null } | null;
  activeMemoryUnchanged: boolean;
}

export interface MemoryReviewNotificationItem {
  id: string;
  reviewRequestId: string;
  candidateId: string;
  clientId: string | null;
  eventType: string;
  title: string;
  readAt: string | null;
  createdAt: string;
}

@Injectable()
export class MemoryReviewInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
  ) {}

  async list(
    ctx: TenantContext,
    input: { view?: unknown; cursor?: unknown; limit?: unknown },
  ): Promise<MemoryReviewInboxPage> {
    const view = parseMemoryReviewInboxView(input.view);
    const limit = parseMemoryReviewPageSize(input.limit);
    const cursor = decodeMemoryReviewCursor(input.cursor);
    if (!settingsMemoryReviewEnabledForTenant(ctx.tenantId)) {
      return { enabled: false, view, items: [], nextCursor: null };
    }

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const viewer = await this.requireActiveViewerInTx(tx, ctx);
      this.assertViewAllowed(view, viewer.role);
      const scanLimit = Math.min(250, limit * 4 + 1);
      const rows = await this.queryInboxRowsInTx(
        tx,
        ctx,
        view,
        scanLimit,
        cursor,
        viewer.role,
      );
      const items: MemoryReviewInboxItem[] = [];
      let lastReturnedRow: InboxRow | null = null;
      let hasExtraVisible = false;
      for (const row of rows) {
        const item = await this.projectRowInTx(tx, ctx, viewer, row);
        if (
          !item ||
          !this.itemMatchesView(item, row, view, viewer.role, ctx.userId)
        ) {
          continue;
        }
        if (items.length >= limit) {
          hasExtraVisible = true;
          break;
        }
        items.push(item);
        lastReturnedRow = row;
      }
      const lastScanned = rows.at(-1) ?? null;
      const cursorRow =
        items.length === limit && lastReturnedRow
          ? lastReturnedRow
          : rows.length === scanLimit
            ? lastScanned
            : null;
      return {
        enabled: true,
        view,
        items,
        nextCursor:
          (hasExtraVisible || rows.length === scanLimit) && cursorRow
            ? encodeMemoryReviewCursor({
                createdAt: cursorRow.createdAt.toISOString(),
                id: cursorRow.reviewRequestId,
              })
            : null,
      };
    });
  }

  async summary(ctx: TenantContext): Promise<MemoryReviewInboxSummary> {
    if (!settingsMemoryReviewEnabledForTenant(ctx.tenantId)) {
      return {
        enabled: false,
        counts: {
          needsMyReview: 0,
          submittedByMe: 0,
          allPending: 0,
          blocked: 0,
          history: 0,
        },
        truncated: false,
      };
    }

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const viewer = await this.requireActiveViewerInTx(tx, ctx);
      const rows = await this.querySummaryRowsInTx(
        tx,
        ctx,
        viewer.role,
        MAX_SUMMARY_SCAN + 1,
      );
      const counts = {
        needsMyReview: 0,
        submittedByMe: 0,
        allPending: 0,
        blocked: 0,
        history: 0,
      };
      for (const row of rows.slice(0, MAX_SUMMARY_SCAN)) {
        const item = await this.projectRowInTx(tx, ctx, viewer, row);
        if (!item) continue;
        const open =
          item.status === 'pending' || item.status === 'changes_requested';
        const viewerIsSubmitter = row.requestedBy === ctx.userId;
        const actionable =
          item.status === 'pending' &&
          row.assignedTo === ctx.userId &&
          (item.capabilities.approve || item.capabilities.reject);
        const adminVisible = isAdmin(viewer.role) && item.capabilities.open;
        if (open && (viewerIsSubmitter || actionable || adminVisible)) {
          counts.allPending += 1;
        }
        if (open && viewerIsSubmitter) counts.submittedByMe += 1;
        if (actionable) counts.needsMyReview += 1;
        if (open && adminVisible && item.blockedReason) counts.blocked += 1;
        if (
          !open &&
          (viewerIsSubmitter || row.assignedTo === ctx.userId || adminVisible)
        ) {
          counts.history += 1;
        }
      }
      return {
        enabled: true,
        counts,
        truncated: rows.length > MAX_SUMMARY_SCAN,
      };
    });
  }

  detail(ctx: TenantContext, candidateId: string): Promise<MemoryReviewDetail> {
    return this.detailFor(ctx, { candidateId });
  }

  detailByReviewRequest(
    ctx: TenantContext,
    reviewRequestId: string,
  ): Promise<MemoryReviewDetail> {
    return this.detailFor(ctx, { reviewRequestId });
  }

  private async detailFor(
    ctx: TenantContext,
    selector: { candidateId: string } | { reviewRequestId: string },
  ): Promise<MemoryReviewDetail> {
    if (!settingsMemoryReviewEnabledForTenant(ctx.tenantId)) {
      throw new NotFoundException('Memory review is not available.');
    }
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const viewer = await this.requireActiveViewerInTx(tx, ctx);
      const row = await this.loadDetailRowInTx(tx, ctx.tenantId, selector);
      if (!row) throw new NotFoundException('Memory review was not found.');
      const item = await this.projectRowInTx(tx, ctx, viewer, row);
      if (!item) throw new NotFoundException('Memory review was not found.');

      const participant =
        row.requestedBy === ctx.userId ||
        row.assignedTo === ctx.userId ||
        (row.decidedBy === ctx.userId && row.decidedBy !== null);
      if (!participant && !isAdmin(viewer.role)) {
        throw new NotFoundException('Memory review was not found.');
      }

      const subject = await this.authorization.loadCandidateInTx(
        tx,
        ctx.tenantId,
        row.candidateId,
      );
      if (!subject) throw new NotFoundException('Memory review was not found.');
      const read = await this.authorization.evaluateInTx(
        tx,
        viewer,
        subject,
        'read',
        { emitDenialMetrics: false },
      );
      if (!read.allowed) throw new NotFoundException('Memory review was not found.');

      const eligibleReviewers = await this.eligibleReviewersInTx(
        tx,
        ctx.tenantId,
        row.requestedBy,
        subject,
      );
      const timeline = await this.loadTimelineInTx(
        tx,
        ctx.tenantId,
        row.rootCandidateId,
      );
      const publicStatus = memoryReviewStatusFromDb(row.workflowStatus);
      const canSeeFeedback = participant || isAdmin(viewer.role);
      return {
        ...item,
        proposal: proposalFromPayload(row.payload),
        feedbackReason:
          canSeeFeedback &&
          (publicStatus === 'changes_requested' || publicStatus === 'rejected')
            ? normalizeFeedback(row.feedbackReason)
            : null,
        eligibleReviewers,
        timeline: timeline.map(projectTimelineRow),
        controllingMemory: controllingMemoryFromPayload(row.payload),
        activeMemoryUnchanged: publicStatus !== 'approved',
      };
    });
  }

  async listNotifications(
    ctx: TenantContext,
    input: { cursor?: unknown; limit?: unknown },
  ): Promise<{
    enabled: boolean;
    items: MemoryReviewNotificationItem[];
    nextCursor: string | null;
  }> {
    const limit = parseMemoryReviewPageSize(input.limit);
    const cursor = decodeMemoryReviewCursor(input.cursor);
    if (!settingsMemoryReviewEnabledForTenant(ctx.tenantId)) {
      return { enabled: false, items: [], nextCursor: null };
    }
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const viewer = await this.requireActiveViewerInTx(tx, ctx);
      const scanLimit = Math.min(250, limit * 4 + 1);
      const cursorClause = cursor
        ? Prisma.sql`AND (notification.created_at, notification.id) <
            (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
        : Prisma.sql``;
      const rows = await tx.$queryRaw<NotificationRow[]>(Prisma.sql`
        SELECT notification.id::text AS id,
               notification.review_request_id::text AS "reviewRequestId",
               notification.candidate_id::text AS "candidateId",
               notification.client_id::text AS "clientId",
               notification.event_type AS "eventType",
               notification.title,
               notification.read_at AS "readAt",
               notification.created_at AS "createdAt"
        FROM memory_review_in_app_notification notification
        WHERE notification.tenant_id = ${ctx.tenantId}::uuid
          AND notification.recipient_user_id = ${ctx.userId}::uuid
          ${cursorClause}
        ORDER BY notification.created_at DESC, notification.id DESC
        LIMIT ${scanLimit}
      `);
      const items: MemoryReviewNotificationItem[] = [];
      let lastReturnedRow: NotificationRow | null = null;
      let hasExtraVisible = false;
      for (const row of rows) {
        if (!(await this.notificationVisibleInTx(tx, viewer, row))) continue;
        if (items.length >= limit) {
          hasExtraVisible = true;
          break;
        }
        items.push(projectNotification(row));
        lastReturnedRow = row;
      }
      const lastScanned = rows.at(-1) ?? null;
      const cursorRow =
        items.length === limit && lastReturnedRow
          ? lastReturnedRow
          : rows.length === scanLimit
            ? lastScanned
            : null;
      return {
        enabled: true,
        items,
        nextCursor:
          (hasExtraVisible || rows.length === scanLimit) && cursorRow
            ? encodeMemoryReviewCursor({
                createdAt: cursorRow.createdAt.toISOString(),
                id: cursorRow.id,
              })
            : null,
      };
    });
  }

  async unreadNotificationCount(
    ctx: TenantContext,
  ): Promise<{ enabled: boolean; count: number }> {
    if (!settingsMemoryReviewEnabledForTenant(ctx.tenantId)) {
      return { enabled: false, count: 0 };
    }
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const viewer = await this.requireActiveViewerInTx(tx, ctx);
      const rows = await tx.$queryRaw<NotificationRow[]>(Prisma.sql`
        SELECT notification.id::text AS id,
               notification.review_request_id::text AS "reviewRequestId",
               notification.candidate_id::text AS "candidateId",
               notification.client_id::text AS "clientId",
               notification.event_type AS "eventType",
               notification.title,
               notification.read_at AS "readAt",
               notification.created_at AS "createdAt"
        FROM memory_review_in_app_notification notification
        WHERE notification.tenant_id = ${ctx.tenantId}::uuid
          AND notification.recipient_user_id = ${ctx.userId}::uuid
          AND notification.read_at IS NULL
        ORDER BY notification.created_at DESC, notification.id DESC
        LIMIT ${MAX_NOTIFICATION_SCAN + 1}
      `);
      let count = 0;
      for (const row of rows.slice(0, MAX_NOTIFICATION_SCAN)) {
        if (await this.notificationVisibleInTx(tx, viewer, row)) count += 1;
      }
      return { enabled: true, count };
    });
  }

  async markNotificationRead(
    ctx: TenantContext,
    notificationId: string,
  ): Promise<void> {
    if (!settingsMemoryReviewEnabledForTenant(ctx.tenantId)) {
      throw new NotFoundException('Memory review notification was not found.');
    }
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const viewer = await this.requireActiveViewerInTx(tx, ctx);
      const rows = await tx.$queryRaw<NotificationRow[]>(Prisma.sql`
        SELECT notification.id::text AS id,
               notification.review_request_id::text AS "reviewRequestId",
               notification.candidate_id::text AS "candidateId",
               notification.client_id::text AS "clientId",
               notification.event_type AS "eventType",
               notification.title,
               notification.read_at AS "readAt",
               notification.created_at AS "createdAt"
        FROM memory_review_in_app_notification notification
        WHERE notification.id = ${notificationId}::uuid
          AND notification.tenant_id = ${ctx.tenantId}::uuid
          AND notification.recipient_user_id = ${ctx.userId}::uuid
        LIMIT 1
      `);
      const notification = rows[0];
      if (
        !notification ||
        !(await this.notificationVisibleInTx(tx, viewer, notification))
      ) {
        throw new NotFoundException('Memory review notification was not found.');
      }
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE memory_review_in_app_notification
        SET read_at = COALESCE(read_at, now())
        WHERE id = ${notificationId}::uuid
          AND tenant_id = ${ctx.tenantId}::uuid
          AND recipient_user_id = ${ctx.userId}::uuid
      `);
      if (updated !== 1) {
        throw new NotFoundException('Memory review notification was not found.');
      }
    });
  }

  async markAllNotificationsRead(ctx: TenantContext): Promise<number> {
    if (!settingsMemoryReviewEnabledForTenant(ctx.tenantId)) return 0;
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const viewer = await this.requireActiveViewerInTx(tx, ctx);
      const rows = await tx.$queryRaw<NotificationRow[]>(Prisma.sql`
        SELECT notification.id::text AS id,
               notification.review_request_id::text AS "reviewRequestId",
               notification.candidate_id::text AS "candidateId",
               notification.client_id::text AS "clientId",
               notification.event_type AS "eventType",
               notification.title,
               notification.read_at AS "readAt",
               notification.created_at AS "createdAt"
        FROM memory_review_in_app_notification notification
        WHERE notification.tenant_id = ${ctx.tenantId}::uuid
          AND notification.recipient_user_id = ${ctx.userId}::uuid
          AND notification.read_at IS NULL
        ORDER BY notification.created_at DESC, notification.id DESC
        LIMIT ${MAX_NOTIFICATION_SCAN}
      `);
      const visibleIds: string[] = [];
      for (const row of rows) {
        if (await this.notificationVisibleInTx(tx, viewer, row)) {
          visibleIds.push(row.id);
        }
      }
      if (visibleIds.length === 0) return 0;
      return tx.$executeRaw(Prisma.sql`
        UPDATE memory_review_in_app_notification
        SET read_at = now()
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND recipient_user_id = ${ctx.userId}::uuid
          AND read_at IS NULL
          AND id IN (${Prisma.join(
            visibleIds.map((id) => Prisma.sql`${id}::uuid`),
          )})
      `);
    });
  }

  private async notificationVisibleInTx(
    tx: Prisma.TransactionClient,
    viewer: ActiveViewer,
    row: Pick<NotificationRow, 'candidateId'>,
  ): Promise<boolean> {
    const subject = await this.authorization.loadCandidateInTx(
      tx,
      viewer.tenantId,
      row.candidateId,
    );
    if (!subject) return false;
    const read = await this.authorization.evaluateInTx(
      tx,
      viewer,
      subject,
      'read',
      { emitDenialMetrics: false },
    );
    return read.allowed;
  }

  private async requireActiveViewerInTx(
    tx: Prisma.TransactionClient,
    ctx: Pick<TenantContext, 'tenantId' | 'userId' | 'role'>,
  ): Promise<ActiveViewer> {
    const rows = await tx.$queryRaw<Array<{ userId: string; role: string }>>(
      Prisma.sql`
        SELECT tm.user_id::text AS "userId", tm.role::text AS role
        FROM tenant_memberships tm
        WHERE tm.tenant_id = ${ctx.tenantId}::uuid
          AND tm.user_id = ${ctx.userId}::uuid
          AND tm.status = 'active'
        LIMIT 1
      `,
    );
    const row = rows[0];
    const role = row ? tenantRole(row.role) : null;
    if (!row || !role) {
      throw new ForbiddenException('Active workspace membership is required.');
    }
    return { tenantId: ctx.tenantId, userId: row.userId, role };
  }

  private assertViewAllowed(view: MemoryReviewInboxView, role: TenantRole): void {
    if ((view === 'all_pending' || view === 'blocked') && !isAdmin(role)) {
      throw new ForbiddenException(
        'Administrator access is required for this memory review view.',
      );
    }
  }

  private async queryInboxRowsInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    view: MemoryReviewInboxView,
    limit: number,
    cursor: { createdAt: string; id: string } | null,
    viewerRole: TenantRole,
  ): Promise<InboxRow[]> {
    const viewClause = inboxViewClause(view, ctx, viewerRole);
    const cursorClause = cursor
      ? Prisma.sql`AND (rr.created_at, rr.id) <
          (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.sql``;
    return tx.$queryRaw<InboxRow[]>(Prisma.sql`
      ${inboxSelect()}
      WHERE rr.tenant_id = ${ctx.tenantId}::uuid
        AND rr.surface = 'memory'
        AND rr.subject_type = 'memory_candidate'
        ${viewClause}
        ${cursorClause}
      ORDER BY rr.created_at DESC, rr.id DESC
      LIMIT ${limit}
    `);
  }

  private async querySummaryRowsInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    viewerRole: TenantRole,
    limit: number,
  ): Promise<InboxRow[]> {
    const participantClause = isAdmin(viewerRole)
      ? Prisma.sql``
      : Prisma.sql`AND (
          rr.requested_by = ${ctx.userId}::uuid
          OR rr.assigned_to = ${ctx.userId}::uuid
          OR rr.decided_by = ${ctx.userId}::uuid
        )`;
    return tx.$queryRaw<InboxRow[]>(Prisma.sql`
      ${inboxSelect()}
      WHERE rr.tenant_id = ${ctx.tenantId}::uuid
        AND rr.surface = 'memory'
        AND rr.subject_type = 'memory_candidate'
        ${participantClause}
      ORDER BY rr.created_at DESC, rr.id DESC
      LIMIT ${limit}
    `);
  }

  private async projectRowInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    viewer: ActiveViewer,
    row: InboxRow,
  ): Promise<MemoryReviewInboxItem | null> {
    const subject = await this.authorization.loadCandidateInTx(
      tx,
      ctx.tenantId,
      row.candidateId,
    );
    if (!subject) return null;
    const read = await this.authorization.evaluateInTx(
      tx,
      viewer,
      subject,
      'read',
      { emitDenialMetrics: false },
    );
    if (!read.allowed) return null;

    const status = memoryReviewStatusFromDb(row.workflowStatus);
    const viewerIsSubmitter = row.requestedBy === ctx.userId;
    const viewerIsAssignedReviewer = row.assignedTo === ctx.userId;
    let canApprove = false;
    let canReject = false;
    if (status === 'pending' && viewerIsAssignedReviewer && !viewerIsSubmitter) {
      const approve = await this.authorization.evaluateInTx(
        tx,
        viewer,
        subject,
        'approve',
        { emitDenialMetrics: false },
      );
      const review = await this.authorization.evaluateInTx(
        tx,
        viewer,
        subject,
        'review',
        { emitDenialMetrics: false },
      );
      canApprove = approve.allowed;
      canReject = review.allowed;
    }
    let canRevise = false;
    if (status === 'changes_requested' && viewerIsSubmitter) {
      const propose = await this.authorization.evaluateInTx(
        tx,
        viewer,
        subject,
        'propose',
        { emitDenialMetrics: false },
      );
      canRevise = propose.allowed;
    }
    let assignedReviewerEligible = false;
    if (status === 'pending' && row.assignedTo && row.assignedReviewerActive) {
      const assignedRole = row.assignedReviewerRole
        ? tenantRole(row.assignedReviewerRole)
        : null;
      if (assignedRole) {
        const assignment = await this.authorization.evaluateInTx(
          tx,
          {
            tenantId: ctx.tenantId,
            userId: row.assignedTo,
            role: assignedRole,
          },
          subject,
          'approve',
          { emitDenialMetrics: false },
        );
        assignedReviewerEligible = assignment.allowed;
      }
    }
    const blockedReason =
      status === 'pending'
        ? memoryReviewBlockedReason({
            clientId: row.clientId,
            clientStatus: row.clientStatus,
            assignedReviewerId: row.assignedTo,
            assignedReviewerActive: row.assignedReviewerActive,
            assignedReviewerEligible,
          })
        : null;
    let canReassign = false;
    if (status === 'pending' && isAdmin(viewer.role) && !viewerIsSubmitter) {
      const reassign = await this.authorization.evaluateInTx(
        tx,
        viewer,
        subject,
        'review',
        { emitDenialMetrics: false },
      );
      canReassign = reassign.allowed;
    }
    const canWithdraw =
      viewerIsSubmitter &&
      (status === 'pending' || status === 'changes_requested');
    return {
      candidateId: row.candidateId,
      reviewRequestId: row.reviewRequestId,
      candidateKind: memoryReviewCandidateKindFromSource(
        row.sourceKind,
        row.candidateKind,
      ),
      scope: row.scope === 'client' ? 'client' : 'firm',
      client: row.clientId
        ? {
            id: row.clientId,
            name: row.clientName ?? 'Client',
            status: row.clientStatus,
          }
        : null,
      title: normalizeTitle(row.title),
      status,
      revisionNumber: row.revisionNumber,
      rootCandidateId: row.rootCandidateId,
      predecessorCandidateId: row.predecessorCandidateId,
      submittedBy: identity(
        row.requestedBy,
        row.submitterFirstName,
        row.submitterLastName,
        row.submitterEmail,
      ),
      assignedReviewer: row.assignedTo
        ? identity(
            row.assignedTo,
            row.reviewerFirstName,
            row.reviewerLastName,
            row.reviewerEmail,
          )
        : null,
      decidedBy: row.decidedBy
        ? identity(
            row.decidedBy,
            row.deciderFirstName,
            row.deciderLastName,
            row.deciderEmail,
          )
        : null,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      blockedReason,
      nextAction: memoryReviewNextAction({
        status,
        viewerIsSubmitter,
        viewerIsAssignedReviewer,
        viewerIsAdmin: isAdmin(viewer.role),
        canApprove,
        canReject,
        canRevise,
        canReassign,
      }),
      capabilities: {
        open: true,
        approve: canApprove,
        reject: canReject,
        requestChanges: canReject,
        revise: canRevise,
        reassign: canReassign,
        withdraw: canWithdraw,
      },
    };
  }

  private itemMatchesView(
    item: MemoryReviewInboxItem,
    row: InboxRow,
    view: MemoryReviewInboxView,
    viewerRole: TenantRole,
    viewerUserId: string,
  ): boolean {
    switch (view) {
      case 'needs_my_review':
        return (
          item.status === 'pending' &&
          row.assignedTo !== row.requestedBy &&
          (item.capabilities.approve || item.capabilities.reject)
        );
      case 'submitted_by_me':
        return item.status === 'pending' || item.status === 'changes_requested';
      case 'all_pending':
        return (
          isAdmin(viewerRole) &&
          (item.status === 'pending' || item.status === 'changes_requested')
        );
      case 'blocked':
        return isAdmin(viewerRole) && Boolean(item.blockedReason);
      case 'history':
        return (
          item.status !== 'pending' &&
          item.status !== 'changes_requested' &&
          (isAdmin(viewerRole) ||
            row.requestedBy === viewerUserId ||
            row.assignedTo === viewerUserId ||
            row.decidedBy === viewerUserId)
        );
    }
  }

  private async loadDetailRowInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    selector: { candidateId: string } | { reviewRequestId: string },
  ): Promise<DetailRow | null> {
    const selectorClause =
      'candidateId' in selector
        ? Prisma.sql`AND mc.id = ${selector.candidateId}::uuid`
        : Prisma.sql`AND rr.id = ${selector.reviewRequestId}::uuid`;
    const rows = await tx.$queryRaw<DetailRow[]>(Prisma.sql`
      ${inboxSelect(true)}
      WHERE rr.tenant_id = ${tenantId}::uuid
        AND rr.surface = 'memory'
        AND rr.subject_type = 'memory_candidate'
        ${selectorClause}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  private async loadTimelineInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    rootCandidateId: string,
  ): Promise<TimelineRow[]> {
    return tx.$queryRaw<TimelineRow[]>(Prisma.sql`
      SELECT mc.id::text AS "candidateId",
             rr.id::text AS "reviewRequestId",
             mc.revision_number AS "revisionNumber",
             mc.predecessor_candidate_id::text AS "predecessorCandidateId",
             mc.superseded_by_id::text AS "supersededById",
             rr.title,
             rr.status AS "workflowStatus",
             rr.created_at AS "createdAt",
             rr.decided_at AS "decidedAt",
             rr.requested_by::text AS "requestedBy",
             rr.assigned_to::text AS "assignedTo",
             rr.decided_by::text AS "decidedBy",
             submitter.email::text AS "submitterEmail",
             submitter.first_name AS "submitterFirstName",
             submitter.last_name AS "submitterLastName",
             reviewer.email::text AS "reviewerEmail",
             reviewer.first_name AS "reviewerFirstName",
             reviewer.last_name AS "reviewerLastName",
             decider.email::text AS "deciderEmail",
             decider.first_name AS "deciderFirstName",
             decider.last_name AS "deciderLastName"
      FROM memory_candidate mc
      JOIN review_request rr
        ON rr.tenant_id = mc.tenant_id
       AND rr.surface = 'memory'
       AND rr.subject_type = 'memory_candidate'
       AND rr.subject_id = mc.id::text
      JOIN users submitter ON submitter.id = rr.requested_by
      LEFT JOIN users reviewer ON reviewer.id = rr.assigned_to
      LEFT JOIN users decider ON decider.id = rr.decided_by
      WHERE mc.tenant_id = ${tenantId}::uuid
        AND COALESCE(mc.revision_root_id, mc.id) = ${rootCandidateId}::uuid
      ORDER BY mc.revision_number ASC, mc.created_at ASC, mc.id ASC
    `);
  }

  private async eligibleReviewersInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    proposerId: string,
    subject: GovernedMemorySubjectRow,
  ): Promise<Array<MemoryReviewIdentity & { role: TenantRole }>> {
    const rows = await tx.$queryRaw<ActiveMemberRow[]>(Prisma.sql`
      SELECT tm.user_id::text AS "userId",
             tm.role::text AS role,
             u.email::text AS email,
             u.first_name AS "firstName",
             u.last_name AS "lastName"
      FROM tenant_memberships tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.tenant_id = ${tenantId}::uuid
        AND tm.status = 'active'
        AND tm.user_id <> ${proposerId}::uuid
      ORDER BY u.email ASC, tm.user_id ASC
    `);
    const eligible: Array<MemoryReviewIdentity & { role: TenantRole }> = [];
    for (const row of rows) {
      const role = tenantRole(row.role);
      if (!role) continue;
      const decision = await this.authorization.evaluateInTx(
        tx,
        { tenantId, userId: row.userId, role },
        subject,
        'approve',
        { emitDenialMetrics: false },
      );
      if (!decision.allowed) continue;
      eligible.push({
        ...identity(row.userId, row.firstName, row.lastName, row.email),
        role,
      });
    }
    return eligible;
  }
}

function inboxSelect(includePayload = false): Prisma.Sql {
  return Prisma.sql`
    SELECT rr.id::text AS "reviewRequestId",
           mc.id::text AS "candidateId",
           rr.client_id::text AS "clientId",
           client.name AS "clientName",
           client.status::text AS "clientStatus",
           rr.title,
           rr.status AS "workflowStatus",
           rr.requested_by::text AS "requestedBy",
           rr.assigned_to::text AS "assignedTo",
           rr.decided_by::text AS "decidedBy",
           rr.created_at AS "createdAt",
           rr.decided_at AS "decidedAt",
           rr.payload_jsonb ->> 'candidateKind' AS "candidateKind",
           mc.source_kind AS "sourceKind",
           mc.scope,
           mc.revision_number AS "revisionNumber",
           COALESCE(mc.revision_root_id, mc.id)::text AS "rootCandidateId",
           mc.predecessor_candidate_id::text AS "predecessorCandidateId",
           mc.superseded_by_id::text AS "supersededById",
           COALESCE(assigned_tm.status = 'active', false) AS "assignedReviewerActive",
           assigned_tm.role::text AS "assignedReviewerRole",
           submitter.email::text AS "submitterEmail",
           submitter.first_name AS "submitterFirstName",
           submitter.last_name AS "submitterLastName",
           reviewer.email::text AS "reviewerEmail",
           reviewer.first_name AS "reviewerFirstName",
           reviewer.last_name AS "reviewerLastName",
           decider.email::text AS "deciderEmail",
           decider.first_name AS "deciderFirstName",
           decider.last_name AS "deciderLastName"
           ${includePayload
             ? Prisma.sql`, mc.payload_jsonb AS payload, rr.reason AS "feedbackReason"`
             : Prisma.sql``}
    FROM review_request rr
    JOIN memory_candidate mc
      ON mc.tenant_id = rr.tenant_id
     AND mc.id::text = rr.subject_id
    JOIN users submitter ON submitter.id = rr.requested_by
    LEFT JOIN users reviewer ON reviewer.id = rr.assigned_to
    LEFT JOIN users decider ON decider.id = rr.decided_by
    LEFT JOIN tenant_memberships assigned_tm
      ON assigned_tm.tenant_id = rr.tenant_id
     AND assigned_tm.user_id = rr.assigned_to
    LEFT JOIN clients client
      ON client.tenant_id = rr.tenant_id
     AND client.id = rr.client_id
  `;
}

function inboxViewClause(
  view: MemoryReviewInboxView,
  ctx: TenantContext,
  viewerRole: TenantRole,
): Prisma.Sql {
  switch (view) {
    case 'needs_my_review':
      return Prisma.sql`
        AND rr.status = 'pending'
        AND rr.assigned_to = ${ctx.userId}::uuid
        AND rr.requested_by <> ${ctx.userId}::uuid
      `;
    case 'submitted_by_me':
      return Prisma.sql`
        AND rr.status IN ('pending', 'changes_needed')
        AND rr.requested_by = ${ctx.userId}::uuid
      `;
    case 'all_pending':
      return Prisma.sql`AND rr.status IN ('pending', 'changes_needed')`;
    case 'blocked':
      return Prisma.sql`AND rr.status = 'pending'`;
    case 'history':
      return isAdmin(viewerRole)
        ? Prisma.sql`AND rr.status IN ('approved', 'rejected', 'withdrawn', 'superseded')`
        : Prisma.sql`
            AND rr.status IN ('approved', 'rejected', 'withdrawn', 'superseded')
            AND (
              rr.requested_by = ${ctx.userId}::uuid
              OR rr.assigned_to = ${ctx.userId}::uuid
              OR rr.decided_by = ${ctx.userId}::uuid
            )
          `;
  }
}

function projectTimelineRow(
  row: TimelineRow,
): MemoryReviewDetail['timeline'][number] {
  return {
    candidateId: row.candidateId,
    reviewRequestId: row.reviewRequestId,
    revisionNumber: row.revisionNumber,
    predecessorCandidateId: row.predecessorCandidateId,
    supersededById: row.supersededById,
    title: normalizeTitle(row.title),
    status: memoryReviewStatusFromDb(row.workflowStatus),
    submittedBy: identity(
      row.requestedBy,
      row.submitterFirstName,
      row.submitterLastName,
      row.submitterEmail,
    ),
    assignedReviewer: row.assignedTo
      ? identity(
          row.assignedTo,
          row.reviewerFirstName,
          row.reviewerLastName,
          row.reviewerEmail,
        )
      : null,
    decidedBy: row.decidedBy
      ? identity(
          row.decidedBy,
          row.deciderFirstName,
          row.deciderLastName,
          row.deciderEmail,
        )
      : null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

function projectNotification(row: NotificationRow): MemoryReviewNotificationItem {
  return {
    id: row.id,
    reviewRequestId: row.reviewRequestId,
    candidateId: row.candidateId,
    clientId: row.clientId,
    eventType: row.eventType,
    title: normalizeTitle(row.title),
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function proposalFromPayload(payload: unknown): MemoryReviewProposalContent {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { key: null, value: null, canonicalItem: null };
  }
  const record = payload as Record<string, unknown>;
  const canonical = record.canonicalItem;
  return {
    key: typeof record.key === 'string' ? record.key : null,
    value: typeof record.value === 'string' ? record.value : null,
    canonicalItem:
      canonical && typeof canonical === 'object' && !Array.isArray(canonical)
        ? canonicalItem(canonical as Record<string, unknown>)
        : null,
  };
}

function canonicalItem(
  value: Record<string, unknown>,
): MemoryReviewProposalContent['canonicalItem'] {
  if (
    typeof value.type !== 'string' ||
    typeof value.slug !== 'string' ||
    typeof value.title !== 'string' ||
    !Array.isArray(value.sections)
  ) {
    return null;
  }
  const sections: MemorySection[] = [];
  for (const entry of value.sections.slice(0, 50)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const section = entry as Record<string, unknown>;
    if (
      typeof section.key !== 'string' ||
      typeof section.heading !== 'string' ||
      (section.owner !== 'human' && section.owner !== 'engine') ||
      typeof section.body !== 'string'
    ) {
      return null;
    }
    sections.push({
      key: section.key,
      heading: section.heading,
      owner: section.owner,
      body: section.body,
    });
  }
  return {
    type: value.type,
    slug: value.slug,
    title: normalizeTitle(value.title),
    sections,
  };
}

function controllingMemoryFromPayload(
  payload: unknown,
): { itemId: string; version: number | null } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const proposal = (payload as Record<string, unknown>).versionProposal;
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return null;
  }
  const record = proposal as Record<string, unknown>;
  const itemId =
    typeof record.itemId === 'string'
      ? record.itemId
      : typeof record.targetItemId === 'string'
        ? record.targetItemId
        : null;
  if (!itemId) return null;
  const rawVersion = record.version ?? record.targetVersion;
  return {
    itemId,
    version:
      typeof rawVersion === 'number' && Number.isInteger(rawVersion)
        ? rawVersion
        : null,
  };
}

function normalizeFeedback(value: string): string | null {
  const clean = value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!clean || clean === 'Memory candidate awaiting independent review.') {
    return null;
  }
  return clean.slice(0, 500);
}

function normalizeTitle(value: string): string {
  const clean = value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  return (clean || 'Memory proposal').slice(0, 300);
}

function identity(
  userId: string,
  firstName: string | null,
  lastName: string | null,
  email: string | null,
): MemoryReviewIdentity {
  const name = [firstName?.trim(), lastName?.trim()].filter(Boolean).join(' ');
  return { userId, name: name || email?.trim() || 'Former user' };
}

function tenantRole(value: string): TenantRole | null {
  return [
    'capiro_admin',
    'user_admin',
    'standard_user',
    'client_portal_user',
  ].includes(value)
    ? (value as TenantRole)
    : null;
}

function isAdmin(role: TenantRole): boolean {
  return role === 'user_admin' || role === 'capiro_admin';
}
