import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { governedMemoryEnforcementEnabled } from './memory-authorization.helpers.js';
import { evaluateMemoryCandidate } from './memory-candidate-rules.js';
import { fetchDeniedClientIds } from './memory-wall.helpers.js';
import {
  candidateTransitionPath,
  classifyCandidateForGovernance,
  governedMemoryLifecycleEnabled,
  governedStatusForDecision,
  type CandidateDecision,
  type LegacyCandidateScope,
} from './memory-governance-lifecycle.helpers.js';
import type { GovernedMemoryStatus } from '@capiro/meriv2-core';
import type { AppConfig } from '../config/config.schema.js';
import type { MemoryItemType, MemorySection } from './memory.types.js';
import {
  buildCanonicalGovernance,
  governedClioMetadata,
  upsertCanonicalMemoryItemInTx,
  type CanonicalGovernance,
} from './memory-canonical-activation.helpers.js';

/** The shape MeriToolsService.saveMemory already builds via buildSavedMemoryRecord. */
export interface MemorySaveRequest {
  scope: 'firm' | 'user_private' | 'client';
  ownerUserId: string | null;
  /** G2: required iff scope='client' (CHECK-enforced at the DB). */
  clientId?: string | null;
  key: string;
  value: string;
  source: string;
  /** G2 ephemeral/working memory: when set, the row expires (hidden from
   *  recall, purged by the daily sweep). Any scope may be ephemeral. */
  expiresAt?: Date | null;
  /** Phase 4: extraction confidence [0,1] for a model-sourced save; null/absent
   *  for explicit human saves (unscored → neutral at recall). Flows to the
   *  candidate row, the payload, and (on commit) clio_memory.metadata.confidence. */
  confidence?: number | null;
  /** Phase 0 governed auto-learning provenance. These fields are optional for
   * explicit human saves and required by the auto-learn caller. */
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  sourceExcerpt?: string | null;
  /** Exact canonical file identity for Settings-originated complete-section proposals. */
  canonicalItem?: {
    type: MemoryItemType;
    slug: string;
    title: string;
    sections: MemorySection[];
  };
}

export interface MemoryCandidateRow {
  id: string;
  tenantId: string;
  proposedBy: string;
  sourceKind: string;
  scope: string;
  status: string;
  duplicateOfId: string | null;
  committedMemoryId: string | null;
  createdAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
}

export interface ProposeSaveMemoryResult {
  candidateId: string;
  status: 'auto_committed' | 'pending';
  memoryId: string | null;
  ruleId: string;
  reason: string;
}

type CandidateActorContext = Pick<TenantContext, 'tenantId' | 'userId' | 'role'>;

export interface SettingsMemoryCandidateInput {
  type: MemoryItemType;
  slug: string;
  title: string;
  scope: 'firm' | 'client';
  clientId: string | null;
  sections: MemorySection[];
}

export interface PendingSettingsCandidate {
  candidateId: string;
  status: 'pending_review';
  submittedAt: string;
}

interface LockedCandidate {
  id: string;
  payload: unknown;
  proposedBy: string;
  scope: string;
  sourceKind: string;
}

interface ActivatedCandidate {
  memoryId: string;
  memoryItemId: string | null;
  record: MemorySaveRequest;
}

/**
 * Phase 1 (1B) — candidate lifecycle for memory writes (blueprint §4.6.5).
 *
 * Every memory write from `save_memory` (both surfaces — see
 * memory-candidate-rules.ts's header comment) goes through
 * `proposeSaveMemory`: a `memory_candidate` row is always created first, then
 * `evaluateMemoryCandidate` resolves PASS (commit in the same request) or
 * WARN (stays 'pending' until `approve`/`reject`).
 *
 * Only PERSONAL scope resolves PASS. Firm and client scope always land pending
 * for an independent reviewer (closeout §2.2) — an administrator can propose
 * shared memory but can no longer ratify their own proposal in one request.
 */
@Injectable()
export class MemoryCandidateService {
  private readonly logger = new Logger(MemoryCandidateService.name);

  /**
   * `cleanupOutbox` defaults to a locally constructed instance so the many
   * existing unit tests that build this service with four arguments keep
   * compiling. The default is given the same Prisma stub, so `enqueue` runs on
   * the caller's transaction in tests exactly as in production; only the
   * projector is absent there, which the index branch never needs on this path.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly memoryIngest: MemoryIngestService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly transitionAudit: MemoryTransitionAuditService = new MemoryTransitionAuditService(),
    private readonly cleanupOutbox: MemoryCleanupOutboxService = new MemoryCleanupOutboxService(
      prisma,
      memoryIngest,
    ),
    private readonly authorization: MemoryAuthorizationService = new MemoryAuthorizationService(
      prisma,
    ),
  ) {}

  /** Submit a complete Settings firm/client file for independent review. */
  async proposeSettingsSections(
    ctx: CandidateActorContext,
    input: SettingsMemoryCandidateInput,
  ): Promise<PendingSettingsCandidate> {
    const record: MemorySaveRequest = {
      scope: input.scope === 'client' ? 'client' : 'firm',
      ownerUserId: null,
      clientId: input.scope === 'client' ? input.clientId : null,
      key: `settings-file:${input.type}:${input.slug}`,
      value: JSON.stringify(input.sections),
      source: 'settings_memory_editor',
      canonicalItem: {
        type: input.type,
        slug: input.slug,
        title: input.title,
        sections: input.sections,
      },
    };
    const result = await this.proposeSaveMemory(
      ctx.tenantId,
      ctx.userId,
      record,
      ctx.role === 'user_admin' || ctx.role === 'capiro_admin',
      'settings_sections',
    );
    if (result.status !== 'pending') {
      throw new Error('Shared Settings memory unexpectedly bypassed independent review.');
    }
    return {
      candidateId: result.candidateId,
      status: 'pending_review',
      submittedAt: new Date().toISOString(),
    };
  }

  /** Return the newest pending proposal for this exact Settings file. */
  async findPendingSettingsCandidate(
    tenantId: string,
    viewerUserId: string,
    type: MemoryItemType,
    slug: string,
  ): Promise<PendingSettingsCandidate | null> {
    return this.prisma.withTenantUser(tenantId, viewerUserId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; created_at: Date }>>`
        SELECT id::text AS id, created_at
        FROM memory_candidate
        WHERE tenant_id = ${tenantId}::uuid
          AND status = 'pending'
          AND source_kind = 'settings_sections'
          AND payload_jsonb #>> '{canonicalItem,type}' = ${type}
          AND payload_jsonb #>> '{canonicalItem,slug}' = ${slug}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const row = rows[0];
      return row
        ? {
            candidateId: row.id,
            status: 'pending_review',
            submittedAt: row.created_at.toISOString(),
          }
        : null;
    });
  }

  /** Entry point for MeriToolsService.saveMemory. Always creates a candidate;
   *  commits inline when the rule evaluates PASS. */
  async proposeSaveMemory(
    tenantId: string,
    proposedByUserId: string,
    record: MemorySaveRequest,
    isAdmin: boolean,
    // Additive (Phase 3.4): distinguishes where the candidate originated so the
    // admin review queue can tell a chat save ('explicit_user') from a Workspace
    // artifact promotion ('workspace_artifact'). Defaults preserve every existing
    // caller's behavior exactly.
    sourceKind: string = 'explicit_user',
  ): Promise<ProposeSaveMemoryResult> {
    const scope: 'personal' | 'firm' | 'client' =
      record.scope === 'user_private' ? 'personal' : record.scope === 'client' ? 'client' : 'firm';
    if (record.scope === 'client' && !record.clientId) {
      throw new BadRequestException('Client-scope memory requires a clientId.');
    }

    // Phase 4: clamp a finite confidence to [0,1]; anything else = unscored (null).
    const candidateConfidence =
      typeof record.confidence === 'number' && Number.isFinite(record.confidence)
        ? Math.min(1, Math.max(0, record.confidence))
        : null;

    const sourceExcerpt =
      typeof record.sourceExcerpt === 'string' ? record.sourceExcerpt.slice(0, 4_000) : null;
    const sourceConversationId =
      typeof record.sourceConversationId === 'string' ? record.sourceConversationId : null;
    const sourceMessageId =
      typeof record.sourceMessageId === 'string' ? record.sourceMessageId : null;
    const payload = {
      key: record.key,
      value: record.value,
      source: record.source,
      scope: record.scope,
      ownerUserId: record.ownerUserId,
      clientId: record.clientId ?? null,
      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
      confidence: candidateConfidence,
      sourceConversationId,
      sourceMessageId,
      sourceExcerpt,
      canonicalItem: record.canonicalItem ?? null,
    };
    const provenance = {
      tool: 'save_memory',
      tenantId,
      userId: proposedByUserId,
      sourceConversationId,
      sourceMessageId,
      sourceExcerpt,
    };

    // The outcome is deterministic from server-owned facts. Only personal scope
    // may PASS; every shared scope remains pending for an independent reviewer.
    const decision = evaluateMemoryCandidate({
      scope,
      isAdmin,
      sourceKind,
      confidence: candidateConfidence,
    });

    // Candidate insert, duplicate lineage, personal activation, candidate
    // decision, transition audit, and durable projection obligation share ONE
    // transaction. An exception after any mutation rolls all of them back.
    const result = await this.prisma.withTenantUser(tenantId, proposedByUserId, async (tx) => {
      const priorCommitted = await tx.$queryRaw<
        Array<{ id: string; committed_memory_id: string | null }>
      >`
        SELECT mc.id::text AS id, mc.committed_memory_id::text AS committed_memory_id
        FROM memory_candidate mc
        JOIN clio_memory cm ON cm.id = mc.committed_memory_id
        WHERE mc.tenant_id = ${tenantId}::uuid
          AND cm.tenant_id = ${tenantId}::uuid
          AND cm.scope = ${record.scope}
          AND cm.key = ${record.key}
          AND (cm.owner_user_id IS NOT DISTINCT FROM ${record.ownerUserId}::uuid)
          AND (cm.client_id IS NOT DISTINCT FROM ${record.clientId ?? null}::uuid)
        ORDER BY mc.created_at DESC
        LIMIT 1
      `;
      const duplicateOfId = priorCommitted[0]?.id ?? null;

      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO memory_candidate (
          tenant_id, proposed_by, source_kind, scope, client_id, payload_jsonb,
          provenance_jsonb, duplicate_of_id, status, confidence
        ) VALUES (
          ${tenantId}::uuid, ${proposedByUserId}::uuid, ${sourceKind}, ${scope},
          ${record.clientId ?? null}::uuid,
          ${JSON.stringify(payload)}::jsonb, ${JSON.stringify(provenance)}::jsonb,
          ${duplicateOfId}::uuid, 'pending', ${candidateConfidence}
        )
        RETURNING id::text AS id
      `;
      const candidate = rows[0];
      if (!candidate) throw new Error('memory_candidate insert returned no row');

      if (decision.outcome === 'WARN') {
        return { candidateId: candidate.id, memoryId: null };
      }

      const governance = governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE)
        ? buildCanonicalGovernance({
            record,
            sourceKind,
            candidateId: candidate.id,
            assertedByUserId: proposedByUserId,
            approvedByUserId: proposedByUserId,
            decision: 'auto_committed',
          })
        : null;
      const committed = await this.commitToClioMemoryInTx(tx, tenantId, record, governance);
      await this.markDecidedInTx(
        tx,
        tenantId,
        candidate.id,
        'auto_committed',
        proposedByUserId,
        committed.clioMemoryId,
        committed.memoryItemId,
      );
      return { candidateId: candidate.id, memoryId: committed.clioMemoryId };
    });

    if (decision.outcome === 'WARN') {
      this.logger.log(
        `memory_candidate ${result.candidateId} pending (${decision.ruleId}), tenant ${tenantId}`,
      );
      return {
        candidateId: result.candidateId,
        status: 'pending',
        memoryId: null,
        ...decision,
      };
    }

    if (!result.memoryId) throw new Error('Atomic personal activation returned no memory id.');
    this.dispatchProjectionFastPath(tenantId, result.memoryId, record);
    return {
      candidateId: result.candidateId,
      status: 'auto_committed',
      memoryId: result.memoryId,
      ...decision,
    };
  }

  /**
   * Approve and activate a pending candidate atomically.
   *
   * `SELECT ... FOR UPDATE` serializes concurrent reviewers. The candidate is
   * re-checked as pending after the lock is acquired, so exactly one caller can
   * activate it; every other caller receives the same tenant-safe not-found
   * response used for an unknown or cross-tenant id.
   */
  async approve(
    tenantId: string,
    candidateId: string,
    approverUserId: string,
    actorContext?: CandidateActorContext,
  ): Promise<{ memoryId: string }> {
    const activated = await this.prisma.withTenantUser(tenantId, approverUserId, async (tx) => {
      const candidate = await this.lockPendingCandidateInTx(tx, tenantId, candidateId);
      await this.authorizeCandidateInTx(
        tx,
        tenantId,
        approverUserId,
        candidateId,
        'approve',
        actorContext,
      );
      this.requireIndependentReviewer(candidate, approverUserId);
      const record = payloadToSaveRequest(candidate.payload);
      const governance = governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE)
        ? buildCanonicalGovernance({
            record,
            sourceKind: candidate.sourceKind,
            candidateId,
            assertedByUserId: candidate.proposedBy,
            approvedByUserId: approverUserId,
            decision: 'approved',
          })
        : null;
      const committed = await this.commitToClioMemoryInTx(tx, tenantId, record, governance);
      await this.markDecidedInTx(
        tx,
        tenantId,
        candidateId,
        'approved',
        approverUserId,
        committed.clioMemoryId,
        committed.memoryItemId,
      );
      return {
        memoryId: committed.clioMemoryId,
        memoryItemId: committed.memoryItemId,
        record,
      } satisfies ActivatedCandidate;
    });

    this.dispatchProjectionFastPath(tenantId, activated.memoryId, activated.record);
    return { memoryId: activated.memoryId };
  }

  /** Reject a pending candidate atomically. No memory write ever happens. */
  async reject(
    tenantId: string,
    candidateId: string,
    reviewerUserId: string,
    actorContext?: CandidateActorContext,
  ): Promise<void> {
    await this.prisma.withTenantUser(tenantId, reviewerUserId, async (tx) => {
      await this.lockPendingCandidateInTx(tx, tenantId, candidateId);
      await this.authorizeCandidateInTx(
        tx,
        tenantId,
        reviewerUserId,
        candidateId,
        'review',
        actorContext,
      );
      await this.markDecidedInTx(tx, tenantId, candidateId, 'rejected', reviewerUserId, null);
    });
  }

  /**
   * Segregation of duties. Approving a shared-scope candidate is what turns a
   * proposal into firm/client memory that every other user will later be served
   * as institutional truth, so the approver must not be the proposer. The route's
   * `@Roles('user_admin')` guard is a role check, not an independence check — an
   * admin's own firm-scope proposal was previously self-ratifiable in one call.
   *
   * Personal scope is deliberately exempt: it is the proposer's own memory and
   * nobody else can review it. Rejection is also exempt — declining your own
   * proposal is a withdrawal and writes no memory.
   */
  private requireIndependentReviewer(
    candidate: { proposedBy: string; scope: string },
    approverUserId: string,
  ): void {
    const shared = candidate.scope === 'firm' || candidate.scope === 'client';
    if (shared && candidate.proposedBy === approverUserId) {
      throw new ForbiddenException(
        'Shared-scope memory must be approved by a reviewer other than the proposer.',
      );
    }
  }

  /**
   * Admin review queue. When a viewer is identified, candidates proposing
   * memory for a walled client the viewer is not granted are withheld — the
   * proposed payload is itself confidential content (fail-closed; the wall
   * manager grants a reviewer access when one is needed).
   */
  async listPending(tenantId: string, viewerUserId?: string): Promise<MemoryCandidateRow[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.memoryCandidate.findMany({
        where: { tenantId, status: 'pending' },
        orderBy: { createdAt: 'asc' },
      });
      if (!viewerUserId) return rows;
      const denied = new Set(await fetchDeniedClientIds(tx, tenantId, viewerUserId));
      return denied.size ? rows.filter((r) => !r.clientId || !denied.has(r.clientId)) : rows;
    });
  }

  private async lockPendingCandidateInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidateId: string,
  ): Promise<LockedCandidate> {
    const rows = await tx.$queryRaw<Array<LockedCandidate>>`
      SELECT id::text AS id,
             payload_jsonb AS payload,
             proposed_by::text AS "proposedBy",
             scope,
             source_kind AS "sourceKind"
      FROM memory_candidate
      WHERE id = ${candidateId}::uuid
        AND tenant_id = ${tenantId}::uuid
        AND status = 'pending'
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('No pending memory candidate with that id for this tenant.');
    }
    return row;
  }

  /**
   * Run the canonical governed authorization decision inside the same transaction
   * that owns the row lock and activation. The controller passes server-resolved
   * context; browser-supplied tenant, role, wall, or grant facts are never used.
   */
  private async authorizeCandidateInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actorUserId: string,
    candidateId: string,
    operation: 'approve' | 'review',
    actorContext?: CandidateActorContext,
  ): Promise<void> {
    if (!governedMemoryEnforcementEnabled(process.env.MEMORY_GOVERNANCE_ENFORCE)) return;
    if (
      !actorContext ||
      actorContext.tenantId !== tenantId ||
      actorContext.userId !== actorUserId
    ) {
      throw new ForbiddenException('Server-resolved actor context is required for memory review.');
    }
    const subject = await this.authorization.loadCandidateInTx(tx, tenantId, candidateId);
    if (!subject) throw new NotFoundException('Memory candidate not found');
    const decision = await this.authorization.evaluateInTx(tx, actorContext, subject, operation);
    if (!decision.allowed) {
      throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
    }
  }

  /**
   * Record the decision on the candidate row using the CALLER'S transaction.
   * No helper in an activation path may open an independent tenant transaction.
   */
  private async markDecidedInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidateId: string,
    status: CandidateDecision,
    decidedBy: string,
    committedMemoryId: string | null,
    committedMemoryItemId: string | null = null,
  ): Promise<void> {
    if (!governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE)) {
      await tx.memoryCandidate.update({
        where: { id: candidateId },
        data: {
          status,
          decidedBy,
          decidedAt: new Date(),
          committedMemoryId,
          ...(committedMemoryItemId ? { committedMemoryItemId } : {}),
        },
      });
      return;
    }

    const rows = await tx.$queryRaw<
      Array<{
        scope: string;
        source_kind: string;
        client_id: string | null;
        governed_status: string;
        expires_at: string | null;
      }>
    >`
      SELECT scope, source_kind, client_id::text AS client_id, governed_status,
             payload_jsonb->>'expiresAt' AS expires_at
      FROM memory_candidate
      WHERE id = ${candidateId}::uuid AND tenant_id = ${tenantId}::uuid
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('Memory candidate vanished before its decision.');

    const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
    const hasTtl = expiresAt !== null && Number.isFinite(expiresAt.getTime());
    const classification = classifyCandidateForGovernance(
      {
        scope: row.scope as LegacyCandidateScope,
        sourceKind: row.source_kind,
        hasTtl,
      },
      status,
    );
    const hops = candidateTransitionPath(row.governed_status as GovernedMemoryStatus, status);
    const decidedAt = new Date();

    await tx.memoryCandidate.update({
      where: { id: candidateId },
      data: {
        status,
        decidedBy,
        decidedAt,
        committedMemoryId,
        ...(committedMemoryItemId ? { committedMemoryItemId } : {}),
        memoryClass: classification.memoryClass,
        memoryScope: classification.memoryScope,
        governedStatus: governedStatusForDecision(status),
        ...(classification.memoryAuthority
          ? { memoryAuthority: classification.memoryAuthority }
          : {}),
        ...(status === 'approved' ? { approvedByUserId: decidedBy, approvedAt: decidedAt } : {}),
        ...(classification.memoryClass === 'episodic_working' && expiresAt ? { expiresAt } : {}),
      },
    });

    for (const hop of hops) {
      await this.transitionAudit.record(tx, tenantId, {
        subject: { memoryCandidateId: candidateId },
        actorUserId: decidedBy,
        clientId: row.client_id,
        fromStatus: hop.from,
        toStatus: hop.to,
        reasonCode: hop.reasonCode,
        reason: `memory candidate ${status} (${row.scope} scope, ${row.source_kind})`,
        metadata: {
          legacyStatus: status,
          memoryClass: classification.memoryClass,
          memoryAuthority: classification.memoryAuthority,
          clioMemoryId: committedMemoryId,
          memoryItemId: committedMemoryItemId,
          sourceKind: row.source_kind,
        },
      });
    }
  }

  /**
   * Commit one canonical clio_memory version and enqueue its projection using
   * the CALLER'S transaction. This helper never opens a nested transaction and
   * never performs network work.
   */
  private async commitToClioMemoryInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    record: MemorySaveRequest,
    governance: CanonicalGovernance | null = null,
  ): Promise<{ clioMemoryId: string; memoryItemId: string | null }> {
    const metadata = {
      tool: 'save_memory',
      createdBy: 'user-requested',
      visibility: record.scope,
      ...(typeof record.confidence === 'number' && Number.isFinite(record.confidence)
        ? { confidence: Math.min(1, Math.max(0, record.confidence)) }
        : {}),
      ...(record.sourceConversationId ? { sourceConversationId: record.sourceConversationId } : {}),
      ...(record.sourceMessageId ? { sourceMessageId: record.sourceMessageId } : {}),
      ...(record.sourceExcerpt ? { sourceExcerpt: record.sourceExcerpt.slice(0, 4_000) } : {}),
      ...(governance ? governedClioMetadata(governance) : {}),
    };

    const findExisting = () =>
      tx.clioMemory.findFirst({
        where: {
          tenantId,
          scope: record.scope,
          ownerUserId: record.ownerUserId,
          clientId: record.clientId ?? null,
          key: record.key,
        },
        select: { id: true },
      });
    const updateExisting = (id: string) =>
      tx.clioMemory.update({
        where: { id },
        data: {
          value: record.value,
          source: record.source,
          metadata,
          expiresAt: record.expiresAt ?? null,
        },
      });

    let id: string;
    const existing = await findExisting();
    if (existing) {
      await updateExisting(existing.id);
      id = existing.id;
    } else {
      try {
        const created = await tx.clioMemory.create({
          data: {
            tenantId,
            scope: record.scope,
            ownerUserId: record.ownerUserId,
            clientId: record.clientId ?? null,
            key: record.key,
            value: record.value,
            source: record.source,
            metadata,
            expiresAt: record.expiresAt ?? null,
          },
          select: { id: true },
        });
        id = created.id;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const raced = await findExisting();
          if (!raced) throw err;
          await updateExisting(raced.id);
          id = raced.id;
        } else {
          throw err;
        }
      }
    }

    const memoryItemId = governance
      ? await upsertCanonicalMemoryItemInTx(tx, tenantId, id, record, governance)
      : null;

    const stamp = await tx.$queryRaw<Array<{ updated_at: Date }>>`
      SELECT updated_at FROM clio_memory
      WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
    `;
    const version = stamp[0]?.updated_at?.toISOString() ?? 'unstamped';
    await this.cleanupOutbox.enqueue(tx, tenantId, {
      memoryItemId,
      clioMemoryId: id,
      operation: 'index_memory_item',
      idempotencyKey: `index_memory_item:${id}:${version}`,
    });
    return { clioMemoryId: id, memoryItemId };
  }

  /**
   * Compatibility wrapper for non-candidate callers and focused projection
   * tests. Candidate activation itself calls commitToClioMemoryInTx directly so
   * memory creation and the candidate decision cannot split across commits.
   */
  private async commitToClioMemory(tenantId: string, record: MemorySaveRequest): Promise<string> {
    const committed = await this.prisma.withTenant(tenantId, (tx) =>
      this.commitToClioMemoryInTx(tx, tenantId, record),
    );
    this.dispatchProjectionFastPath(tenantId, committed.clioMemoryId, record);
    return committed.clioMemoryId;
  }

  /** Network-backed embedding/projection is deliberately post-commit. */
  private dispatchProjectionFastPath(
    tenantId: string,
    memoryId: string,
    record: MemorySaveRequest,
  ): void {
    void Promise.all([
      this.embedMemory(tenantId, memoryId, record.key, record.value),
      this.memoryIngest.projectClioMemory(tenantId, memoryId),
    ])
      .then(() => this.cleanupOutbox.markIndexedOnFastPath(tenantId, memoryId))
      .catch((err: unknown) => {
        this.logger.warn(
          `fast-path projection failed for clio_memory ${memoryId}; left queued for the ` +
            `cleanup drain: ${(err as Error).message}`,
        );
      });
  }

  /**
   * Best-effort semantic-recall embedding for ONE committed clio_memory row.
   *
   * **Targets `id`, never `(tenant_id, key)`.** `clio_memory` is unique on
   * (tenant, scope, owner, client, key) — NOT on (tenant, key) — so the same key
   * legitimately exists many times in one tenant: once per client for
   * client-scope rows, once per user for user_private rows, plus the firm-scope
   * row. The previous `WHERE tenant_id = $2 AND key = $3` therefore wrote one
   * memory's vector over EVERY same-key row in the tenant, so a save for client A
   * silently repointed client B's semantic recall at A's content, and any
   * user_private row with a colliding key was overwritten with another user's
   * text. Closeout §4 "Embedding fix".
   */
  private async embedMemory(
    tenantId: string,
    memoryId: string,
    key: string,
    value: string,
  ): Promise<void> {
    const openaiKey = this.config.get('OPENAI_API_KEY', { infer: true });
    if (!openaiKey) return;
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: `${key}: ${value}` }),
    });
    if (!res.ok) return;
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = json.data?.[0]?.embedding;
    if (!embedding || embedding.length !== 1536) return;
    const vecStr = `[${embedding.join(',')}]`;
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.$executeRawUnsafe(
        // tenant_id stays in the predicate as defence in depth behind RLS.
        `UPDATE clio_memory SET embedding = $1::vector WHERE id = $2::uuid AND tenant_id = $3::uuid`,
        vecStr,
        memoryId,
        tenantId,
      ),
    );
  }
}

function payloadToSaveRequest(payload: unknown): MemorySaveRequest {
  const p = payload as Partial<MemorySaveRequest> | null;
  if (
    !p ||
    typeof p.key !== 'string' ||
    typeof p.value !== 'string' ||
    typeof p.source !== 'string'
  ) {
    throw new BadRequestException('Malformed memory candidate payload.');
  }
  const scope = p.scope === 'firm' ? 'firm' : p.scope === 'client' ? 'client' : 'user_private';
  const raw = payload as {
    clientId?: unknown;
    expiresAt?: unknown;
    confidence?: unknown;
    sourceConversationId?: unknown;
    sourceMessageId?: unknown;
    sourceExcerpt?: unknown;
    canonicalItem?: unknown;
  };
  return {
    scope,
    ownerUserId: typeof p.ownerUserId === 'string' ? p.ownerUserId : null,
    clientId: typeof raw.clientId === 'string' ? raw.clientId : null,
    key: p.key,
    value: p.value,
    source: p.source,
    expiresAt: typeof raw.expiresAt === 'string' ? new Date(raw.expiresAt) : null,
    // Phase 4: round-trip confidence so an APPROVED candidate commits with the
    // extraction confidence it was reviewed at (else it would lose it on commit).
    confidence:
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : null,
    sourceConversationId:
      typeof raw.sourceConversationId === 'string' ? raw.sourceConversationId : null,
    sourceMessageId: typeof raw.sourceMessageId === 'string' ? raw.sourceMessageId : null,
    sourceExcerpt: typeof raw.sourceExcerpt === 'string' ? raw.sourceExcerpt.slice(0, 4_000) : null,
    canonicalItem: parseCanonicalItem(raw.canonicalItem),
  };
}

function parseCanonicalItem(value: unknown): MemorySaveRequest['canonicalItem'] {
  if (value == null) return undefined;
  const item = value as { type?: unknown; slug?: unknown; title?: unknown; sections?: unknown };
  if (
    typeof item.type !== 'string' ||
    typeof item.slug !== 'string' ||
    typeof item.title !== 'string' ||
    !Array.isArray(item.sections)
  ) {
    throw new BadRequestException('Malformed Settings memory candidate payload.');
  }
  const sections = item.sections.map((raw) => {
    const section = raw as { key?: unknown; heading?: unknown; owner?: unknown; body?: unknown };
    if (
      typeof section.key !== 'string' ||
      typeof section.heading !== 'string' ||
      (section.owner !== 'human' && section.owner !== 'engine') ||
      typeof section.body !== 'string'
    ) {
      throw new BadRequestException('Malformed Settings memory candidate sections.');
    }
    return {
      key: section.key,
      heading: section.heading,
      owner: section.owner,
      body: section.body,
    } satisfies MemorySection;
  });
  return {
    type: item.type as MemoryItemType,
    slug: item.slug,
    title: item.title,
    sections,
  };
}
