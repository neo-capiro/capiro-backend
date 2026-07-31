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
import { MemoryCandidateReviewService } from './memory-candidate-review.service.js';
import { MemoryStoreService } from './memory-store.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import { memoryGovernanceCenterEnabled } from './memory-governance-center.switch.js';
import { fetchDeniedClientIds, wallExclusionSql } from './memory-wall.helpers.js';

export type MemoryGovernanceBucket =
  | 'all'
  | 'active'
  | 'review_due'
  | 'conflicts'
  | 'history';

interface GovernanceItemRow {
  id: string;
  title: string;
  type: string;
  clientId: string | null;
  clientName: string | null;
  ownerUserId: string | null;
  visibility: string;
  memoryClass: string;
  memoryAuthority: string;
  memoryScope: string;
  governedStatus: string;
  legacyStatus: string;
  reviewState: string;
  confidence: number | null;
  lastConfirmedAt: Date | null;
  reviewDueAt: Date | null;
  validUntil: Date | null;
  expiresAt: Date | null;
  legalHold: boolean;
  conflictStatus: string;
  conflictGroupId: string | null;
  controllingItemId: string | null;
  assertedByUserId: string | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  secondApprovedByUserId: string | null;
  secondApprovedAt: Date | null;
  sourceType: string;
  sourceId: string | null;
  originSurface: string | null;
  updatedAt: Date;
}

interface GovernanceItemDetailRow extends GovernanceItemRow {
  slug: string;
  sections: unknown;
  source: string;
  sourceRef: string | null;
  provenance: string;
  sourceExcerpt: string | null;
  sourceContentHash: string | null;
  sourceVersion: string | null;
  asOf: Date | null;
  effectiveFrom: Date | null;
  reviewCadenceDays: number | null;
  sensitivity: string;
  retentionPolicy: unknown;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  supersedesId: string | null;
  contradictsId: string | null;
  originTraceId: string | null;
  originContextPacketId: string | null;
  originModel: string | null;
  originPromptVersion: string | null;
  instructionsAllowed: boolean;
  createdAt: Date;
}

interface GovernanceVersionRow {
  id: string;
  title: string;
  legacyStatus: string;
  governedStatus: string;
  supersedesId: string | null;
  contradictsId: string | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

interface GovernanceTransitionRow {
  id: string;
  memoryItemId: string | null;
  memoryCandidateId: string | null;
  actorUserId: string | null;
  clientId: string | null;
  fromStatus: string | null;
  toStatus: string;
  reasonCode: string;
  reason: string;
  sourceType: string | null;
  sourceId: string | null;
  proposalId: string | null;
  metadata: unknown;
  createdAt: Date;
}

interface ProjectionJobRow {
  id: string;
  operation: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  deadLetteredAt: Date | null;
  supersededAt: Date | null;
}

interface ConflictMemberRow {
  id: string;
  title: string;
  governedStatus: string;
  conflictStatus: string;
  controllingItemId: string | null;
  updatedAt: Date;
}

interface GovernanceCapabilitySet {
  confirm: boolean;
  markStale: boolean;
  revoke: boolean;
  proposeCorrection: boolean;
  restore: boolean;
  resolveConflict: boolean;
  secondApprove: boolean;
}

const TERMINAL_STATUSES = new Set(['revoked', 'superseded', 'rejected', 'expired']);
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

/**
 * Phase 15 server-owned administration read model and direct item actions.
 *
 * The UI never sends tenant, wall, role, scope, lifecycle, approval, or capability
 * facts. Every read runs under tenant/user RLS and excludes denied client walls.
 * Every mutation reloads and locks the canonical row before authorization.
 */
@Injectable()
export class MemoryGovernanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
    private readonly transitions: MemoryTransitionAuditService,
    private readonly candidates: MemoryCandidateReviewService,
    private readonly store: MemoryStoreService,
  ) {}

  enabled(): boolean {
    return memoryGovernanceCenterEnabled();
  }

  async overview(ctx: TenantContext) {
    if (!this.enabled()) {
      return {
        enabled: false,
        counts: {
          active: 0,
          pendingReview: 0,
          conflicts: 0,
          reviewDue: 0,
          history: 0,
          activeGrants: 0,
          projectionAttention: 0,
        },
      };
    }

    const [counts, pending] = await Promise.all([
      this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
        const itemRows = await tx.$queryRaw<
          Array<{
            active: bigint;
            conflicts: bigint;
            review_due: bigint;
            history: bigint;
          }>
        >(Prisma.sql`
          SELECT
            count(*) FILTER (
              WHERE mi.status = 'active' AND mi.governed_status = 'active'
            ) AS active,
            count(*) FILTER (
              WHERE mi.governed_status = 'conflicted'
                 OR mi.conflict_status IN ('open','controlling')
            ) AS conflicts,
            count(*) FILTER (
              WHERE mi.status = 'active'
                AND (
                  mi.governed_status = 'stale'
                  OR mi.review_due_at <= now()
                  OR (
                    mi.review_cadence_days IS NOT NULL
                    AND mi.review_cadence_days > 0
                    AND COALESCE(mi.last_confirmed_at, mi.created_at)
                        + (mi.review_cadence_days * INTERVAL '1 day') <= now()
                  )
                )
            ) AS review_due,
            count(*) FILTER (
              WHERE mi.status IN ('revoked','superseded')
                 OR mi.governed_status IN ('revoked','superseded','rejected','expired')
            ) AS history
          FROM memory_items mi
          WHERE mi.tenant_id = ${ctx.tenantId}::uuid
            AND (mi.visibility = 'tenant' OR mi.owner_user_id = ${ctx.userId}::uuid)
            ${Prisma.raw(wallExclusionSql(denied, 'mi.client_id'))}
        `);
        const grantRows = await tx.$queryRaw<Array<{ active_grants: bigint }>>(Prisma.sql`
          SELECT count(*) AS active_grants
          FROM memory_access_grant g
          WHERE g.tenant_id = ${ctx.tenantId}::uuid
            AND g.status = 'active'
            AND g.expires_at > now()
            ${Prisma.raw(wallExclusionSql(denied, 'g.client_id'))}
        `);
        const projectionRows = await tx.$queryRaw<
          Array<{ projection_attention: bigint }>
        >(Prisma.sql`
          SELECT count(*) AS projection_attention
          FROM memory_cleanup_outbox o
          LEFT JOIN memory_items mi
            ON mi.id = o.memory_item_id AND mi.tenant_id = o.tenant_id
          LEFT JOIN clio_memory cm
            ON cm.id = o.clio_memory_id AND cm.tenant_id = o.tenant_id
          WHERE o.tenant_id = ${ctx.tenantId}::uuid
            AND o.status IN ('failed','dead_letter')
            ${Prisma.raw(
              wallExclusionSql(denied, 'COALESCE(mi.client_id, cm.client_id)'),
            )}
        `);
        const row = itemRows[0];
        return {
          active: numberOf(row?.active),
          conflicts: numberOf(row?.conflicts),
          reviewDue: numberOf(row?.review_due),
          history: numberOf(row?.history),
          activeGrants: numberOf(grantRows[0]?.active_grants),
          projectionAttention: numberOf(projectionRows[0]?.projection_attention),
        };
      }),
      this.candidates.listReviewable(ctx),
    ]);

    return {
      enabled: true,
      counts: {
        ...counts,
        pendingReview: pending.enabled ? pending.candidates.length : 0,
      },
      reviewEnabled: pending.enabled,
    };
  }

  async listItems(
    ctx: TenantContext,
    bucket: MemoryGovernanceBucket,
    limit = 100,
  ): Promise<{ enabled: boolean; items: Array<ReturnType<typeof presentItem>> }> {
    if (!this.enabled()) return { enabled: false, items: [] };
    const boundedLimit = Math.min(250, Math.max(1, Math.floor(limit)));

    const items = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      const rows = await tx.$queryRaw<GovernanceItemRow[]>(Prisma.sql`
        SELECT mi.id::text AS id,
               mi.title,
               mi.type,
               mi.client_id::text AS "clientId",
               c.name AS "clientName",
               mi.owner_user_id::text AS "ownerUserId",
               mi.visibility,
               mi.memory_class AS "memoryClass",
               mi.memory_authority AS "memoryAuthority",
               mi.memory_scope AS "memoryScope",
               mi.governed_status AS "governedStatus",
               mi.status AS "legacyStatus",
               mi.review_state AS "reviewState",
               mi.confidence,
               mi.last_confirmed_at AS "lastConfirmedAt",
               mi.review_due_at AS "reviewDueAt",
               mi.valid_until AS "validUntil",
               mi.expires_at AS "expiresAt",
               mi.legal_hold AS "legalHold",
               mi.conflict_status AS "conflictStatus",
               mi.conflict_group_id::text AS "conflictGroupId",
               mi.controlling_item_id::text AS "controllingItemId",
               mi.asserted_by_user_id::text AS "assertedByUserId",
               mi.approved_by_user_id::text AS "approvedByUserId",
               mi.approved_at AS "approvedAt",
               mi.second_approved_by_user_id::text AS "secondApprovedByUserId",
               mi.second_approved_at AS "secondApprovedAt",
               mi.source_type AS "sourceType",
               mi.source_id AS "sourceId",
               mi.origin_surface AS "originSurface",
               mi.updated_at AS "updatedAt"
        FROM memory_items mi
        LEFT JOIN clients c ON c.id = mi.client_id AND c.tenant_id = mi.tenant_id
        WHERE mi.tenant_id = ${ctx.tenantId}::uuid
          AND (mi.visibility = 'tenant' OR mi.owner_user_id = ${ctx.userId}::uuid)
          ${bucketPredicate(bucket)}
          ${Prisma.raw(wallExclusionSql(denied, 'mi.client_id'))}
        ORDER BY
          CASE WHEN mi.governed_status = 'conflicted' THEN 0
               WHEN mi.governed_status = 'stale' THEN 1
               ELSE 2 END,
          COALESCE(mi.review_due_at, mi.updated_at) ASC,
          mi.updated_at DESC
        LIMIT ${boundedLimit}
      `);

      const visible: Array<ReturnType<typeof presentItem>> = [];
      for (const row of rows) {
        const subject = await this.authorization.loadItemInTx(tx, ctx.tenantId, row.id);
        if (!subject) continue;
        const read = await this.authorization.evaluateInTx(tx, ctx, subject, 'read');
        if (!read.allowed) continue;
        visible.push(presentItem(row, await this.capabilitiesInTx(tx, ctx, row)));
      }
      return visible;
    });

    return { enabled: true, items };
  }

  async getItem(ctx: TenantContext, itemId: string) {
    this.requireEnabled();
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await tx.$queryRaw<GovernanceItemDetailRow[]>(Prisma.sql`
        SELECT mi.id::text AS id,
               mi.title,
               mi.type,
               mi.slug,
               mi.client_id::text AS "clientId",
               c.name AS "clientName",
               mi.owner_user_id::text AS "ownerUserId",
               mi.visibility,
               mi.sections_jsonb AS sections,
               mi.source,
               mi.source_ref AS "sourceRef",
               mi.provenance,
               mi.source_excerpt AS "sourceExcerpt",
               mi.source_content_hash AS "sourceContentHash",
               mi.source_version AS "sourceVersion",
               mi.memory_class AS "memoryClass",
               mi.memory_authority AS "memoryAuthority",
               mi.memory_scope AS "memoryScope",
               mi.governed_status AS "governedStatus",
               mi.status AS "legacyStatus",
               mi.review_state AS "reviewState",
               mi.confidence,
               mi.last_confirmed_at AS "lastConfirmedAt",
               mi.review_due_at AS "reviewDueAt",
               mi.review_cadence_days AS "reviewCadenceDays",
               mi.as_of AS "asOf",
               mi.effective_from AS "effectiveFrom",
               mi.valid_until AS "validUntil",
               mi.expires_at AS "expiresAt",
               mi.sensitivity,
               mi.retention_policy_jsonb AS "retentionPolicy",
               mi.legal_hold AS "legalHold",
               mi.revoked_at AS "revokedAt",
               mi.revoked_by::text AS "revokedByUserId",
               mi.supersedes_id::text AS "supersedesId",
               mi.contradicts_id::text AS "contradictsId",
               mi.conflict_status AS "conflictStatus",
               mi.conflict_group_id::text AS "conflictGroupId",
               mi.controlling_item_id::text AS "controllingItemId",
               mi.asserted_by_user_id::text AS "assertedByUserId",
               mi.approved_by_user_id::text AS "approvedByUserId",
               mi.approved_at AS "approvedAt",
               mi.second_approved_by_user_id::text AS "secondApprovedByUserId",
               mi.second_approved_at AS "secondApprovedAt",
               mi.source_type AS "sourceType",
               mi.source_id AS "sourceId",
               mi.origin_surface AS "originSurface",
               mi.origin_trace_id AS "originTraceId",
               mi.origin_context_packet_id::text AS "originContextPacketId",
               mi.origin_model AS "originModel",
               mi.origin_prompt_version AS "originPromptVersion",
               mi.instructions_allowed AS "instructionsAllowed",
               mi.created_at AS "createdAt",
               mi.updated_at AS "updatedAt"
        FROM memory_items mi
        LEFT JOIN clients c ON c.id = mi.client_id AND c.tenant_id = mi.tenant_id
        WHERE mi.tenant_id = ${ctx.tenantId}::uuid AND mi.id = ${itemId}::uuid
          AND (mi.visibility = 'tenant' OR mi.owner_user_id = ${ctx.userId}::uuid)
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) throw new NotFoundException('Memory item not found.');
      const subject = await this.authorization.loadItemInTx(tx, ctx.tenantId, itemId);
      if (!subject) throw new NotFoundException('Memory item not found.');
      const read = await this.authorization.evaluateInTx(tx, ctx, subject, 'read');
      if (!read.allowed) throw new ForbiddenException(`Memory operation denied: ${read.reason}`);

      const [versions, transitions, projection, conflicts, actors] = await Promise.all([
        this.versionLineageInTx(tx, ctx.tenantId, itemId),
        this.transitionsForItemInTx(tx, ctx.tenantId, itemId),
        this.projectionJobsForItemInTx(tx, ctx.tenantId, itemId),
        row.conflictGroupId
          ? this.conflictMembersInTx(tx, ctx.tenantId, row.conflictGroupId)
          : Promise.resolve([]),
        this.actorDirectoryInTx(tx, [
          row.ownerUserId,
          row.assertedByUserId,
          row.approvedByUserId,
          row.secondApprovedByUserId,
          row.revokedByUserId,
        ]),
      ]);

      return {
        enabled: true,
        item: {
          ...presentItem(row, await this.capabilitiesInTx(tx, ctx, row)),
          slug: row.slug,
          sections: normalizeSections(row.sections),
          provenance: {
            source: row.source,
            sourceRef: row.sourceRef,
            sourceType: row.sourceType,
            sourceId: row.sourceId,
            sourceExcerpt: row.sourceExcerpt,
            sourceContentHash: row.sourceContentHash,
            sourceVersion: row.sourceVersion,
          },
          temporal: {
            asOf: iso(row.asOf),
            effectiveFrom: iso(row.effectiveFrom),
            validUntil: iso(row.validUntil),
            expiresAt: iso(row.expiresAt),
            lastConfirmedAt: iso(row.lastConfirmedAt),
            reviewDueAt: iso(row.reviewDueAt),
            reviewCadenceDays: row.reviewCadenceDays,
          },
          approvals: {
            assertedByUserId: row.assertedByUserId,
            approvedByUserId: row.approvedByUserId,
            approvedAt: iso(row.approvedAt),
            secondApprovedByUserId: row.secondApprovedByUserId,
            secondApprovedAt: iso(row.secondApprovedAt),
          },
          governance: {
            sensitivity: row.sensitivity,
            retentionPolicy: row.retentionPolicy,
            legalHold: row.legalHold,
            revokedAt: iso(row.revokedAt),
            revokedByUserId: row.revokedByUserId,
          },
          origin: {
            surface: row.originSurface,
            traceId: row.originTraceId,
            contextPacketId: row.originContextPacketId,
            model: row.originModel,
            promptVersion: row.originPromptVersion,
            instructionsAllowed: row.instructionsAllowed,
          },
          actors,
          versions: versions.map(presentVersion),
          transitions: transitions.map(presentTransition),
          projection: projection.map(presentProjectionJob),
          conflictMembers: conflicts.map((member) => ({
            id: member.id,
            title: member.title,
            governedStatus: member.governedStatus,
            conflictStatus: member.conflictStatus,
            controllingItemId: member.controllingItemId,
            updatedAt: member.updatedAt.toISOString(),
          })),
        },
      };
    });
  }

  async listTransitions(ctx: TenantContext, limit = 100) {
    if (!this.enabled()) return { enabled: false, transitions: [] };
    const boundedLimit = Math.min(250, Math.max(1, Math.floor(limit)));
    const rows = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      return tx.$queryRaw<GovernanceTransitionRow[]>(Prisma.sql`
        SELECT a.id::text AS id,
               a.memory_item_id::text AS "memoryItemId",
               a.memory_candidate_id::text AS "memoryCandidateId",
               a.actor_user_id::text AS "actorUserId",
               COALESCE(a.client_id, mi.client_id, mc.client_id)::text AS "clientId",
               a.from_status AS "fromStatus",
               a.to_status AS "toStatus",
               a.reason_code AS "reasonCode",
               a.reason,
               a.source_type AS "sourceType",
               a.source_id AS "sourceId",
               a.proposal_id AS "proposalId",
               a.metadata_jsonb AS metadata,
               a.created_at AS "createdAt"
        FROM memory_transition_audit a
        LEFT JOIN memory_items mi
          ON mi.id = a.memory_item_id AND mi.tenant_id = a.tenant_id
        LEFT JOIN memory_candidate mc
          ON mc.id = a.memory_candidate_id AND mc.tenant_id = a.tenant_id
        WHERE a.tenant_id = ${ctx.tenantId}::uuid
          ${Prisma.raw(
            wallExclusionSql(denied, 'COALESCE(a.client_id, mi.client_id, mc.client_id)'),
          )}
        ORDER BY a.created_at DESC
        LIMIT ${boundedLimit}
      `);
    });
    return { enabled: true, transitions: rows.map(presentTransition) };
  }

  async projectionHealth(ctx: TenantContext) {
    if (!this.enabled()) return { enabled: false, counts: {}, recentFailures: [] };
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      const counts = await tx.$queryRaw<
        Array<{
          pending: bigint;
          running: bigint;
          failed: bigint;
          completed: bigint;
          dead_letter: bigint;
          superseded: bigint;
          oldest_due_at: Date | null;
        }>
      >(Prisma.sql`
        SELECT
          count(*) FILTER (WHERE o.status = 'pending') AS pending,
          count(*) FILTER (WHERE o.status = 'running') AS running,
          count(*) FILTER (WHERE o.status = 'failed') AS failed,
          count(*) FILTER (WHERE o.status = 'completed') AS completed,
          count(*) FILTER (WHERE o.status = 'dead_letter') AS dead_letter,
          count(*) FILTER (WHERE o.status = 'superseded') AS superseded,
          min(o.next_attempt_at) FILTER (
            WHERE o.status IN ('pending','failed')
          ) AS oldest_due_at
        FROM memory_cleanup_outbox o
        LEFT JOIN memory_items mi
          ON mi.id = o.memory_item_id AND mi.tenant_id = o.tenant_id
        LEFT JOIN clio_memory cm
          ON cm.id = o.clio_memory_id AND cm.tenant_id = o.tenant_id
        WHERE o.tenant_id = ${ctx.tenantId}::uuid
          ${Prisma.raw(
            wallExclusionSql(denied, 'COALESCE(mi.client_id, cm.client_id)'),
          )}
      `);
      const failures = await tx.$queryRaw<
        Array<ProjectionJobRow & { memoryItemId: string | null; title: string | null }>
      >(Prisma.sql`
        SELECT o.id::text AS id,
               o.memory_item_id::text AS "memoryItemId",
               mi.title,
               o.operation,
               o.status,
               o.attempts,
               o.next_attempt_at AS "nextAttemptAt",
               o.last_error AS "lastError",
               o.created_at AS "createdAt",
               o.started_at AS "startedAt",
               o.completed_at AS "completedAt",
               o.dead_lettered_at AS "deadLetteredAt",
               o.superseded_at AS "supersededAt"
        FROM memory_cleanup_outbox o
        LEFT JOIN memory_items mi
          ON mi.id = o.memory_item_id AND mi.tenant_id = o.tenant_id
        LEFT JOIN clio_memory cm
          ON cm.id = o.clio_memory_id AND cm.tenant_id = o.tenant_id
        WHERE o.tenant_id = ${ctx.tenantId}::uuid
          AND o.status IN ('failed','dead_letter')
          ${Prisma.raw(
            wallExclusionSql(denied, 'COALESCE(mi.client_id, cm.client_id)'),
          )}
        ORDER BY COALESCE(o.dead_lettered_at, o.next_attempt_at, o.created_at) DESC
        LIMIT 50
      `);
      const row = counts[0];
      return {
        enabled: true,
        counts: {
          pending: numberOf(row?.pending),
          running: numberOf(row?.running),
          failed: numberOf(row?.failed),
          completed: numberOf(row?.completed),
          deadLetter: numberOf(row?.dead_letter),
          superseded: numberOf(row?.superseded),
        },
        oldestDueAt: iso(row?.oldest_due_at),
        recentFailures: failures.map((job) => ({
          ...presentProjectionJob(job),
          memoryItemId: job.memoryItemId,
          title: job.title,
        })),
      };
    });
  }

  async listClients(ctx: TenantContext) {
    if (!this.enabled()) return { enabled: false, clients: [] };
    const clients = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      return tx.$queryRaw<
        Array<{ id: string; name: string; status: string; memoryWall: boolean }>
      >(Prisma.sql`
        SELECT id::text AS id, name, status, memory_wall AS "memoryWall"
        FROM clients
        WHERE tenant_id = ${ctx.tenantId}::uuid
          ${Prisma.raw(wallExclusionSql(denied, 'id'))}
        ORDER BY name ASC
      `);
    });
    return { enabled: true, clients };
  }

  async confirm(ctx: TenantContext, itemId: string) {
    this.requireEnabled();
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await this.lockItemInTx(tx, ctx.tenantId, itemId);
      await this.requireOperationInTx(tx, ctx, itemId, 'confirm');
      const status = normalizeStatus(row.governedStatus);
      const nextStatus: GovernedMemoryStatus = status === 'stale' ? 'active' : status;
      if (status === 'stale') assertMemoryTransition('stale', 'active');

      await tx.$executeRaw`
        UPDATE memory_items
        SET governed_status = ${nextStatus},
            last_confirmed_at = now(),
            review_state = 'confirmed',
            review_due_at = CASE
              WHEN review_cadence_days IS NULL OR review_cadence_days <= 0 THEN NULL
              ELSE now() + (review_cadence_days * INTERVAL '1 day')
            END,
            updated_at = now()
        WHERE id = ${itemId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
      `;
      await this.transitions.record(tx, ctx.tenantId, {
        subject: { memoryItemId: itemId },
        actorUserId: ctx.userId,
        clientId: row.clientId,
        fromStatus: status === 'stale' ? 'stale' : null,
        toStatus: nextStatus,
        reasonCode: 'confirmed',
        reason: 'Memory confirmed from the governance center.',
        metadata: { surface: 'memory_governance_center' },
      });
      return { outcome: 'confirmed' as const, itemId, governedStatus: nextStatus };
    });
  }

  async markStale(ctx: TenantContext, itemId: string, reason: string) {
    this.requireEnabled();
    const cleanReason = reason.trim();
    if (!cleanReason) throw new BadRequestException('A reason is required to mark memory stale.');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await this.lockItemInTx(tx, ctx.tenantId, itemId);
      await this.requireOperationInTx(tx, ctx, itemId, 'mark_stale');
      const status = normalizeStatus(row.governedStatus);
      if (status === 'stale') {
        return { outcome: 'already_stale' as const, itemId, governedStatus: status };
      }
      if (status !== 'active') {
        throw new BadRequestException(`Only active memory can be marked stale; current status is ${status}.`);
      }
      assertMemoryTransition('active', 'stale');
      await tx.$executeRaw`
        UPDATE memory_items
        SET governed_status = 'stale', review_state = 'unreviewed',
            review_due_at = now(), updated_at = now()
        WHERE id = ${itemId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
      `;
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
    const cleanReason = reason.trim();
    if (!cleanReason) throw new BadRequestException('A reason is required to revoke memory.');
    const result = await this.store.forgetMemory(itemId, cleanReason);
    if (!result.found) throw new NotFoundException('Memory item was not found or is not revocable.');
    if (result.blockedByLegalHold) {
      throw new ForbiddenException('Memory operation denied: legal_hold');
    }
    return { outcome: 'revoked' as const, itemId, title: result.title ?? null };
  }

  async secondApprove(ctx: TenantContext, itemId: string) {
    this.requireEnabled();
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await this.lockItemInTx(tx, ctx.tenantId, itemId);
      await this.requireOperationInTx(tx, ctx, itemId, 'approve');
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

      await tx.$executeRaw`
        UPDATE memory_items
        SET second_approved_by_user_id = ${ctx.userId}::uuid,
            second_approved_at = now(), updated_at = now()
        WHERE id = ${itemId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
          AND second_approved_by_user_id IS NULL
      `;
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
    if (!this.enabled()) {
      throw new ServiceUnavailableException(
        'Memory Governance Center is disabled for this environment.',
      );
    }
  }

  private async requireOperationInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    itemId: string,
    operation: 'confirm' | 'mark_stale' | 'approve',
  ): Promise<void> {
    const subject = await this.authorization.loadItemInTx(tx, ctx.tenantId, itemId);
    if (!subject) throw new NotFoundException('Memory item not found.');
    const decision = await this.authorization.evaluateInTx(tx, ctx, subject, operation);
    if (!decision.allowed) throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
  }

  private async lockItemInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    itemId: string,
  ): Promise<{
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
  }> {
    const rows = await tx.$queryRaw<
      Array<{
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
      }>
    >(Prisma.sql`
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

  private async capabilitiesInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    row: GovernanceItemRow,
  ): Promise<GovernanceCapabilitySet> {
    const subject = await this.authorization.loadItemInTx(tx, ctx.tenantId, row.id);
    if (!subject) return emptyCapabilities();
    const [confirm, stale, revoke, propose, resolve, approve, read] = await Promise.all([
      this.authorization.evaluateInTx(tx, ctx, subject, 'confirm'),
      this.authorization.evaluateInTx(tx, ctx, subject, 'mark_stale'),
      this.authorization.evaluateInTx(tx, ctx, subject, 'revoke'),
      this.authorization.evaluateInTx(tx, ctx, subject, 'propose'),
      this.authorization.evaluateInTx(tx, ctx, subject, 'resolve_conflict'),
      this.authorization.evaluateInTx(tx, ctx, subject, 'approve'),
      this.authorization.evaluateInTx(tx, ctx, subject, 'read'),
    ]);
    const terminal = TERMINAL_STATUSES.has(row.governedStatus) ||
      ['revoked', 'superseded'].includes(row.legacyStatus);
    return {
      confirm: confirm.allowed && ['active', 'stale', 'conflicted'].includes(row.governedStatus),
      markStale: stale.allowed && row.governedStatus === 'active',
      revoke: revoke.allowed && !terminal && !row.legalHold,
      proposeCorrection: propose.allowed && !terminal,
      restore: read.allowed && terminal,
      resolveConflict:
        resolve.allowed &&
        Boolean(row.conflictGroupId) &&
        ['open', 'controlling'].includes(row.conflictStatus),
      secondApprove:
        approve.allowed &&
        row.memoryScope !== 'user_private' &&
        Boolean(row.approvedByUserId) &&
        !row.secondApprovedByUserId &&
        row.assertedByUserId !== ctx.userId &&
        row.approvedByUserId !== ctx.userId &&
        ['active', 'stale', 'conflicted'].includes(row.governedStatus),
    };
  }

  private async versionLineageInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    itemId: string,
  ): Promise<GovernanceVersionRow[]> {
    return tx.$queryRaw<GovernanceVersionRow[]>(Prisma.sql`
      WITH RECURSIVE ancestors AS (
        SELECT id, supersedes_id
        FROM memory_items
        WHERE tenant_id = ${tenantId}::uuid AND id = ${itemId}::uuid
        UNION ALL
        SELECT parent.id, parent.supersedes_id
        FROM memory_items parent
        JOIN ancestors child ON child.supersedes_id = parent.id
        WHERE parent.tenant_id = ${tenantId}::uuid
      ),
      descendants AS (
        SELECT id
        FROM memory_items
        WHERE tenant_id = ${tenantId}::uuid AND id = ${itemId}::uuid
        UNION ALL
        SELECT child.id
        FROM memory_items child
        JOIN descendants parent ON child.supersedes_id = parent.id
        WHERE child.tenant_id = ${tenantId}::uuid
      ),
      lineage_ids AS (
        SELECT id FROM ancestors
        UNION
        SELECT id FROM descendants
      )
      SELECT mi.id::text AS id,
             mi.title,
             mi.status AS "legacyStatus",
             mi.governed_status AS "governedStatus",
             mi.supersedes_id::text AS "supersedesId",
             mi.contradicts_id::text AS "contradictsId",
             mi.approved_by_user_id::text AS "approvedByUserId",
             mi.approved_at AS "approvedAt",
             mi.created_at AS "createdAt"
      FROM memory_items mi
      JOIN lineage_ids li ON li.id = mi.id
      WHERE mi.tenant_id = ${tenantId}::uuid
      ORDER BY mi.created_at DESC, mi.id DESC
      LIMIT 100
    `);
  }

  private async transitionsForItemInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    itemId: string,
  ): Promise<GovernanceTransitionRow[]> {
    return tx.$queryRaw<GovernanceTransitionRow[]>(Prisma.sql`
      SELECT id::text AS id,
             memory_item_id::text AS "memoryItemId",
             memory_candidate_id::text AS "memoryCandidateId",
             actor_user_id::text AS "actorUserId",
             client_id::text AS "clientId",
             from_status AS "fromStatus",
             to_status AS "toStatus",
             reason_code AS "reasonCode",
             reason,
             source_type AS "sourceType",
             source_id AS "sourceId",
             proposal_id AS "proposalId",
             metadata_jsonb AS metadata,
             created_at AS "createdAt"
      FROM memory_transition_audit
      WHERE tenant_id = ${tenantId}::uuid AND memory_item_id = ${itemId}::uuid
      ORDER BY created_at DESC
      LIMIT 100
    `);
  }

  private async projectionJobsForItemInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    itemId: string,
  ): Promise<ProjectionJobRow[]> {
    return tx.$queryRaw<ProjectionJobRow[]>(Prisma.sql`
      SELECT id::text AS id,
             operation,
             status,
             attempts,
             next_attempt_at AS "nextAttemptAt",
             last_error AS "lastError",
             created_at AS "createdAt",
             started_at AS "startedAt",
             completed_at AS "completedAt",
             dead_lettered_at AS "deadLetteredAt",
             superseded_at AS "supersededAt"
      FROM memory_cleanup_outbox
      WHERE tenant_id = ${tenantId}::uuid AND memory_item_id = ${itemId}::uuid
      ORDER BY created_at DESC
      LIMIT 20
    `);
  }

  private async conflictMembersInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    conflictGroupId: string,
  ): Promise<ConflictMemberRow[]> {
    return tx.$queryRaw<ConflictMemberRow[]>(Prisma.sql`
      SELECT id::text AS id,
             title,
             governed_status AS "governedStatus",
             conflict_status AS "conflictStatus",
             controlling_item_id::text AS "controllingItemId",
             updated_at AS "updatedAt"
      FROM memory_items
      WHERE tenant_id = ${tenantId}::uuid
        AND conflict_group_id = ${conflictGroupId}::uuid
      ORDER BY created_at ASC
    `);
  }

  private async actorDirectoryInTx(
    tx: Prisma.TransactionClient,
    ids: Array<string | null>,
  ): Promise<Record<string, { name: string; email: string }>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) return {};
    const rows = await tx.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    return Object.fromEntries(
      rows.map((user) => [
        user.id,
        {
          name:
            [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email,
          email: user.email,
        },
      ]),
    );
  }
}

function bucketPredicate(bucket: MemoryGovernanceBucket): Prisma.Sql {
  switch (bucket) {
    case 'active':
      return Prisma.sql`AND mi.status = 'active' AND mi.governed_status = 'active'`;
    case 'review_due':
      return Prisma.sql`
        AND mi.status = 'active'
        AND (
          mi.governed_status = 'stale'
          OR mi.review_due_at <= now()
          OR (
            mi.review_cadence_days IS NOT NULL
            AND mi.review_cadence_days > 0
            AND COALESCE(mi.last_confirmed_at, mi.created_at)
                + (mi.review_cadence_days * INTERVAL '1 day') <= now()
          )
        )
      `;
    case 'conflicts':
      return Prisma.sql`
        AND (
          mi.governed_status = 'conflicted'
          OR mi.conflict_status IN ('open','controlling')
        )
      `;
    case 'history':
      return Prisma.sql`
        AND (
          mi.status IN ('revoked','superseded')
          OR mi.governed_status IN ('revoked','superseded','rejected','expired')
        )
      `;
    default:
      return Prisma.empty;
  }
}

function presentItem(row: GovernanceItemRow, capabilities: GovernanceCapabilitySet) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    clientId: row.clientId,
    clientName: row.clientName,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    memoryClass: row.memoryClass,
    memoryAuthority: row.memoryAuthority,
    memoryScope: row.memoryScope,
    governedStatus: row.governedStatus,
    legacyStatus: row.legacyStatus,
    reviewState: row.reviewState,
    confidence: row.confidence,
    lastConfirmedAt: iso(row.lastConfirmedAt),
    reviewDueAt: iso(row.reviewDueAt),
    validUntil: iso(row.validUntil),
    expiresAt: iso(row.expiresAt),
    legalHold: row.legalHold,
    conflictStatus: row.conflictStatus,
    conflictGroupId: row.conflictGroupId,
    controllingItemId: row.controllingItemId,
    assertedByUserId: row.assertedByUserId,
    approvedByUserId: row.approvedByUserId,
    approvedAt: iso(row.approvedAt),
    secondApprovedByUserId: row.secondApprovedByUserId,
    secondApprovedAt: iso(row.secondApprovedAt),
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    originSurface: row.originSurface,
    updatedAt: row.updatedAt.toISOString(),
    capabilities,
  };
}

function presentVersion(row: GovernanceVersionRow) {
  return {
    id: row.id,
    title: row.title,
    legacyStatus: row.legacyStatus,
    governedStatus: row.governedStatus,
    supersedesId: row.supersedesId,
    contradictsId: row.contradictsId,
    approvedByUserId: row.approvedByUserId,
    approvedAt: iso(row.approvedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function presentTransition(row: GovernanceTransitionRow) {
  return {
    id: row.id,
    memoryItemId: row.memoryItemId,
    memoryCandidateId: row.memoryCandidateId,
    actorUserId: row.actorUserId,
    clientId: row.clientId,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    reasonCode: row.reasonCode,
    reason: row.reason,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    proposalId: row.proposalId,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

function presentProjectionJob(row: ProjectionJobRow) {
  return {
    id: row.id,
    operation: row.operation,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    deadLetteredAt: iso(row.deadLetteredAt),
    supersededAt: iso(row.supersededAt),
  };
}

function normalizeSections(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeStatus(value: string): GovernedMemoryStatus {
  return (KNOWN_STATUSES.has(value) ? value : 'pending_review') as GovernedMemoryStatus;
}

function emptyCapabilities(): GovernanceCapabilitySet {
  return {
    confirm: false,
    markStale: false,
    revoke: false,
    proposeCorrection: false,
    restore: false,
    resolveConflict: false,
    secondApprove: false,
  };
}

function numberOf(value: bigint | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
