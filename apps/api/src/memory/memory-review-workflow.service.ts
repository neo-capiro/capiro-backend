import { createHash } from 'node:crypto';
import {
  BadRequestException,
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
  memoryReviewStatusFromDb,
  memoryReviewStatusToDb,
  memoryReviewerDisplayName,
  memoryReviewerRoleRank,
  normalizeMemoryReviewReason,
  type MemoryReviewWorkflowStatus,
} from './memory-review-workflow.helpers.js';

const MEMORY_REVIEW_SURFACE = 'memory';
const MEMORY_REVIEW_SUBJECT = 'memory_candidate';
const PENDING_REASON = 'Memory candidate awaiting independent review.';

export interface MemoryReviewWorkflowCandidate {
  id: string;
  tenantId: string;
  clientId: string | null;
  proposedByUserId: string;
  sourceKind: string;
  scope: string;
  candidateKind: string;
  title: string;
}

export interface MemoryReviewIdentity {
  userId: string;
  name: string;
}

export interface MemoryReviewWorkflowSnapshot {
  requestId: string;
  status: MemoryReviewWorkflowStatus;
  submittedBy: MemoryReviewIdentity;
  assignedReviewer: MemoryReviewIdentity | null;
  decidedBy: MemoryReviewIdentity | null;
  feedbackReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  viewerIsSubmitter: boolean;
  viewerIsAssignedReviewer: boolean;
  capabilities: {
    requestChanges: boolean;
    reassign: boolean;
  };
}

interface ActiveMemberRow {
  userId: string;
  role: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

interface IdentityRow {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

interface MemoryReviewRequestRow {
  id: string;
  tenantId: string;
  candidateId: string;
  clientId: string | null;
  status: string;
  reason: string;
  requestedBy: string;
  assignedTo: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

interface LockedMemoryCandidateRow {
  id: string;
  clientId: string | null;
  proposedBy: string;
  sourceKind: string;
  scope: string;
  payload: unknown;
}

interface EligibleReviewer extends MemoryReviewIdentity {
  role: TenantRole;
  email: string;
}

/**
 * Phase 2 workflow state for shared-memory review.
 *
 * The candidate remains the canonical proposed content. review_request owns only
 * workflow authority: named reviewer, workflow status, bounded feedback, and
 * decision stamps. Its payload is deliberately body-free metadata.
 */
@Injectable()
export class MemoryReviewWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
  ) {}

  async ensureAndDescribeInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    candidate: MemoryReviewWorkflowCandidate,
    subject: GovernedMemorySubjectRow,
  ): Promise<MemoryReviewWorkflowSnapshot> {
    const row = await this.ensureRowInTx(tx, ctx, candidate, subject);
    return this.describeRowInTx(tx, ctx, row);
  }

  async requestChanges(
    ctx: TenantContext,
    candidateId: string,
    rawReason: unknown,
  ): Promise<MemoryReviewWorkflowSnapshot> {
    const reason = normalizeMemoryReviewReason(rawReason);
    if (!reason) {
      throw new BadRequestException('A reason is required when requesting memory changes.');
    }

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const candidate = await this.lockPendingCandidateInTx(tx, ctx.tenantId, candidateId);
      const subject = await this.authorization.loadCandidateInTx(tx, ctx.tenantId, candidateId);
      if (!subject) throw new NotFoundException('Memory candidate not found.');

      const decision = await this.authorization.evaluateInTx(tx, ctx, subject, 'review');
      if (!decision.allowed) {
        throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
      }

      await this.ensureRowInTx(
        tx,
        ctx,
        workflowCandidate(ctx.tenantId, candidate),
        subject,
      );

      const workflow = await this.lockWorkflowInTx(tx, ctx.tenantId, candidateId);
      if (workflow.status !== 'pending') {
        throw new BadRequestException(
          `Memory review is already in ${workflow.status.replaceAll('_', ' ')} status.`,
        );
      }
      if (workflow.requestedBy === ctx.userId) {
        throw new ForbiddenException('A proposer cannot request changes on their own submission.');
      }
      if (workflow.assignedTo !== ctx.userId) {
        throw new ForbiddenException('Only the assigned reviewer may request changes.');
      }

      const decidedAt = new Date();
      const updated = await tx.reviewRequest.update({
        where: { id: workflow.id },
        data: {
          status: memoryReviewStatusToDb('changes_requested'),
          reason,
          decidedBy: ctx.userId,
          decidedAt,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'memory.review.changes_requested',
          entityType: 'review_request',
          entityId: workflow.id,
          before: { status: workflow.status, candidateId },
          after: {
            status: memoryReviewStatusToDb('changes_requested'),
            candidateId,
            reasonHash: createHash('sha256').update(reason).digest('hex'),
            reasonChars: reason.length,
          },
        },
      });

      return this.describeRowInTx(tx, ctx, {
        ...workflow,
        status: updated.status,
        reason: updated.reason,
        decidedBy: updated.decidedBy,
        decidedAt: updated.decidedAt,
      });
    });
  }

  async assignReviewer(
    ctx: TenantContext,
    candidateId: string,
    reviewerUserId: string,
    rawReason: unknown,
  ): Promise<MemoryReviewWorkflowSnapshot> {
    if (ctx.role !== 'user_admin' && ctx.role !== 'capiro_admin') {
      throw new ForbiddenException('Only an administrator may reassign memory review.');
    }
    const reason = normalizeMemoryReviewReason(rawReason);
    if (!reason) {
      throw new BadRequestException('A reason is required when reassigning memory review.');
    }

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const candidate = await this.lockPendingCandidateInTx(tx, ctx.tenantId, candidateId);
      const subject = await this.authorization.loadCandidateInTx(tx, ctx.tenantId, candidateId);
      if (!subject) throw new NotFoundException('Memory candidate not found.');
      const descriptor = workflowCandidate(ctx.tenantId, candidate);
      await this.ensureRowInTx(tx, ctx, descriptor, subject);
      const workflow = await this.lockWorkflowInTx(tx, ctx.tenantId, candidateId);
      if (workflow.status !== 'pending') {
        throw new BadRequestException('Only pending memory review may be reassigned.');
      }

      const eligible = await this.eligibleReviewersInTx(
        tx,
        ctx.tenantId,
        candidate.proposedBy,
        subject,
      );
      const target = eligible.find((reviewer) => reviewer.userId === reviewerUserId);
      if (!target) {
        throw new BadRequestException('The selected reviewer is not currently eligible.');
      }
      if (workflow.assignedTo === target.userId) {
        return this.describeRowInTx(tx, ctx, workflow);
      }

      const previous = workflow.assignedTo;
      await tx.reviewRequest.update({
        where: { id: workflow.id },
        data: { assignedTo: target.userId },
      });
      const updated = { ...workflow, assignedTo: target.userId };
      await this.auditAssignmentInTx(
        tx,
        { userId: ctx.userId, role: ctx.role },
        ctx.tenantId,
        workflow.id,
        candidateId,
        previous,
        target.userId,
        'reassigned',
        reason,
      );
      return this.describeRowInTx(tx, ctx, updated);
    });
  }

  async assertAssignedForDecision(
    ctx: TenantContext,
    candidateId: string,
    operation: 'approve' | 'review',
  ): Promise<void> {
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const candidate = await this.lockPendingCandidateInTx(tx, ctx.tenantId, candidateId);
      const subject = await this.authorization.loadCandidateInTx(tx, ctx.tenantId, candidateId);
      if (!subject) throw new NotFoundException('Memory candidate not found.');
      await this.ensureRowInTx(tx, ctx, workflowCandidate(ctx.tenantId, candidate), subject);
      const workflow = await this.lockWorkflowInTx(tx, ctx.tenantId, candidateId);
      if (workflow.status !== 'pending') {
        throw new BadRequestException(
          `Memory review is already in ${memoryReviewStatusFromDb(workflow.status).replaceAll('_', ' ')} status.`,
        );
      }
      if (workflow.requestedBy === ctx.userId) {
        throw new ForbiddenException('A proposer cannot decide their own memory submission.');
      }
      if (workflow.assignedTo !== ctx.userId) {
        throw new ForbiddenException('Only the assigned reviewer may decide this submission.');
      }
      const decision = await this.authorization.evaluateInTx(tx, ctx, subject, operation);
      if (!decision.allowed) {
        throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
      }
    });
  }

  async completeDecision(
    ctx: TenantContext,
    candidateId: string,
    status: 'approved' | 'rejected',
    rawReason?: unknown,
  ): Promise<MemoryReviewWorkflowSnapshot> {
    const reason =
      status === 'approved'
        ? 'Approved by the assigned independent reviewer.'
        : normalizeMemoryReviewReason(rawReason);
    if (!reason) throw new BadRequestException('A rejection reason is required.');

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const workflow = await this.lockWorkflowInTx(tx, ctx.tenantId, candidateId);
      const current = memoryReviewStatusFromDb(workflow.status);
      if (current !== 'pending' && current !== status) {
        throw new BadRequestException(
          `Memory review is already in ${current.replaceAll('_', ' ')} status.`,
        );
      }
      if (workflow.requestedBy === ctx.userId || workflow.assignedTo !== ctx.userId) {
        throw new ForbiddenException('Only the assigned independent reviewer may complete review.');
      }
      if (
        current === status &&
        workflow.reason === reason &&
        workflow.decidedBy === ctx.userId &&
        workflow.decidedAt
      ) {
        return this.describeRowInTx(tx, ctx, workflow);
      }

      const decidedAt = workflow.decidedAt ?? new Date();
      const updated = await tx.reviewRequest.update({
        where: { id: workflow.id },
        data: {
          status: memoryReviewStatusToDb(status),
          reason,
          decidedBy: ctx.userId,
          decidedAt,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: `memory.review.${status}`,
          entityType: 'review_request',
          entityId: workflow.id,
          before: { status: current, candidateId },
          after: {
            status,
            candidateId,
            reasonHash: createHash('sha256').update(reason).digest('hex'),
            reasonChars: reason.length,
          },
        },
      });
      return this.describeRowInTx(tx, ctx, {
        ...workflow,
        status: updated.status,
        reason: updated.reason,
        decidedBy: updated.decidedBy,
        decidedAt: updated.decidedAt,
      });
    });
  }

  private async ensureRowInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    candidate: MemoryReviewWorkflowCandidate,
    subject: GovernedMemorySubjectRow,
  ): Promise<MemoryReviewRequestRow> {
    let row = await this.loadWorkflowInTx(tx, ctx.tenantId, candidate.id);
    const eligibleReviewers = await this.eligibleReviewersInTx(
      tx,
      ctx.tenantId,
      candidate.proposedByUserId,
      subject,
    );

    if (!row) {
      const assignedTo = eligibleReviewers[0]?.userId ?? null;
      try {
        const created = await tx.reviewRequest.create({
          data: {
            tenantId: ctx.tenantId,
            riskTier: 'moderate',
            surface: MEMORY_REVIEW_SURFACE,
            subjectType: MEMORY_REVIEW_SUBJECT,
            subjectId: candidate.id,
            clientId: candidate.clientId,
            title: candidate.title.slice(0, 300),
            reason: PENDING_REASON,
            payload: {
              workflow: 'memory_review_v2',
              schemaVersion: 1,
              candidateKind: candidate.candidateKind,
              sourceKind: candidate.sourceKind,
              scope: candidate.scope,
            },
            status: 'pending',
            requestedBy: candidate.proposedByUserId,
            assignedTo,
          },
        });
        row = reviewRequestRow(created, candidate.id);
        await this.auditAssignmentInTx(
          tx,
          { userId: null, role: 'system' },
          ctx.tenantId,
          row.id,
          candidate.id,
          null,
          assignedTo,
          'created',
          null,
        );
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
        row = await this.loadWorkflowInTx(tx, ctx.tenantId, candidate.id);
        if (!row) throw error;
      }
    }

    this.assertWorkflowMatchesCandidate(row, candidate);

    if (row.status === 'pending') {
      const assignmentStillEligible = eligibleReviewers.some(
        (reviewer) => reviewer.userId === row?.assignedTo,
      );
      const nextAssignedTo = assignmentStillEligible
        ? row.assignedTo
        : (eligibleReviewers[0]?.userId ?? null);
      if (nextAssignedTo !== row.assignedTo) {
        const previous = row.assignedTo;
        await tx.reviewRequest.update({
          where: { id: row.id },
          data: { assignedTo: nextAssignedTo },
        });
        row = { ...row, assignedTo: nextAssignedTo };
        await this.auditAssignmentInTx(
          tx,
          { userId: null, role: 'system' },
          ctx.tenantId,
          row.id,
          candidate.id,
          previous,
          nextAssignedTo,
          'reassigned',
          null,
        );
      }
    }

    return row;
  }

  private async eligibleReviewersInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    proposedByUserId: string,
    subject: GovernedMemorySubjectRow,
  ): Promise<EligibleReviewer[]> {
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
        AND tm.user_id <> ${proposedByUserId}::uuid
    `);

    const eligible: EligibleReviewer[] = [];
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
        userId: row.userId,
        role,
        email: row.email,
        name: memoryReviewerDisplayName(row),
      });
    }

    return eligible.sort(
      (left, right) =>
        memoryReviewerRoleRank(left.role) - memoryReviewerRoleRank(right.role) ||
        left.email.localeCompare(right.email) ||
        left.userId.localeCompare(right.userId),
    );
  }

  private async describeRowInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    row: MemoryReviewRequestRow,
  ): Promise<MemoryReviewWorkflowSnapshot> {
    const identities = await this.identitiesInTx(
      tx,
      [row.requestedBy, row.assignedTo, row.decidedBy].filter(
        (value): value is string => Boolean(value),
      ),
    );
    const submittedBy = identities.get(row.requestedBy) ?? {
      userId: row.requestedBy,
      name: 'Former user',
    };
    const assignedReviewer = row.assignedTo
      ? (identities.get(row.assignedTo) ?? { userId: row.assignedTo, name: 'Former user' })
      : null;
    const decidedBy = row.decidedBy
      ? (identities.get(row.decidedBy) ?? { userId: row.decidedBy, name: 'Former user' })
      : null;
    const status = memoryReviewStatusFromDb(row.status);
    const viewerIsAssignedReviewer = row.assignedTo === ctx.userId;
    const viewerIsSubmitter = row.requestedBy === ctx.userId;

    return {
      requestId: row.id,
      status,
      submittedBy,
      assignedReviewer,
      decidedBy,
      feedbackReason: status === 'changes_requested' ? row.reason : null,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      viewerIsSubmitter,
      viewerIsAssignedReviewer,
      capabilities: {
        requestChanges: status === 'pending' && viewerIsAssignedReviewer && !viewerIsSubmitter,
        reassign:
          status === 'pending' && (ctx.role === 'user_admin' || ctx.role === 'capiro_admin'),
      },
    };
  }

  private async identitiesInTx(
    tx: Prisma.TransactionClient,
    userIds: string[],
  ): Promise<Map<string, MemoryReviewIdentity>> {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<IdentityRow[]>(Prisma.sql`
      SELECT id::text AS "userId",
             email::text AS email,
             first_name AS "firstName",
             last_name AS "lastName"
      FROM users
      WHERE id IN (${Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}::uuid`))})
    `);
    return new Map(
      rows.map((row) => [
        row.userId,
        { userId: row.userId, name: memoryReviewerDisplayName(row) },
      ]),
    );
  }

  private async loadWorkflowInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidateId: string,
  ): Promise<MemoryReviewRequestRow | null> {
    const rows = await tx.$queryRaw<MemoryReviewRequestRow[]>(Prisma.sql`
      SELECT id::text AS id,
             tenant_id::text AS "tenantId",
             subject_id AS "candidateId",
             client_id::text AS "clientId",
             status,
             reason,
             requested_by::text AS "requestedBy",
             assigned_to::text AS "assignedTo",
             decided_by::text AS "decidedBy",
             decided_at AS "decidedAt",
             created_at AS "createdAt"
      FROM review_request
      WHERE tenant_id = ${tenantId}::uuid
        AND surface = ${MEMORY_REVIEW_SURFACE}
        AND subject_type = ${MEMORY_REVIEW_SUBJECT}
        AND subject_id = ${candidateId}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  private async lockWorkflowInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidateId: string,
  ): Promise<MemoryReviewRequestRow> {
    const rows = await tx.$queryRaw<MemoryReviewRequestRow[]>(Prisma.sql`
      SELECT id::text AS id,
             tenant_id::text AS "tenantId",
             subject_id AS "candidateId",
             client_id::text AS "clientId",
             status,
             reason,
             requested_by::text AS "requestedBy",
             assigned_to::text AS "assignedTo",
             decided_by::text AS "decidedBy",
             decided_at AS "decidedAt",
             created_at AS "createdAt"
      FROM review_request
      WHERE tenant_id = ${tenantId}::uuid
        AND surface = ${MEMORY_REVIEW_SURFACE}
        AND subject_type = ${MEMORY_REVIEW_SUBJECT}
        AND subject_id = ${candidateId}
      FOR UPDATE
    `);
    const row = rows[0];
    if (!row) throw new NotFoundException('Memory review workflow not found.');
    return row;
  }

  private async lockPendingCandidateInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidateId: string,
  ): Promise<LockedMemoryCandidateRow> {
    const rows = await tx.$queryRaw<LockedMemoryCandidateRow[]>(Prisma.sql`
      SELECT id::text AS id,
             client_id::text AS "clientId",
             proposed_by::text AS "proposedBy",
             source_kind AS "sourceKind",
             scope,
             payload_jsonb AS payload
      FROM memory_candidate
      WHERE tenant_id = ${tenantId}::uuid
        AND id = ${candidateId}::uuid
        AND status = 'pending'
      FOR UPDATE
    `);
    const row = rows[0];
    if (!row) throw new NotFoundException('No pending memory candidate with that id.');
    return row;
  }

  private assertWorkflowMatchesCandidate(
    row: MemoryReviewRequestRow,
    candidate: MemoryReviewWorkflowCandidate,
  ): void {
    if (
      row.tenantId !== candidate.tenantId ||
      row.candidateId !== candidate.id ||
      row.requestedBy !== candidate.proposedByUserId ||
      row.clientId !== candidate.clientId
    ) {
      throw new Error('Memory review workflow identity drift detected.');
    }
  }

  private async auditAssignmentInTx(
    tx: Prisma.TransactionClient,
    actor: { userId: string | null; role: string | null },
    tenantId: string,
    reviewRequestId: string,
    candidateId: string,
    previousReviewerId: string | null,
    assignedReviewerId: string | null,
    kind: 'created' | 'reassigned',
    reason: string | null,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: `memory.review.assignment.${kind}`,
        entityType: 'review_request',
        entityId: reviewRequestId,
        before: { assignedReviewerId: previousReviewerId, candidateId },
        after: {
          assignedReviewerId,
          candidateId,
          ...(reason
            ? {
                reasonHash: createHash('sha256').update(reason).digest('hex'),
                reasonChars: reason.length,
              }
            : {}),
        },
      },
    });
  }
}

function reviewRequestRow(
  value: {
    id: string;
    tenantId: string;
    subjectId: string | null;
    clientId: string | null;
    status: string;
    reason: string;
    requestedBy: string | null;
    assignedTo: string | null;
    decidedBy: string | null;
    decidedAt: Date | null;
    createdAt: Date;
  },
  candidateId: string,
): MemoryReviewRequestRow {
  if (!value.requestedBy) throw new Error('Memory review workflow is missing its proposer.');
  return {
    id: value.id,
    tenantId: value.tenantId,
    candidateId: value.subjectId ?? candidateId,
    clientId: value.clientId,
    status: value.status,
    reason: value.reason,
    requestedBy: value.requestedBy,
    assignedTo: value.assignedTo,
    decidedBy: value.decidedBy,
    decidedAt: value.decidedAt,
    createdAt: value.createdAt,
  };
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function tenantRole(value: string): TenantRole | null {
  return ['capiro_admin', 'user_admin', 'standard_user', 'client_portal_user'].includes(value)
    ? (value as TenantRole)
    : null;
}

function workflowCandidate(
  tenantId: string,
  candidate: LockedMemoryCandidateRow,
): MemoryReviewWorkflowCandidate {
  return {
    id: candidate.id,
    tenantId,
    clientId: candidate.clientId,
    proposedByUserId: candidate.proposedBy,
    sourceKind: candidate.sourceKind,
    scope: candidate.scope,
    candidateKind: candidateKindForSource(candidate.sourceKind),
    title: candidateTitle(candidate.payload),
  };
}

function candidateKindForSource(sourceKind: string): string {
  if (sourceKind === 'memory_correction') return 'correction';
  if (sourceKind === 'memory_restore') return 'restore';
  if (sourceKind === 'memory_contradiction') return 'contradiction';
  return 'standard';
}

function candidateTitle(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Memory proposal';
  const record = payload as Record<string, unknown>;
  const canonical = record.canonicalItem;
  if (canonical && typeof canonical === 'object' && !Array.isArray(canonical)) {
    const title = (canonical as Record<string, unknown>).title;
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  const key = record.key;
  return typeof key === 'string' && key.trim() ? key.trim() : 'Memory proposal';
}
