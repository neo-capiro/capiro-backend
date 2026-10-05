import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { governedMemoryEnforcementEnabled } from './memory-authorization.helpers.js';
import { isMemoryReviewAdminRole } from './memory-review-admin-policy.js';
import { evaluateMemoryCandidate } from './memory-candidate-rules.js';
import { clientMemoryAllowed, fetchDeniedClientIds } from './memory-wall.helpers.js';
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
import {
  assertSyntheticCandidateWithdrawalInTx,
  type SyntheticCandidateWithdrawalGuard,
} from './synthetic-candidate-withdrawal.helpers.js';
import { memoryGovernanceCenterEnabled } from './memory-governance-center.switch.js';

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
  /**
   * Phase 27B additions — all optional, all additive: every existing caller
   * omits them and gets byte-for-byte the same INSERT as before.
   *
   * `sourceType`/`sourceId` populate the governance-v2 columns of the same
   * name (memory_governance_context_v2) at proposal time rather than
   * leaving them at their 'unknown'/null defaults until a later commit
   * pass. LearningSignalCandidateService is the only caller that sets
   * these today, pointing `sourceId` at the originating `learning_signal`
   * row's id with `sourceType: 'learning_signal_capture'` — the pairing a
   * partial unique index on memory_candidate enforces as candidate
   * generation's idempotency guard (one candidate per signal, ever).
   */
  sourceType?: string | null;
  sourceId?: string | null;
  /**
   * A generation-time PROPOSAL of the eventual governance classification —
   * never a promotion. The candidate still lands `pending`/`suggested`
   * exactly as it would without these; a human reviewer sees the proposal
   * and may accept, downgrade, or override it. `classifyCandidateForGovernance`
   * (memory-governance-lifecycle.helpers.ts) still computes the FINAL
   * classification at actual approve/reject time, independent of this.
   */
  proposedMemoryClass?: string | null;
  proposedMemoryAuthority?: string | null;
  /**
   * Phase 27C addition — same additive contract as the 27B fields above.
   * `contradictsMemoryItemId` (an existing real FK to `memory_items`, only
   * ever populated by the human-driven correction/contradiction flow until
   * now) lets `LearningSignalCandidateService` record a DETECTED probable
   * contradiction against active memory at proposal time. `conflictStatus`
   * defaults to `'none'` exactly as `buildCanonicalGovernance` already
   * hardcodes for every ordinary commit — passing `'open'` here only ever
   * touches THIS pending candidate row, never the active item it points
   * at. Never set together with a stronger claim than the evidence
   * supports: a `LearningSignalMemoryConflictService` `possible_related`
   * or `probable_contradiction` result, never an auto-resolution.
   */
  contradictsMemoryItemId?: string | null;
  conflictStatus?: string | null;
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
 * for review. Any active administrator may later approve, including the
 * administrator who proposed the memory; standard self-review remains denied.
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

  /** Submit a complete Settings firm/client file for administrator review. */
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
      isMemoryReviewAdminRole(ctx.role),
      'settings_sections',
    );
    if (result.status !== 'pending') {
      throw new Error('Shared Settings memory unexpectedly bypassed review.');
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
    /** Internal fixture-only identity; controllers never bind this argument. */
    fixtureCandidateId?: string,
  ): Promise<ProposeSaveMemoryResult> {
    if (fixtureCandidateId !== undefined) {
      const namespace = 'meri-foundation-20260928';
      const fixtureTenants = [
        'f2d6cf8f-057c-479a-8110-62fe5086d43f',
        '52e91176-08f0-4d89-9633-bc212f5bdbbf',
      ];
      if (
        process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== namespace ||
        !fixtureTenants.includes(tenantId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          fixtureCandidateId,
        ) ||
        sourceKind !== 'model_extraction' ||
        record.source !== 'meri_synthetic_fixture' ||
        record.sourceType !== 'meri_synthetic_fixture' ||
        !record.key.startsWith(`${namespace}:`) ||
        !/^[0-9a-f]{64}$/u.test(record.sourceId ?? '') ||
        !record.sourceExcerpt ||
        record.sourceExcerpt.length > 4000
      ) {
        throw new ForbiddenException('Synthetic candidate identity is not authorized');
      }
    }
    const scope: 'personal' | 'firm' | 'client' =
      record.scope === 'user_private' ? 'personal' : record.scope === 'client' ? 'client' : 'firm';
    if (record.scope === 'client' && !record.clientId) {
      throw new BadRequestException('Client-scope memory requires a clientId.');
    }

    const candidateConfidence =
      typeof record.confidence === 'number' && Number.isFinite(record.confidence)
        ? Math.min(1, Math.max(0, record.confidence))
        : null;

    // Phase 27B: explicit values fall back to exactly the column defaults
    // (memory_governance_context_v2), so every pre-existing caller — which
    // never sets these — gets a byte-identical INSERT to before this change.
    const governanceSourceType =
      typeof record.sourceType === 'string' && record.sourceType ? record.sourceType : 'unknown';
    const governanceSourceId = typeof record.sourceId === 'string' ? record.sourceId : null;
    const proposedMemoryClass =
      typeof record.proposedMemoryClass === 'string' && record.proposedMemoryClass
        ? record.proposedMemoryClass
        : 'legacy_unclassified';
    const proposedMemoryAuthority =
      typeof record.proposedMemoryAuthority === 'string' && record.proposedMemoryAuthority
        ? record.proposedMemoryAuthority
        : 'legacy_unclassified';
    // Phase 27C: same fallback-to-default discipline as the 27B fields above.
    const contradictsMemoryItemId =
      typeof record.contradictsMemoryItemId === 'string' ? record.contradictsMemoryItemId : null;
    const conflictStatus =
      typeof record.conflictStatus === 'string' && record.conflictStatus
        ? record.conflictStatus
        : 'none';

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

    // Only personal scope may commit inline. Shared scope always remains pending
    // until an authorized administrator or assigned reviewer takes a decision.
    const decision = evaluateMemoryCandidate({
      scope,
      isAdmin,
      sourceKind,
      confidence: candidateConfidence,
    });

    const result = await this.prisma.withTenantUser(tenantId, proposedByUserId, async (tx) => {
      if (fixtureCandidateId !== undefined) {
        const membership = await tx.$queryRaw<Array<{ user_id: string }>>`
          SELECT user_id::text AS user_id FROM tenant_memberships
          WHERE tenant_id = ${tenantId}::uuid AND user_id = ${proposedByUserId}::uuid
            AND status = 'active' FOR SHARE
        `;
        if (
          membership.length !== 1 ||
          (record.clientId &&
            !(await clientMemoryAllowed(tx, tenantId, proposedByUserId, record.clientId)))
        ) {
          throw new ForbiddenException('Synthetic candidate actor or client is not authorized');
        }
      }
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

      const candidateId = fixtureCandidateId ?? randomUUID();
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO memory_candidate (
          id, tenant_id, proposed_by, source_kind, scope, client_id, payload_jsonb,
          provenance_jsonb, duplicate_of_id, status, confidence,
          source_type, source_id, memory_class, memory_authority,
          contradicts_memory_item_id, conflict_status
        ) VALUES (
          ${candidateId}::uuid, ${tenantId}::uuid, ${proposedByUserId}::uuid, ${sourceKind}, ${scope},
          ${record.clientId ?? null}::uuid,
          ${JSON.stringify(payload)}::jsonb, ${JSON.stringify(provenance)}::jsonb,
          ${duplicateOfId}::uuid, 'pending', ${candidateConfidence},
          ${governanceSourceType}, ${governanceSourceId}, ${proposedMemoryClass}, ${proposedMemoryAuthority},
          ${contradictsMemoryItemId}::uuid, ${conflictStatus}
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

  async approve(
    tenantId: string,
    candidateId: string,
    approverUserId: string,
    actorContext?: CandidateActorContext,
  ): Promise<{ memoryId: string }> {
    return this.approveGuarded(tenantId, candidateId, approverUserId, actorContext);
  }

  /** Internal fixture port; the ordinary canonical approval and policy still run. */
  async approveSyntheticFixture(
    tenantId: string,
    candidateId: string,
    approverUserId: string,
    actorContext: CandidateActorContext,
    guard: SyntheticCandidateWithdrawalGuard,
  ): Promise<{ memoryId: string }> {
    if (!memoryGovernanceCenterEnabled() || !guard) {
      throw new ForbiddenException('Governed synthetic memory approval is not enabled');
    }
    return this.approveGuarded(tenantId, candidateId, approverUserId, actorContext, guard);
  }

  private async approveGuarded(
    tenantId: string,
    candidateId: string,
    approverUserId: string,
    actorContext?: CandidateActorContext,
    fixtureGuard?: SyntheticCandidateWithdrawalGuard,
  ): Promise<{ memoryId: string }> {
    const activated = await this.prisma.withTenantUser(tenantId, approverUserId, async (tx) => {
      const candidate = await this.lockPendingCandidateInTx(tx, tenantId, candidateId);
      if (fixtureGuard) {
        if (!memoryGovernanceCenterEnabled()) {
          throw new ForbiddenException('Governed synthetic memory approval is not enabled');
        }
        if (actorContext?.tenantId !== tenantId || actorContext.userId !== approverUserId) {
          throw new ForbiddenException('Synthetic memory reviewer context does not match');
        }
        const memberships = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT user_id::text AS id FROM tenant_memberships
          WHERE tenant_id=${tenantId}::uuid AND user_id=${approverUserId}::uuid
            AND status='active' AND role::text=${actorContext.role}
          FOR SHARE
        `;
        if (memberships.length !== 1) {
          throw new ForbiddenException('Synthetic memory reviewer is not a current member');
        }
        // The existing fixture identity/content guard is read-only. Run it
        // under the pending-row lock to close the inspect/approve race; never
        // fabricate an approved row or bypass canonical approval authorization.
        await assertSyntheticCandidateWithdrawalInTx(
          tx,
          tenantId,
          candidate.proposedBy,
          candidateId,
          fixtureGuard,
        );
      }
      await this.authorizeCandidateInTx(
        tx,
        tenantId,
        approverUserId,
        candidateId,
        'approve',
        actorContext,
      );
      this.requireSharedApprovalPolicy(candidate, approverUserId, actorContext);
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
      if (fixtureGuard && !governance) {
        throw new ForbiddenException('Synthetic memory requires canonical governed activation');
      }
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

    // Fixture reset/retirement may immediately follow approval. Wait for the
    // actual fast path so it cannot later repopulate a retired synthetic row.
    // Ordinary approval keeps its existing asynchronous durable-outbox behavior.
    const projection = this.dispatchProjectionFastPath(
      tenantId,
      activated.memoryId,
      activated.record,
      Boolean(fixtureGuard),
    );
    if (fixtureGuard) await projection;
    return { memoryId: activated.memoryId };
  }

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
   * Standard users still may not approve their own shared proposal. An active
   * administrator with server-resolved actor context may do so. The canonical
   * authorization layer separately enforces the tenant, ethical wall, client
   * status, and current role before this defense-in-depth check runs.
   */
  private requireSharedApprovalPolicy(
    candidate: { proposedBy: string; scope: string },
    approverUserId: string,
    actorContext?: CandidateActorContext,
  ): void {
    const shared = candidate.scope === 'firm' || candidate.scope === 'client';
    const selfApproval = shared && candidate.proposedBy === approverUserId;
    if (selfApproval && !isMemoryReviewAdminRole(actorContext?.role)) {
      throw new ForbiddenException(
        'Shared-scope memory self-approval requires an active administrator.',
      );
    }
  }

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

  private async commitToClioMemory(tenantId: string, record: MemorySaveRequest): Promise<string> {
    const committed = await this.prisma.withTenant(tenantId, (tx) =>
      this.commitToClioMemoryInTx(tx, tenantId, record),
    );
    this.dispatchProjectionFastPath(tenantId, committed.clioMemoryId, record);
    return committed.clioMemoryId;
  }

  private dispatchProjectionFastPath(
    tenantId: string,
    memoryId: string,
    record: MemorySaveRequest,
    requireSettlement = false,
  ): Promise<void> {
    const tasks = [
      this.embedMemory(tenantId, memoryId, record.key, record.value, requireSettlement),
      this.memoryIngest.projectClioMemory(tenantId, memoryId),
    ];
    // Even a failed synthetic fast path must settle both branches before the
    // operator can close its connection or start guarded reconciliation.
    const completion = requireSettlement
      ? Promise.allSettled(tasks).then((results) => {
          if (results.some((result) => result.status === 'rejected')) {
            throw new Error('Synthetic memory projection branch failed');
          }
        })
      : Promise.all(tasks).then(() => undefined);
    return completion
      .then(() => this.cleanupOutbox.markIndexedOnFastPath(tenantId, memoryId))
      .catch((err: unknown) => {
        if (requireSettlement) {
          // The canonical transaction already committed; callers must reconcile
          // its existing rows/outbox, never blindly retry approval or seed.
          throw new Error('Synthetic memory projection did not settle after approval');
        }
        this.logger.warn(
          `fast-path projection failed for clio_memory ${memoryId}; left queued for the ` +
            `cleanup drain: ${(err as Error).message}`,
        );
      });
  }

  private async embedMemory(
    tenantId: string,
    memoryId: string,
    key: string,
    value: string,
    requireSettlement = false,
  ): Promise<void> {
    const openaiKey = this.config.get('OPENAI_API_KEY', { infer: true });
    if (!openaiKey) return;
    const body = JSON.stringify({ model: 'text-embedding-3-small', input: `${key}: ${value}` });
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body,
      // The optional legacy Clio vector is not institutional-index authority.
      // A guarded fixture caller nevertheless must not hang on this side branch.
      ...(requireSettlement ? { signal: AbortSignal.timeout(20_000) } : {}),
    });
    if (!res.ok) return;
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = json.data?.[0]?.embedding;
    if (!embedding || embedding.length !== 1536) return;
    const vecStr = `[${embedding.join(',')}]`;
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE clio_memory SET embedding = $1::vector WHERE id = $2::uuid AND tenant_id = $3::uuid`,
        vecStr,
        memoryId,
        tenantId,
      ),
    );
  }
}

/**
 * Exported for ImmutableMemoryVersionService.decideLearningSignalCandidate
 * (Phase 27D) — a governed decision on a learning-signal-derived candidate
 * needs the exact same payload_jsonb -> MemorySaveRequest parse the
 * standard approve() path already uses, so the new memory_items row it
 * creates gets the same section-building convention (canonicalItem when
 * present, else the single 'memory' section from record.value).
 */
export function payloadToSaveRequest(payload: unknown): MemorySaveRequest {
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
