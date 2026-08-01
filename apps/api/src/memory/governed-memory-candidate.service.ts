import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { GovernedMemoryStatus } from '@capiro/meriv2-core';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';
import { MemoryCandidateService } from './memory-candidate.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { governedMemoryEnforcementEnabled } from './memory-authorization.helpers.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import { clientMemoryAllowed } from './memory-wall.helpers.js';
import {
  candidateTransitionPath,
  classifyCandidateForGovernance,
  governedMemoryLifecycleEnabled,
  governedStatusForDecision,
  type CandidateDecision,
  type LegacyCandidateScope,
} from './memory-governance-lifecycle.helpers.js';
import { memoryReviewSurfaceEnabled } from './memory-review-switch.js';
import type { MemorySection } from './memory.types.js';

type CandidateActorContext = Pick<TenantContext, 'tenantId' | 'userId' | 'role'>;

interface LockedDispositionCandidate {
  id: string;
  proposedBy: string;
  scope: string;
  sourceKind: string;
  clientId: string | null;
}

interface CandidateGovernanceRow {
  scope: string;
  source_kind: string;
  client_id: string | null;
  governed_status: string;
  expires_at: string | null;
}

export type OwnedMemoryCandidateStatus =
  | 'pending'
  | 'withdrawn'
  | 'rejected'
  | 'approved'
  | 'auto_committed';

interface OwnCandidateRow {
  id: string;
  clientId: string | null;
  proposedBy: string;
  sourceKind: string;
  scope: string;
  status: OwnedMemoryCandidateStatus;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface OwnedMemoryCandidate {
  id: string;
  scope: string;
  clientId: string | null;
  sourceKind: string;
  status: OwnedMemoryCandidateStatus;
  createdAt: string;
  decidedAt: string | null;
  restricted: boolean;
  proposal: {
    key: string | null;
    value: string | null;
    canonicalItem: {
      type: string;
      slug: string;
      title: string;
      sections: MemorySection[];
    } | null;
  } | null;
  capabilities: { withdraw: boolean };
}

/**
 * Runtime replacement for candidate terminal dispositions.
 *
 * Approval remains inherited from MemoryCandidateService. Rejection and
 * withdrawal are owned here so every public route receives the same row lock,
 * segregation-of-duties rule, governed transition, and immutable audit evidence.
 */
@Injectable()
export class GovernedMemoryCandidateService extends MemoryCandidateService {
  constructor(
    private readonly governedPrisma: PrismaService,
    // Same cycle discipline as the store/outbox/ingest chain: inject the shared
    // tokens lazily so a subclass on this cycle cannot deadlock NestFactory.
    @Inject(forwardRef(() => MemoryIngestService))
    memoryIngest: MemoryIngestService,
    config: ConfigService<AppConfig, true>,
    private readonly governedTransitionAudit: MemoryTransitionAuditService,
    @Inject(forwardRef(() => MemoryCleanupOutboxService))
    cleanupOutbox: MemoryCleanupOutboxService,
    private readonly governedAuthorization: MemoryAuthorizationService,
  ) {
    super(
      governedPrisma,
      memoryIngest,
      config,
      governedTransitionAudit,
      cleanupOutbox,
      governedAuthorization,
    );
  }

  /** Reviewer rejection is never a substitute for withdrawing one's own proposal. */
  override async reject(
    tenantId: string,
    candidateId: string,
    reviewerUserId: string,
    actorContext?: CandidateActorContext,
  ): Promise<void> {
    await this.governedPrisma.withTenantUser(tenantId, reviewerUserId, async (tx) => {
      const candidate = await this.lockPendingDispositionCandidateInTx(tx, tenantId, candidateId);
      this.requireGovernedIndependentReviewer(candidate, reviewerUserId);
      await this.authorizeReviewerInTx(tx, tenantId, reviewerUserId, candidateId, actorContext);
      await this.decideTerminalInTx(tx, tenantId, candidateId, 'rejected', reviewerUserId);
    });
  }

  /** Proposer-only, atomic withdrawal. It creates no canonical memory or outbox work. */
  async withdraw(ctx: CandidateActorContext, candidateId: string): Promise<void> {
    this.requireWithdrawalEnabled();
    await this.governedPrisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const candidate = await this.lockPendingDispositionCandidateInTx(
        tx,
        ctx.tenantId,
        candidateId,
      );
      if (candidate.proposedBy !== ctx.userId) {
        throw new ForbiddenException(
          'Only the proposer may withdraw this pending memory proposal.',
        );
      }
      await this.decideTerminalInTx(tx, ctx.tenantId, candidateId, 'withdrawn', ctx.userId);
    });
  }

  /**
   * Bounded shared-proposal history. Client proposal bodies are redacted whenever
   * the proposer no longer passes the current ethical wall, while status and the
   * ability to withdraw a still-pending row remain visible.
   */
  async listOwnProposals(
    ctx: CandidateActorContext,
  ): Promise<{ enabled: boolean; candidates: OwnedMemoryCandidate[] }> {
    if (!memoryReviewSurfaceEnabled()) return { enabled: false, candidates: [] };

    const candidates = await this.governedPrisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const rows = (await tx.memoryCandidate.findMany({
          where: {
            tenantId: ctx.tenantId,
            proposedBy: ctx.userId,
            scope: { in: ['firm', 'client'] },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            clientId: true,
            proposedBy: true,
            sourceKind: true,
            scope: true,
            status: true,
            createdAt: true,
            decidedAt: true,
          },
        })) as OwnCandidateRow[];

        const own: OwnedMemoryCandidate[] = [];
        for (const row of rows) {
          const contentAllowed = row.clientId
            ? await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, row.clientId)
            : true;
          const payloadRow = contentAllowed
            ? await tx.memoryCandidate.findFirst({
                where: { id: row.id, tenantId: ctx.tenantId },
                select: { payload: true },
              })
            : null;
          own.push({
            id: row.id,
            scope: row.scope,
            clientId: row.clientId,
            sourceKind: row.sourceKind,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            decidedAt: row.decidedAt?.toISOString() ?? null,
            restricted: !contentAllowed,
            proposal: payloadRow ? proposalFromPayload(payloadRow.payload) : null,
            capabilities: { withdraw: row.status === 'pending' },
          });
        }
        return own;
      },
    );

    return { enabled: true, candidates };
  }

  private requireWithdrawalEnabled(): void {
    if (!memoryReviewSurfaceEnabled()) {
      throw new ServiceUnavailableException(
        'Memory proposal withdrawal is not enabled for this environment.',
      );
    }
  }

  private async lockPendingDispositionCandidateInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidateId: string,
  ): Promise<LockedDispositionCandidate> {
    const rows = await tx.$queryRaw<Array<LockedDispositionCandidate>>`
      SELECT id::text AS id,
             proposed_by::text AS "proposedBy",
             scope,
             source_kind AS "sourceKind",
             client_id::text AS "clientId"
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

  private requireGovernedIndependentReviewer(
    candidate: Pick<LockedDispositionCandidate, 'proposedBy' | 'scope'>,
    reviewerUserId: string,
  ): void {
    const shared = candidate.scope === 'firm' || candidate.scope === 'client';
    if (shared && candidate.proposedBy === reviewerUserId) {
      throw new ForbiddenException(
        'A proposer must use Withdraw; reviewer rejection requires an independent reviewer.',
      );
    }
  }

  private async authorizeReviewerInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actorUserId: string,
    candidateId: string,
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
    const subject = await this.governedAuthorization.loadCandidateInTx(tx, tenantId, candidateId);
    if (!subject) throw new NotFoundException('Memory candidate not found');
    const decision = await this.governedAuthorization.evaluateInTx(
      tx,
      actorContext,
      subject,
      'review',
    );
    if (!decision.allowed) {
      throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
    }
  }

  private async decideTerminalInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidateId: string,
    status: Extract<CandidateDecision, 'rejected' | 'withdrawn'>,
    decidedBy: string,
  ): Promise<void> {
    const decidedAt = new Date();
    if (!governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE)) {
      await tx.memoryCandidate.update({
        where: { id: candidateId },
        data: {
          status,
          decidedBy,
          decidedAt,
          committedMemoryId: null,
        },
      });
      return;
    }

    const rows = await tx.$queryRaw<Array<CandidateGovernanceRow>>`
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

    await tx.memoryCandidate.update({
      where: { id: candidateId },
      data: {
        status,
        decidedBy,
        decidedAt,
        committedMemoryId: null,
        memoryClass: classification.memoryClass,
        memoryScope: classification.memoryScope,
        governedStatus: governedStatusForDecision(status),
        ...(classification.memoryClass === 'episodic_working' && expiresAt ? { expiresAt } : {}),
      },
    });

    for (const hop of hops) {
      await this.governedTransitionAudit.record(tx, tenantId, {
        subject: { memoryCandidateId: candidateId },
        actorUserId: decidedBy,
        clientId: row.client_id,
        fromStatus: hop.from,
        toStatus: hop.to,
        reasonCode: hop.reasonCode,
        reason:
          status === 'withdrawn'
            ? `memory candidate withdrawn by proposer (${row.scope} scope, ${row.source_kind})`
            : `memory candidate rejected by reviewer (${row.scope} scope, ${row.source_kind})`,
        metadata: {
          legacyStatus: status,
          memoryClass: classification.memoryClass,
          sourceKind: row.source_kind,
          dispositionActor: status === 'withdrawn' ? 'proposer' : 'reviewer',
        },
      });
    }
  }
}

function proposalFromPayload(payload: unknown): OwnedMemoryCandidate['proposal'] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { key: null, value: null, canonicalItem: null };
  }
  const record = payload as Record<string, unknown>;
  return {
    key: typeof record.key === 'string' ? record.key : null,
    value: typeof record.value === 'string' ? record.value : null,
    canonicalItem: normalizeCanonicalItem(record.canonicalItem),
  };
}

function normalizeCanonicalItem(
  value: unknown,
): NonNullable<OwnedMemoryCandidate['proposal']>['canonicalItem'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.type !== 'string' ||
    typeof item.slug !== 'string' ||
    typeof item.title !== 'string' ||
    !Array.isArray(item.sections)
  ) {
    return null;
  }
  const sections = item.sections.filter(isMemorySection);
  if (sections.length !== item.sections.length) return null;
  return {
    type: item.type,
    slug: item.slug,
    title: item.title,
    sections,
  };
}

function isMemorySection(value: unknown): value is MemorySection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const section = value as Record<string, unknown>;
  return (
    typeof section.key === 'string' &&
    typeof section.heading === 'string' &&
    (section.owner === 'human' || section.owner === 'engine') &&
    typeof section.body === 'string'
  );
}
