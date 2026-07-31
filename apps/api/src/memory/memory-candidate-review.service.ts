import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryCandidateService } from './memory-candidate.service.js';
import { governedMemoryEnforcementEnabled } from './memory-authorization.helpers.js';
import { governedMemoryLifecycleEnabled } from './memory-governance-lifecycle.helpers.js';
import type { MemorySection } from './memory.types.js';

export interface ReviewableMemoryCandidate {
  id: string;
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
  payloadJsonb: unknown;
}

/**
 * Scope-aware review facade for standard authenticated users.
 *
 * The legacy `/memory/candidates` routes remain administrator compatibility
 * aliases. This service owns the grant-aware review surface used by the product:
 * it lists only candidates for which the canonical authorization decision grants
 * `review` or `approve`, and it delegates mutations to MemoryCandidateService so
 * authorization is repeated while the candidate row is locked in the activation
 * transaction. Browser-supplied role, wall, client, or grant facts are never used.
 */
@Injectable()
export class MemoryCandidateReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
    private readonly candidates: MemoryCandidateService,
  ) {}

  enabled(): boolean {
    return (
      governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE) &&
      governedMemoryEnforcementEnabled(process.env.MEMORY_GOVERNANCE_ENFORCE)
    );
  }

  async listReviewable(
    ctx: TenantContext,
  ): Promise<{ enabled: boolean; candidates: ReviewableMemoryCandidate[] }> {
    if (!this.enabled()) return { enabled: false, candidates: [] };

    const candidates = await this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
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
            payloadJsonb: true,
          },
        });

        const visible: ReviewableMemoryCandidate[] = [];
        for (const row of rows as PendingCandidateRow[]) {
          const subject = await this.authorization.loadCandidateInTx(tx, ctx.tenantId, row.id);
          if (!subject) continue;

          const approve = await this.authorization.evaluateInTx(
            tx,
            ctx,
            subject,
            'approve',
          );
          const review = await this.authorization.evaluateInTx(
            tx,
            ctx,
            subject,
            'review',
          );
          if (!approve.allowed && !review.allowed) continue;

          visible.push({
            id: row.id,
            scope: row.scope,
            clientId: row.clientId,
            proposedByUserId: row.proposedBy,
            sourceKind: row.sourceKind,
            createdAt: row.createdAt.toISOString(),
            proposal: proposalFromPayload(row.payloadJsonb),
            capabilities: {
              approve: approve.allowed,
              reject: review.allowed,
            },
          });
        }
        return visible;
      },
    );

    return { enabled: true, candidates };
  }

  async approve(ctx: TenantContext, candidateId: string): Promise<{ memoryId: string }> {
    this.requireEnabled();
    return this.candidates.approve(ctx.tenantId, candidateId, ctx.userId, ctx);
  }

  async reject(ctx: TenantContext, candidateId: string): Promise<void> {
    this.requireEnabled();
    await this.candidates.reject(ctx.tenantId, candidateId, ctx.userId, ctx);
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
