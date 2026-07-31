import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  assertMemoryTransition,
  type GovernedMemoryStatus,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { memoryGovernanceCenterEnabled } from './memory-governance-center.switch.js';
import { MemoryStoreService } from './memory-store.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';

interface LockedItem {
  id: string;
  title: string;
  clientId: string | null;
  governedStatus: string;
  memoryScope: string;
  assertedByUserId: string | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  secondApprovedByUserId: string | null;
  secondApprovedAt: Date | null;
}

const KNOWN_STATUSES = new Set([
  'suggested',
  'pending_review',
  'active',
  'stale',
  'conflicted',
  'superseded',
  'revoked',
  'rejected',
  'expired',
]);

/** Direct governed item actions exposed by the Phase 15 administration center. */
@Injectable()
export class MemoryGovernanceActionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
    private readonly transitions: MemoryTransitionAuditService,
    private readonly store: MemoryStoreService,
  ) {}

  async confirm(ctx: TenantContext, itemId: string) {
    this.requireEnabled();
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await this.lockItem(tx, ctx.tenantId, itemId);
      await this.requireOperation(tx, ctx, itemId, 'confirm');
      const status = normalizeStatus(row.governedStatus);
      if (!['active', 'stale', 'conflicted'].includes(status)) {
        throw new BadRequestException(`Memory in ${status} status cannot be confirmed.`);
      }
      const target: GovernedMemoryStatus = status === 'stale' ? 'active' : status;
      if (status === 'stale') assertMemoryTransition('stale', 'active');

      const changed = await tx.$executeRaw`
        UPDATE memory_items
        SET governed_status = ${target},
            last_confirmed_at = now(),
            review_state = 'confirmed',
            review_due_at = CASE
              WHEN review_cadence_days IS NULL OR review_cadence_days <= 0 THEN NULL
              ELSE now() + (review_cadence_days * INTERVAL '1 day')
            END,
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${itemId}::uuid
      `;
      if (changed !== 1) throw new Error('Memory confirmation was not atomic.');

      await this.transitions.record(tx, ctx.tenantId, {
        subject: { memoryItemId: itemId },
        actorUserId: ctx.userId,
        clientId: row.clientId,
        fromStatus: status === 'stale' ? 'stale' : null,
        toStatus: target,
        reasonCode: 'confirmed',
        reason: 'Memory confirmed from the Governance Center.',
        metadata: { surface: 'memory_governance_center' },
      });
      return { outcome: 'confirmed' as const, itemId, governedStatus: target };
    });
  }

  async markStale(ctx: TenantContext, itemId: string, reason: string) {
    this.requireEnabled();
    const cleanReason = requiredReason(reason, 'A reason is required to mark memory stale.');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await this.lockItem(tx, ctx.tenantId, itemId);
      await this.requireOperation(tx, ctx, itemId, 'mark_stale');
      const status = normalizeStatus(row.governedStatus);
      if (status === 'stale') {
        return { outcome: 'already_stale' as const, itemId, governedStatus: status };
      }
      if (status !== 'active') {
        throw new BadRequestException(`Only active memory can be marked stale; current status is ${status}.`);
      }
      assertMemoryTransition('active', 'stale');

      const changed = await tx.$executeRaw`
        UPDATE memory_items
        SET governed_status = 'stale',
            review_state = 'unreviewed',
            review_due_at = now(),
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${itemId}::uuid
          AND governed_status = 'active'
      `;
      if (changed !== 1) throw new Error('Memory stale transition was not atomic.');

      await this.transitions.record(tx, ctx.tenantId, {
        subject: { memoryItemId: itemId },
        actorUserId: ctx.userId,
        clientId: row.clientId,
        fromStatus: 'active',
        toStatus: 'stale',
        reasonCode: 'review_overdue',
        reason: cleanReason,
        metadata: { surface: 'memory_governance_center', manual: true },
      });
      return { outcome: 'marked_stale' as const, itemId, governedStatus: 'stale' as const };
    });
  }

  async revoke(ctx: TenantContext, itemId: string, reason: string) {
    this.requireEnabled();
    const cleanReason = requiredReason(reason, 'A reason is required to revoke memory.');

    // MemoryStoreService is the canonical revocation owner. It repeats authorization
    // in its own row-scoped transaction, writes both lifecycle axes and evidence,
    // removes live recall projections, and enqueues retryable cleanup.
    const result = await this.store.forgetMemory(itemId, cleanReason);
    if (!result.found) {
      throw new NotFoundException('Memory item was not found or is not revocable.');
    }
    if (result.blockedByLegalHold) {
      throw new ForbiddenException('Memory operation denied: legal_hold');
    }
    return {
      outcome: 'revoked' as const,
      itemId,
      title: result.title ?? null,
      actorUserId: ctx.userId,
    };
  }

  async secondApprove(ctx: TenantContext, itemId: string) {
    this.requireEnabled();
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await this.lockItem(tx, ctx.tenantId, itemId);
      await this.requireOperation(tx, ctx, itemId, 'approve');
      const status = normalizeStatus(row.governedStatus);
      if (!['active', 'stale', 'conflicted'].includes(status)) {
        throw new BadRequestException('Second approval is available only for recallable memory.');
      }
      if (row.memoryScope === 'user_private') {
        throw new BadRequestException('Private memory does not require a second approval.');
      }
      if (!row.approvedByUserId || !row.approvedAt) {
        throw new BadRequestException('The first approval must be recorded before second approval.');
      }
      if (row.assertedByUserId === ctx.userId || row.approvedByUserId === ctx.userId) {
        throw new ForbiddenException(
          'Second approval must come from someone other than the proposer and first approver.',
        );
      }
      if (row.secondApprovedByUserId) {
        return {
          outcome: 'already_second_approved' as const,
          itemId,
          secondApprovedByUserId: row.secondApprovedByUserId,
          secondApprovedAt: iso(row.secondApprovedAt),
        };
      }

      const changed = await tx.$executeRaw`
        UPDATE memory_items
        SET second_approved_by_user_id = ${ctx.userId}::uuid,
            second_approved_at = now(),
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${itemId}::uuid
          AND second_approved_by_user_id IS NULL
      `;
      if (changed !== 1) throw new Error('Memory second approval was not atomic.');

      await this.transitions.record(tx, ctx.tenantId, {
        subject: { memoryItemId: itemId },
        actorUserId: ctx.userId,
        clientId: row.clientId,
        toStatus: status,
        reasonCode: 'approved',
        reason: 'Independent second approval recorded.',
        metadata: { surface: 'memory_governance_center', approvalStage: 2 },
      });
      return {
        outcome: 'second_approved' as const,
        itemId,
        secondApprovedByUserId: ctx.userId,
      };
    });
  }

  private requireEnabled(): void {
    if (!memoryGovernanceCenterEnabled()) {
      throw new ServiceUnavailableException(
        'Memory Governance Center is disabled for this environment.',
      );
    }
  }

  private async requireOperation(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    itemId: string,
    operation: 'confirm' | 'mark_stale' | 'approve',
  ): Promise<void> {
    const subject = await this.authorization.loadItemInTx(tx, ctx.tenantId, itemId);
    if (!subject) throw new NotFoundException('Memory item not found.');
    const decision = await this.authorization.evaluateInTx(tx, ctx, subject, operation);
    if (!decision.allowed) {
      throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
    }
  }

  private async lockItem(
    tx: Prisma.TransactionClient,
    tenantId: string,
    itemId: string,
  ): Promise<LockedItem> {
    const rows = await tx.$queryRaw<LockedItem[]>(Prisma.sql`
      SELECT id::text AS id,
             title,
             client_id::text AS "clientId",
             governed_status AS "governedStatus",
             memory_scope AS "memoryScope",
             asserted_by_user_id::text AS "assertedByUserId",
             approved_by_user_id::text AS "approvedByUserId",
             approved_at AS "approvedAt",
             second_approved_by_user_id::text AS "secondApprovedByUserId",
             second_approved_at AS "secondApprovedAt"
      FROM memory_items
      WHERE tenant_id = ${tenantId}::uuid AND id = ${itemId}::uuid
      FOR UPDATE
    `);
    const row = rows[0];
    if (!row) throw new NotFoundException('Memory item not found.');
    return row;
  }
}

function normalizeStatus(value: string): GovernedMemoryStatus {
  return (KNOWN_STATUSES.has(value) ? value : 'pending_review') as GovernedMemoryStatus;
}

function requiredReason(value: string, message: string): string {
  const reason = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!reason) throw new BadRequestException(message);
  return reason.slice(0, 500);
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
