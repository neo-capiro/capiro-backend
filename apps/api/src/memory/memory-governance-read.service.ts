import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryCandidateReviewService } from './memory-candidate-review.service.js';
import { memoryGovernanceCenterEnabled } from './memory-governance-center.switch.js';
import { fetchDeniedClientIds, wallExclusionSql } from './memory-wall.helpers.js';

export type MemoryGovernanceBucket = 'all' | 'active' | 'review_due' | 'conflicts' | 'history';

interface ItemRow {
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

interface ItemDetailRow extends ItemRow {
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

interface VersionRow {
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

interface TransitionRow {
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
  occurredAt: Date;
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

export interface GovernanceCapabilities {
  confirm: boolean;
  markStale: boolean;
  revoke: boolean;
  proposeCorrection: boolean;
  restore: boolean;
  resolveConflict: boolean;
  secondApprove: boolean;
}

const TERMINAL = new Set(['revoked', 'superseded', 'rejected', 'expired']);

/**
 * Read-only administration projection for Phase 15.
 *
 * Every query executes under tenant/user context and applies the client wall before
 * a row can leave the service. Capabilities are evaluated from server-owned facts;
 * the browser receives them only as display hints and never as execution authority.
 */
@Injectable()
export class MemoryGovernanceReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
    private readonly candidates: MemoryCandidateReviewService,
  ) {}

  async overview(ctx: TenantContext) {
    if (!memoryGovernanceCenterEnabled()) return disabledOverview();

    const counts = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      const itemRows = await tx.$queryRaw<
        Array<{
          active: bigint;
          conflicts: bigint;
          reviewDue: bigint;
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
          ) AS "reviewDue",
          count(*) FILTER (
            WHERE mi.status IN ('revoked','superseded')
               OR mi.governed_status IN ('revoked','superseded','rejected','expired')
          ) AS history
        FROM memory_items mi
        WHERE mi.tenant_id = ${ctx.tenantId}::uuid
          AND (mi.visibility = 'tenant' OR mi.owner_user_id = ${ctx.userId}::uuid)
          ${Prisma.raw(wallExclusionSql(denied, 'mi.client_id'))}
      `);
      const grantRows = await tx.$queryRaw<Array<{ activeGrants: bigint }>>(Prisma.sql`
        SELECT count(*) AS "activeGrants"
        FROM memory_access_grant g
        WHERE g.tenant_id = ${ctx.tenantId}::uuid
          AND g.status = 'active'
          AND g.expires_at > now()
          ${Prisma.raw(wallExclusionSql(denied, 'g.client_id'))}
      `);
      const projectionRows = await tx.$queryRaw<Array<{ projectionAttention: bigint }>>(Prisma.sql`
        SELECT count(*) AS "projectionAttention"
        FROM memory_cleanup_outbox o
        LEFT JOIN memory_items mi
          ON mi.id = o.memory_item_id AND mi.tenant_id = o.tenant_id
        LEFT JOIN clio_memory cm
          ON cm.id = o.clio_memory_id AND cm.tenant_id = o.tenant_id
        WHERE o.tenant_id = ${ctx.tenantId}::uuid
          AND o.status IN ('failed','dead_letter')
          ${privateProjectionSql(ctx.userId)}
          ${Prisma.raw(wallExclusionSql(denied, 'COALESCE(mi.client_id, cm.client_id)'))}
      `);
      const item = itemRows[0];
      return {
        active: count(item?.active),
        conflicts: count(item?.conflicts),
        reviewDue: count(item?.reviewDue),
        history: count(item?.history),
        activeGrants: count(grantRows[0]?.activeGrants),
        projectionAttention: count(projectionRows[0]?.projectionAttention),
      };
    });

    const review = await this.candidates.listReviewable(ctx);
    return {
      enabled: true,
      counts: {
        ...counts,
        pendingReview: review.enabled ? review.candidates.length : 0,
      },
      reviewEnabled: review.enabled,
    };
  }

  async listItems(ctx: TenantContext, bucket: MemoryGovernanceBucket, limit = 100) {
    if (!memoryGovernanceCenterEnabled()) return { enabled: false, items: [] };
    const bounded = Math.min(250, Math.max(1, Math.floor(limit)));

    const items = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      const rows = await tx.$queryRaw<ItemRow[]>(Prisma.sql`
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
          ${bucketSql(bucket)}
          ${Prisma.raw(wallExclusionSql(denied, 'mi.client_id'))}
        ORDER BY
          CASE WHEN mi.governed_status = 'conflicted' THEN 0
               WHEN mi.governed_status = 'stale' THEN 1
               ELSE 2 END,
          COALESCE(mi.review_due_at, mi.updated_at) ASC,
          mi.updated_at DESC
        LIMIT ${bounded}
      `);

      const visible = [];
      for (const row of rows) {
        const subject = await this.authorization.loadItemInTx(tx, ctx.tenantId, row.id);
        if (!subject) continue;
        const decision = await this.authorization.evaluateInTx(tx, ctx, subject, 'read');
        if (!decision.allowed) continue;
        visible.push(presentItem(row, await this.capabilities(tx, ctx, row)));
      }
      return visible;
    });

    return { enabled: true, items };
  }

  async getItem(ctx: TenantContext, itemId: string) {
    if (!memoryGovernanceCenterEnabled()) return { enabled: false, item: null };

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await tx.$queryRaw<ItemDetailRow[]>(Prisma.sql`
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
        WHERE mi.tenant_id = ${ctx.tenantId}::uuid
          AND mi.id = ${itemId}::uuid
          AND (mi.visibility = 'tenant' OR mi.owner_user_id = ${ctx.userId}::uuid)
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) throw new NotFoundException('Memory item not found.');

      const subject = await this.authorization.loadItemInTx(tx, ctx.tenantId, itemId);
      if (!subject) throw new NotFoundException('Memory item not found.');
      const read = await this.authorization.evaluateInTx(tx, ctx, subject, 'read');
      if (!read.allowed) throw new ForbiddenException(`Memory operation denied: ${read.reason}`);

      const versions = await this.versionLineage(tx, ctx.tenantId, itemId);
      const transitions = await this.itemTransitions(tx, ctx.tenantId, itemId);
      const projection = await this.itemProjection(tx, ctx.tenantId, itemId);
      const conflicts = row.conflictGroupId
        ? await this.conflictMembers(tx, ctx.tenantId, row.conflictGroupId)
        : [];
      const actors = await this.actorDirectory(tx, [
        row.ownerUserId,
        row.assertedByUserId,
        row.approvedByUserId,
        row.secondApprovedByUserId,
        row.revokedByUserId,
      ]);
      const capabilities = await this.capabilities(tx, ctx, row);

      return {
        enabled: true,
        item: {
          ...presentItem(row, capabilities),
          slug: row.slug,
          sections: Array.isArray(row.sections) ? row.sections : [],
          provenance: {
            source: row.source,
            sourceRef: row.sourceRef,
            provenance: row.provenance,
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
          projection: projection.map(presentProjection),
          conflictMembers: conflicts.map((member) => ({
            id: member.id,
            title: member.title,
            governedStatus: member.governedStatus,
            conflictStatus: member.conflictStatus,
            controllingItemId: member.controllingItemId,
            updatedAt: member.updatedAt.toISOString(),
          })),
          createdAt: row.createdAt.toISOString(),
        },
      };
    });
  }

  async listTransitions(ctx: TenantContext, limit = 100) {
    if (!memoryGovernanceCenterEnabled()) return { enabled: false, transitions: [] };
    const bounded = Math.min(250, Math.max(1, Math.floor(limit)));

    const rows = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      return tx.$queryRaw<TransitionRow[]>(Prisma.sql`
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
               a.proposal_id::text AS "proposalId",
               a.metadata_jsonb AS metadata,
               a.occurred_at AS "occurredAt"
        FROM memory_transition_audit a
        LEFT JOIN memory_items mi
          ON mi.id = a.memory_item_id AND mi.tenant_id = a.tenant_id
        LEFT JOIN memory_candidate mc
          ON mc.id = a.memory_candidate_id AND mc.tenant_id = a.tenant_id
        WHERE a.tenant_id = ${ctx.tenantId}::uuid
          ${privateTransitionSql(ctx.userId)}
          ${Prisma.raw(
            wallExclusionSql(denied, 'COALESCE(a.client_id, mi.client_id, mc.client_id)'),
          )}
        ORDER BY a.occurred_at DESC
        LIMIT ${bounded}
      `);
    });
    return { enabled: true, transitions: rows.map(presentTransition) };
  }

  async projectionHealth(ctx: TenantContext) {
    if (!memoryGovernanceCenterEnabled()) {
      return {
        enabled: false,
        counts: emptyProjectionCounts(),
        oldestDueAt: null,
        recentFailures: [],
      };
    }

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      const counts = await tx.$queryRaw<
        Array<{
          pending: bigint;
          running: bigint;
          failed: bigint;
          completed: bigint;
          deadLetter: bigint;
          superseded: bigint;
          oldestDueAt: Date | null;
        }>
      >(Prisma.sql`
        SELECT count(*) FILTER (WHERE o.status = 'pending') AS pending,
               count(*) FILTER (WHERE o.status = 'running') AS running,
               count(*) FILTER (WHERE o.status = 'failed') AS failed,
               count(*) FILTER (WHERE o.status = 'completed') AS completed,
               count(*) FILTER (WHERE o.status = 'dead_letter') AS "deadLetter",
               count(*) FILTER (WHERE o.status = 'superseded') AS superseded,
               min(o.next_attempt_at) FILTER (
                 WHERE o.status IN ('pending','failed')
               ) AS "oldestDueAt"
        FROM memory_cleanup_outbox o
        LEFT JOIN memory_items mi
          ON mi.id = o.memory_item_id AND mi.tenant_id = o.tenant_id
        LEFT JOIN clio_memory cm
          ON cm.id = o.clio_memory_id AND cm.tenant_id = o.tenant_id
        WHERE o.tenant_id = ${ctx.tenantId}::uuid
          ${privateProjectionSql(ctx.userId)}
          ${Prisma.raw(wallExclusionSql(denied, 'COALESCE(mi.client_id, cm.client_id)'))}
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
          ${privateProjectionSql(ctx.userId)}
          ${Prisma.raw(wallExclusionSql(denied, 'COALESCE(mi.client_id, cm.client_id)'))}
        ORDER BY COALESCE(o.dead_lettered_at, o.next_attempt_at, o.created_at) DESC
        LIMIT 50
      `);
      const row = counts[0];
      return {
        enabled: true,
        counts: {
          pending: count(row?.pending),
          running: count(row?.running),
          failed: count(row?.failed),
          completed: count(row?.completed),
          deadLetter: count(row?.deadLetter),
          superseded: count(row?.superseded),
        },
        oldestDueAt: iso(row?.oldestDueAt),
        recentFailures: failures.map((job) => ({
          ...presentProjection(job),
          memoryItemId: job.memoryItemId,
          title: job.title,
        })),
      };
    });
  }

  async listClients(ctx: TenantContext) {
    if (!memoryGovernanceCenterEnabled()) return { enabled: false, clients: [] };
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

  private async capabilities(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    row: ItemRow,
  ): Promise<GovernanceCapabilities> {
    const subject = await this.authorization.loadItemInTx(tx, ctx.tenantId, row.id);
    if (!subject) return noCapabilities();

    const confirm = await this.authorization.evaluateInTx(tx, ctx, subject, 'confirm');
    const stale = await this.authorization.evaluateInTx(tx, ctx, subject, 'mark_stale');
    const revoke = await this.authorization.evaluateInTx(tx, ctx, subject, 'revoke');
    const propose = await this.authorization.evaluateInTx(tx, ctx, subject, 'propose');
    const resolve = await this.authorization.evaluateInTx(tx, ctx, subject, 'resolve_conflict');
    const approve = await this.authorization.evaluateInTx(tx, ctx, subject, 'approve');
    const read = await this.authorization.evaluateInTx(tx, ctx, subject, 'read');

    const terminal =
      TERMINAL.has(row.governedStatus) || ['revoked', 'superseded'].includes(row.legacyStatus);
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

  private versionLineage(tx: Prisma.TransactionClient, tenantId: string, itemId: string) {
    return tx.$queryRaw<VersionRow[]>(Prisma.sql`
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

  private itemTransitions(tx: Prisma.TransactionClient, tenantId: string, itemId: string) {
    return tx.$queryRaw<TransitionRow[]>(Prisma.sql`
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
             proposal_id::text AS "proposalId",
             metadata_jsonb AS metadata,
             occurred_at AS "occurredAt"
      FROM memory_transition_audit
      WHERE tenant_id = ${tenantId}::uuid AND memory_item_id = ${itemId}::uuid
      ORDER BY occurred_at DESC
      LIMIT 100
    `);
  }

  private itemProjection(tx: Prisma.TransactionClient, tenantId: string, itemId: string) {
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

  private conflictMembers(tx: Prisma.TransactionClient, tenantId: string, conflictGroupId: string) {
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

  private async actorDirectory(
    tx: Prisma.TransactionClient,
    ids: Array<string | null>,
  ): Promise<Record<string, { name: string; email: string }>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) return {};
    const users = await tx.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    return Object.fromEntries(
      users.map((user) => [
        user.id,
        {
          name: [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email,
          email: user.email,
        },
      ]),
    );
  }
}

function privateTransitionSql(userId: string): Prisma.Sql {
  return Prisma.sql`
    AND (
      a.memory_item_id IS NULL
      OR mi.visibility = 'tenant'
      OR mi.owner_user_id = ${userId}::uuid
    )
    AND (
      a.memory_candidate_id IS NULL
      OR mc.scope NOT IN ('personal','user_private')
      OR mc.proposed_by = ${userId}::uuid
    )
  `;
}

function privateProjectionSql(userId: string): Prisma.Sql {
  return Prisma.sql`
    AND (
      o.memory_item_id IS NULL
      OR mi.visibility = 'tenant'
      OR mi.owner_user_id = ${userId}::uuid
    )
    AND (
      o.clio_memory_id IS NULL
      OR cm.scope <> 'user_private'
      OR cm.owner_user_id = ${userId}::uuid
    )
  `;
}

function bucketSql(bucket: MemoryGovernanceBucket): Prisma.Sql {
  if (bucket === 'active') {
    return Prisma.sql`AND mi.status = 'active' AND mi.governed_status = 'active'`;
  }
  if (bucket === 'review_due') {
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
  }
  if (bucket === 'conflicts') {
    return Prisma.sql`
      AND (
        mi.governed_status = 'conflicted'
        OR mi.conflict_status IN ('open','controlling')
      )
    `;
  }
  if (bucket === 'history') {
    return Prisma.sql`
      AND (
        mi.status IN ('revoked','superseded')
        OR mi.governed_status IN ('revoked','superseded','rejected','expired')
      )
    `;
  }
  return Prisma.empty;
}

function presentItem(row: ItemRow, capabilities: GovernanceCapabilities) {
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

function presentVersion(row: VersionRow) {
  return {
    ...row,
    approvedAt: iso(row.approvedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function presentTransition(row: TransitionRow) {
  return {
    ...row,
    occurredAt: row.occurredAt.toISOString(),
  };
}

function presentProjection(row: ProjectionJobRow) {
  return {
    ...row,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    deadLetteredAt: iso(row.deadLetteredAt),
    supersededAt: iso(row.supersededAt),
  };
}

function noCapabilities(): GovernanceCapabilities {
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

function disabledOverview() {
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
    reviewEnabled: false,
  };
}

function emptyProjectionCounts() {
  return {
    pending: 0,
    running: 0,
    failed: 0,
    completed: 0,
    deadLetter: 0,
    superseded: 0,
  };
}

function count(value: bigint | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  return typeof value === 'bigint' ? Number(value) : 0;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
