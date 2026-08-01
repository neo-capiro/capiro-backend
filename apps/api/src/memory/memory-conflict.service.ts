import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import type { GovernedMemoryStatus } from '@capiro/meriv2-core';

export interface ConflictResolutionResult {
  conflictGroupId: string;
  controllingItemId: string;
  /** Rows moved to conflict_status='resolved' (the losing side of the group). */
  resolvedCount: number;
}

interface ConflictMember {
  id: string;
  governed_status: string;
  client_id: string | null;
}

/**
 * Conflict resolution for governed memory.
 *
 * The complete group is locked in stable ID order before authorization or mutation.
 * This keeps ethical-wall/grant decisions, the controlling selection, both sides of
 * the update, and immutable evidence in one transaction and prevents two reviewers
 * from mutating an unlocked group concurrently.
 */
@Injectable()
export class MemoryConflictService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: MemoryAuthorizationService,
    private readonly transitionAudit: MemoryTransitionAuditService,
  ) {}

  async resolve(
    ctx: TenantContext,
    itemId: string,
    controllingItemId: string,
    reason: string,
  ): Promise<ConflictResolutionResult> {
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    if (!cleanReason) {
      throw new BadRequestException('A reason is required to resolve a memory conflict.');
    }

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      // Discover the group without taking an anchor-first lock. Every resolver then
      // locks the complete group in the same ID order, avoiding opposite-anchor
      // deadlocks while still rechecking membership under the locks.
      const anchors = await tx.$queryRaw<Array<{ conflict_group_id: string | null }>>`
        SELECT conflict_group_id::text AS conflict_group_id
        FROM memory_items
        WHERE id = ${itemId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        LIMIT 1
      `;
      const groupId = anchors[0]?.conflict_group_id;
      if (!anchors[0]) throw new NotFoundException('Memory item not found');
      if (!groupId) {
        throw new BadRequestException('This memory item is not part of a conflict group.');
      }

      const members = await tx.$queryRaw<ConflictMember[]>`
        SELECT id::text AS id, governed_status, client_id::text AS client_id
        FROM memory_items
        WHERE tenant_id = ${ctx.tenantId}::uuid AND conflict_group_id = ${groupId}::uuid
        ORDER BY id
        FOR UPDATE
      `;
      if (!members.some((member) => member.id === itemId)) {
        throw new BadRequestException('The anchor is no longer in this conflict group.');
      }
      if (!members.some((member) => member.id === controllingItemId)) {
        throw new BadRequestException('controllingItemId is not in this conflict group.');
      }

      // Every row is touched by the resolution, not only the anchor and winner.
      // Re-evaluate canonical authorization after the locks so a wall/grant change
      // cannot race the mutation and a corrupted cross-client group fails closed.
      for (const member of members) {
        const subject = await this.authz.loadItemInTx(tx, ctx.tenantId, member.id);
        if (!subject) throw new NotFoundException('Memory item not found');
        const decision = await this.authz.evaluateInTx(tx, ctx, subject, 'resolve_conflict');
        if (!decision.allowed) {
          throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
        }
      }

      const controllingChanged = await tx.$executeRaw`
        UPDATE memory_items
        SET conflict_status = 'controlling', controlling_item_id = ${controllingItemId}::uuid,
            updated_at = now()
        WHERE id = ${controllingItemId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
          AND conflict_group_id = ${groupId}::uuid
      `;
      if (controllingChanged !== 1) {
        throw new Error('Conflict controlling-item update was not atomic.');
      }

      const resolvedCount = await tx.$executeRaw`
        UPDATE memory_items
        SET conflict_status = 'resolved', controlling_item_id = ${controllingItemId}::uuid,
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND conflict_group_id = ${groupId}::uuid
          AND id <> ${controllingItemId}::uuid
      `;
      if (resolvedCount !== members.length - 1) {
        throw new Error('Conflict group changed while resolution was in progress.');
      }

      for (const member of members) {
        await this.transitionAudit.record(tx, ctx.tenantId, {
          subject: { memoryItemId: member.id },
          actorUserId: ctx.userId,
          clientId: member.client_id,
          // conflict_status is a separate axis from governed_status. Record the
          // unchanged lifecycle state rather than inventing a lifecycle transition.
          toStatus: normalizeStatus(member.governed_status),
          reasonCode: 'conflict_resolved',
          reason: cleanReason,
          metadata: {
            conflictGroupId: groupId,
            controllingItemId,
            outcome: member.id === controllingItemId ? 'controlling' : 'resolved',
          },
        });
      }

      return { conflictGroupId: groupId, controllingItemId, resolvedCount };
    });
  }
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

function normalizeStatus(value: string): GovernedMemoryStatus {
  return (KNOWN_STATUSES.has(value) ? value : 'pending_review') as GovernedMemoryStatus;
}
