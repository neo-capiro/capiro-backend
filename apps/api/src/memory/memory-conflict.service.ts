import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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

/**
 * Conflict resolution for governed memory.
 *
 * `conflict_status` / `conflict_group_id` / `controlling_item_id` and the index
 * memory_items_conflict_group_idx have existed since 20260729010000 but NO
 * application code ever wrote them, so meriv2-core's recall filter — which
 * suppresses an `open` conflict with no controlling item
 * (filterGovernedMemory → 'conflict_unresolved') — had no way to ever be satisfied.
 * This is the write side: it names ONE controlling item and marks the rest of the
 * group resolved, in one transaction, with one audit row per row it touches.
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
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw new BadRequestException('A reason is required to resolve a memory conflict.');
    }
    // Authority + ethical wall + legal hold, on BOTH the anchor and the winner —
    // the winner is the row that gains authority, so authorizing only the anchor
    // would let a caller promote an item they may not touch.
    await this.authz.requireItem(ctx, itemId, 'resolve_conflict');
    if (controllingItemId !== itemId) {
      await this.authz.requireItem(ctx, controllingItemId, 'resolve_conflict');
    }

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const anchors = await tx.$queryRaw<
        Array<{ conflict_group_id: string | null; client_id: string | null }>
      >`
        SELECT conflict_group_id::text AS conflict_group_id, client_id::text AS client_id
        FROM memory_items
        WHERE id = ${itemId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        LIMIT 1
      `;
      const anchor = anchors[0];
      if (!anchor) throw new NotFoundException('Memory item not found');
      if (!anchor.conflict_group_id) {
        throw new BadRequestException('This memory item is not part of a conflict group.');
      }
      const groupId = anchor.conflict_group_id;

      // The winner must be in the SAME group. Without this a caller could name any
      // item in the tenant as controlling and the losing rows would point at an
      // unrelated row — which filterGovernedMemory would then read as "resolved".
      const members = await tx.$queryRaw<
        Array<{ id: string; governed_status: string; client_id: string | null }>
      >`
        SELECT id::text AS id, governed_status, client_id::text AS client_id
        FROM memory_items
        WHERE tenant_id = ${ctx.tenantId}::uuid AND conflict_group_id = ${groupId}::uuid
      `;
      if (!members.some((m) => m.id === controllingItemId)) {
        throw new BadRequestException('controllingItemId is not in this conflict group.');
      }

      await tx.$executeRaw`
        UPDATE memory_items
        SET conflict_status = 'controlling', controlling_item_id = ${controllingItemId}::uuid,
            updated_at = now()
        WHERE id = ${controllingItemId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
      `;
      const resolvedCount = await tx.$executeRaw`
        UPDATE memory_items
        SET conflict_status = 'resolved', controlling_item_id = ${controllingItemId}::uuid,
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND conflict_group_id = ${groupId}::uuid
          AND id <> ${controllingItemId}::uuid
      `;

      for (const member of members) {
        await this.transitionAudit.record(tx, ctx.tenantId, {
          subject: { memoryItemId: member.id },
          actorUserId: ctx.userId,
          clientId: member.client_id,
          // conflict_status is a SEPARATE axis from governed_status: resolving a
          // conflict does not move the lifecycle state, so from === to and the
          // state machine is not consulted. Recording the unchanged status keeps
          // the audit row's to_status NOT NULL contract honest rather than
          // inventing a transition that did not happen.
          toStatus: normalizeStatus(member.governed_status),
          reasonCode: 'conflict_resolved',
          reason,
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
