import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ImmutableMemoryVersionService,
  type LearningSignalGovernanceResult,
} from './immutable-memory-version.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryCandidateService } from './memory-candidate.service.js';
import { isMemoryReviewAdminRole } from './memory-review-admin-policy.js';
import {
  MemoryReviewWorkflowService,
  type MemoryReviewWorkflowSnapshot,
} from './memory-review-workflow.service.js';
import { normalizeMemoryReviewReason } from './memory-review-workflow.helpers.js';
import { memoryReviewSurfaceEnabled } from './memory-review-switch.js';
import type { MemorySection } from './memory.types.js';
import {
  candidateKindFor,
  candidateKindForSource,
  isLearningSignalConflictResolution,
  type LearningSignalConflictResolution,
  type MemoryCandidateKind,
} from './memory-version.helpers.js';

export type { MemoryCandidateKind };
export { candidateKindFor, candidateKindForSource };

export interface ReviewableMemoryCandidate {
  id: string;
  candidateKind: MemoryCandidateKind;
  scope: string;
  clientId: string | null;
  clientName?: string | null;
  proposedByUserId: string;
  sourceKind: string;
  createdAt: string;
  proposal: {
    key: string | null;
    value: string | null;
    canonicalItem: {
      type: string;
      slug: string;
      title: string;
      sections: MemorySection[];
    } | null;
  };
  /** Phase 27D — populated only when candidateKind === 'learning_signal_conflict'. */
  conflict: { contradictsMemoryItemId: string; conflictStatus: string } | null;
  workflow: MemoryReviewWorkflowSnapshot;
  capabilities: {
    approve: boolean;
    reject: boolean;
    requestChanges: boolean;
    reassign: boolean;
    /** Phase 27D — resolveConflict is only ever offered for candidateKind === 'learning_signal_conflict'. */
    resolveConflict: boolean;
  };
}

interface PendingCandidateRow {
  id: string;
  clientId: string | null;
  proposedBy: string;
  sourceKind: string;
  scope: string;
  createdAt: Date;
  contradictsMemoryItemId: string | null;
  conflictStatus: string | null;
}

type ImmutableReviewResult =
  | Awaited<ReturnType<ImmutableMemoryVersionService['approveCandidate']>>
  | Awaited<ReturnType<ImmutableMemoryVersionService['rejectCandidate']>>;

export type MemoryReviewDecisionResult =
  | {
      candidateId: string;
      candidateKind: 'standard' | 'learning_signal_conflict';
      outcome: 'activated' | 'rejected';
      memoryId?: string;
    }
  | ({ candidateKind: 'correction' | 'restore' | 'contradiction' } & ImmutableReviewResult)
  | ({ candidateKind: 'learning_signal_conflict' } & LearningSignalGovernanceResult);

/**
 * Scope-aware review facade for authenticated users.
 *
 * Administrators may act on every currently authorized pending review,
 * including their own proposal. Non-admin reviewers still see only work that is
 * currently assigned to them. The candidate body is loaded only after current
 * authorization succeeds.
 */
@Injectable()
export class MemoryCandidateReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
    private readonly candidates: MemoryCandidateService,
    private readonly versions: ImmutableMemoryVersionService,
    private readonly workflow: MemoryReviewWorkflowService,
  ) {}

  enabled(): boolean {
    return memoryReviewSurfaceEnabled();
  }

  async listReviewable(
    ctx: TenantContext,
  ): Promise<{ enabled: boolean; candidates: ReviewableMemoryCandidate[] }> {
    if (!this.enabled()) return { enabled: false, candidates: [] };

    const candidates = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await tx.memoryCandidate.findMany({
        where: { tenantId: ctx.tenantId, status: 'pending' },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          clientId: true,
          proposedBy: true,
          sourceKind: true,
          scope: true,
          createdAt: true,
          contradictsMemoryItemId: true,
          conflictStatus: true,
        },
      });

      const visible: ReviewableMemoryCandidate[] = [];
      const admin = isMemoryReviewAdminRole(ctx.role);
      for (const row of rows as PendingCandidateRow[]) {
        const subject = await this.authorization.loadCandidateInTx(tx, ctx.tenantId, row.id);
        if (!subject) continue;

        const approve = await this.authorization.evaluateInTx(tx, ctx, subject, 'approve', {
          emitDenialMetrics: false,
        });
        const review = await this.authorization.evaluateInTx(tx, ctx, subject, 'review', {
          emitDenialMetrics: false,
        });
        if (!approve.allowed && !review.allowed) continue;

        const authorizedRow = await tx.memoryCandidate.findFirst({
          where: { id: row.id, tenantId: ctx.tenantId, status: 'pending' },
          select: { payload: true },
        });
        if (!authorizedRow) continue;

        const proposal = proposalFromPayload(authorizedRow.payload);
        const candidateKind = candidateKindFor({
          sourceKind: row.sourceKind,
          contradictsMemoryItemId: row.contradictsMemoryItemId,
          conflictStatus: row.conflictStatus,
        });
        const workflow = await this.workflow.ensureAndDescribeInTx(
          tx,
          ctx,
          {
            id: row.id,
            tenantId: ctx.tenantId,
            clientId: row.clientId,
            proposedByUserId: row.proposedBy,
            sourceKind: row.sourceKind,
            scope: row.scope,
            candidateKind,
            title: proposal.canonicalItem?.title ?? proposal.key ?? 'Memory proposal',
          },
          subject,
        );

        if (
          workflow.status !== 'pending' ||
          (!admin && workflow.assignedReviewer?.userId !== ctx.userId)
        ) {
          continue;
        }

        const resolveConflictAllowed =
          candidateKind === 'learning_signal_conflict' &&
          (
            await this.authorization.evaluateInTx(tx, ctx, subject, 'resolve_conflict', {
              emitDenialMetrics: false,
            })
          ).allowed;

        visible.push({
          id: row.id,
          candidateKind,
          scope: row.scope,
          clientId: row.clientId,
          proposedByUserId: row.proposedBy,
          sourceKind: row.sourceKind,
          createdAt: row.createdAt.toISOString(),
          proposal,
          conflict:
            candidateKind === 'learning_signal_conflict'
              ? {
                  contradictsMemoryItemId: row.contradictsMemoryItemId as string,
                  conflictStatus: row.conflictStatus as string,
                }
              : null,
          workflow,
          capabilities: {
            approve: approve.allowed,
            reject: review.allowed,
            requestChanges: review.allowed && workflow.capabilities.requestChanges,
            reassign: workflow.capabilities.reassign,
            resolveConflict: resolveConflictAllowed,
          },
        });
      }
      // Resolve labels only for the rows that survived candidate authorization
      // and reviewer assignment. The workspace's current client is unrelated.
      const clientIds = [...new Set(visible.flatMap((candidate) =>
        candidate.scope === 'client' && candidate.clientId ? [candidate.clientId] : [],
      ))];
      const clients = clientIds.length
        ? await tx.client.findMany({
            where: { tenantId: ctx.tenantId, id: { in: clientIds } },
            select: { id: true, name: true },
          })
        : [];
      const names = new Map(clients.map((client) => [client.id, client.name]));
      return visible.map((candidate) => ({
        ...candidate,
        clientName: candidate.clientId ? names.get(candidate.clientId) ?? null : null,
      }));
    });

    return { enabled: true, candidates };
  }

  requestChanges(
    ctx: TenantContext,
    candidateId: string,
    reason: unknown,
  ): Promise<MemoryReviewWorkflowSnapshot> {
    this.requireEnabled();
    return this.workflow.requestChanges(ctx, candidateId, reason);
  }

  async assignReviewer(
    ctx: TenantContext,
    candidateId: string,
    reviewerUserId: string,
    reason: unknown,
  ): Promise<MemoryReviewWorkflowSnapshot> {
    this.requireEnabled();
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const subject = await this.authorization.loadCandidateInTx(tx, ctx.tenantId, candidateId);
      if (!subject) throw new NotFoundException('Memory candidate not found.');
      const decision = await this.authorization.evaluateInTx(tx, ctx, subject, 'review');
      if (!decision.allowed) {
        throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
      }
    });
    return this.workflow.assignReviewer(ctx, candidateId, reviewerUserId, reason);
  }

  /**
   * Plain approve. For candidateKind === 'learning_signal_conflict' this is
   * the `approve_new` outcome (§11 of the Phase 27D handoff): the reviewer
   * judges the detected conflict a false positive and commits the candidate
   * as an independent new memory — byte-for-byte the same commit path
   * 'standard' already uses, so no code branch is added here at all. A
   * genuine conflict resolution goes through resolveConflict() instead.
   */
  async approve(ctx: TenantContext, candidateId: string): Promise<MemoryReviewDecisionResult> {
    this.requireEnabled();
    await this.workflow.assertAssignedForDecision(ctx, candidateId, 'approve');
    const kind = await this.loadCandidateKind(ctx, candidateId);
    let result: MemoryReviewDecisionResult;
    if (kind === 'correction' || kind === 'restore' || kind === 'contradiction') {
      result = { candidateKind: kind, ...(await this.versions.approveCandidate(ctx, candidateId)) };
    } else {
      const { memoryId } = await this.candidates.approve(
        ctx.tenantId,
        candidateId,
        ctx.userId,
        ctx,
      );
      result = { candidateId, candidateKind: kind, outcome: 'activated', memoryId };
    }
    await this.workflow.completeDecision(ctx, candidateId, 'approved');
    return result;
  }

  async reject(
    ctx: TenantContext,
    candidateId: string,
    reason = '',
  ): Promise<MemoryReviewDecisionResult> {
    this.requireEnabled();
    const cleanReason = normalizeMemoryReviewReason(reason);
    if (!cleanReason) throw new BadRequestException('A rejection reason is required.');
    await this.workflow.assertAssignedForDecision(ctx, candidateId, 'review');
    const kind = await this.loadCandidateKind(ctx, candidateId);
    let result: MemoryReviewDecisionResult;
    if (kind === 'correction' || kind === 'restore' || kind === 'contradiction') {
      result = {
        candidateKind: kind,
        ...(await this.versions.rejectCandidate(ctx, candidateId, cleanReason)),
      };
    } else {
      await this.candidates.reject(ctx.tenantId, candidateId, ctx.userId, ctx);
      result = { candidateId, candidateKind: kind, outcome: 'rejected' };
    }
    await this.workflow.completeDecision(ctx, candidateId, 'rejected', cleanReason);
    return result;
  }

  /**
   * Phase 27D — the governed-resolution surface for a candidateKind ===
   * 'learning_signal_conflict' candidate. `duplicate` | `corroborate_existing`
   * | `supersede_existing` | `conflict_requires_review` all delegate to
   * ImmutableMemoryVersionService.decideLearningSignalCandidate, the one
   * canonical path that may resolve Phase 27C's conflict flag into a real
   * change to active memory. Rejects any other candidateKind — those never
   * carry a conflict flag to resolve.
   */
  async resolveConflict(
    ctx: TenantContext,
    candidateId: string,
    decision: LearningSignalConflictResolution,
    reason?: unknown,
  ): Promise<MemoryReviewDecisionResult> {
    this.requireEnabled();
    if (!isLearningSignalConflictResolution(decision)) {
      throw new BadRequestException(`Unsupported conflict resolution: ${String(decision)}`);
    }
    await this.workflow.assertAssignedForDecision(ctx, candidateId, 'resolve_conflict');
    const kind = await this.loadCandidateKind(ctx, candidateId);
    if (kind !== 'learning_signal_conflict') {
      throw new BadRequestException(
        'This candidate has no open conflict flag to resolve — use approve/reject instead.',
      );
    }
    const cleanReason = normalizeMemoryReviewReason(reason) ?? undefined;
    const versionResult = await this.versions.decideLearningSignalCandidate(
      ctx,
      candidateId,
      decision,
      cleanReason,
    );
    const result: MemoryReviewDecisionResult = {
      candidateKind: 'learning_signal_conflict',
      ...versionResult,
    };
    await this.workflow.completeDecision(ctx, candidateId, 'approved');
    return result;
  }

  private async loadCandidateKind(
    ctx: TenantContext,
    candidateId: string,
  ): Promise<MemoryCandidateKind> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await tx.memoryCandidate.findFirst({
        where: { id: candidateId, tenantId: ctx.tenantId, status: 'pending' },
        select: { sourceKind: true, contradictsMemoryItemId: true, conflictStatus: true },
      });
      if (!row) throw new NotFoundException('No pending memory candidate with that id.');
      return candidateKindFor({
        sourceKind: row.sourceKind,
        contradictsMemoryItemId: row.contradictsMemoryItemId,
        conflictStatus: row.conflictStatus,
      });
    });
  }

  private requireEnabled(): void {
    if (!this.enabled()) {
      throw new ServiceUnavailableException(
        'Client-scoped memory review is not enabled for this environment.',
      );
    }
  }
}

function proposalFromPayload(payload: unknown): ReviewableMemoryCandidate['proposal'] {
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
): ReviewableMemoryCandidate['proposal']['canonicalItem'] {
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
