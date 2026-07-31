import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryCandidateService } from './memory-candidate.service.js';
import { memoryReviewSurfaceEnabled } from './memory-review-switch.js';
import type { MemorySection } from './memory.types.js';

export type MemoryCandidateKind = 'standard' | 'correction' | 'restore' | 'contradiction';

export interface ReviewableMemoryCandidate {
  id: string;
  candidateKind: MemoryCandidateKind;
  scope: string;
  clientId: string | null;
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
  capabilities: {
    approve: boolean;
    reject: boolean;
  };
}

interface PendingCandidateRow {
  id: string;
  clientId: string | null;
  proposedBy: string;
  sourceKind: string;
  scope: string;
  createdAt: Date;
}

type ImmutableReviewResult =
  | Awaited<ReturnType<ImmutableMemoryVersionService['approveCandidate']>>
  | Awaited<ReturnType<ImmutableMemoryVersionService['rejectCandidate']>>;

export type MemoryReviewDecisionResult =
  | {
      candidateId: string;
      candidateKind: 'standard';
      outcome: 'activated' | 'rejected';
      memoryId?: string;
    }
  | ({ candidateKind: Exclude<MemoryCandidateKind, 'standard'> } & ImmutableReviewResult);

const VERSION_SOURCE_KIND = {
  memory_correction: 'correction',
  memory_restore: 'restore',
  memory_contradiction: 'contradiction',
} as const;

/**
 * Scope-aware review facade for standard authenticated users.
 *
 * Candidate visibility and capabilities are server-owned. Generic saves delegate
 * to MemoryCandidateService; correction/restore/contradiction candidates delegate
 * to ImmutableMemoryVersionService so they can never fall through the legacy
 * canonical-upsert approval path.
 */
@Injectable()
export class MemoryCandidateReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
    private readonly candidates: MemoryCandidateService,
    private readonly versions: ImmutableMemoryVersionService,
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
        },
      });

      const visible: ReviewableMemoryCandidate[] = [];
      for (const row of rows as PendingCandidateRow[]) {
        const subject = await this.authorization.loadCandidateInTx(tx, ctx.tenantId, row.id);
        if (!subject) continue;

        const approve = await this.authorization.evaluateInTx(tx, ctx, subject, 'approve');
        const review = await this.authorization.evaluateInTx(tx, ctx, subject, 'review');
        if (!approve.allowed && !review.allowed) continue;

        const authorizedRow = await tx.memoryCandidate.findFirst({
          where: { id: row.id, tenantId: ctx.tenantId, status: 'pending' },
          select: { payload: true },
        });
        if (!authorizedRow) continue;

        visible.push({
          id: row.id,
          candidateKind: candidateKindForSource(row.sourceKind),
          scope: row.scope,
          clientId: row.clientId,
          proposedByUserId: row.proposedBy,
          sourceKind: row.sourceKind,
          createdAt: row.createdAt.toISOString(),
          proposal: proposalFromPayload(authorizedRow.payload),
          capabilities: {
            approve: approve.allowed,
            reject: review.allowed,
          },
        });
      }
      return visible;
    });

    return { enabled: true, candidates };
  }

  async approve(ctx: TenantContext, candidateId: string): Promise<MemoryReviewDecisionResult> {
    this.requireEnabled();
    const kind = await this.loadCandidateKind(ctx, candidateId);
    if (kind !== 'standard') {
      return { candidateKind: kind, ...(await this.versions.approveCandidate(ctx, candidateId)) };
    }
    const { memoryId } = await this.candidates.approve(
      ctx.tenantId,
      candidateId,
      ctx.userId,
      ctx,
    );
    return { candidateId, candidateKind: 'standard', outcome: 'activated', memoryId };
  }

  async reject(
    ctx: TenantContext,
    candidateId: string,
    reason = '',
  ): Promise<MemoryReviewDecisionResult> {
    this.requireEnabled();
    const kind = await this.loadCandidateKind(ctx, candidateId);
    if (kind !== 'standard') {
      const cleanReason = reason.trim();
      if (!cleanReason) {
        throw new BadRequestException('A rejection reason is required for a memory version.');
      }
      return {
        candidateKind: kind,
        ...(await this.versions.rejectCandidate(ctx, candidateId, cleanReason)),
      };
    }
    await this.candidates.reject(ctx.tenantId, candidateId, ctx.userId, ctx);
    return { candidateId, candidateKind: 'standard', outcome: 'rejected' };
  }

  private async loadCandidateKind(
    ctx: TenantContext,
    candidateId: string,
  ): Promise<MemoryCandidateKind> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await tx.memoryCandidate.findFirst({
        where: { id: candidateId, tenantId: ctx.tenantId, status: 'pending' },
        select: { sourceKind: true },
      });
      if (!row) throw new NotFoundException('No pending memory candidate with that id.');
      return candidateKindForSource(row.sourceKind);
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

export function candidateKindForSource(sourceKind: string): MemoryCandidateKind {
  return VERSION_SOURCE_KIND[sourceKind as keyof typeof VERSION_SOURCE_KIND] ?? 'standard';
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
