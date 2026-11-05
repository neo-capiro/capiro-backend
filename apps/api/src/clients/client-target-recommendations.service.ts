import type { Prisma } from '@prisma/client';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { IntelligenceService } from '../intelligence/intelligence.service.js';
import type { OfficeRecommendation } from '../intelligence/office-recommender.service.js';

export interface OfficeRecommendationsResult {
  recommendations: OfficeRecommendation[];
  /** ISO timestamp of when this set was computed, or null if never computed. */
  computedAt: string | null;
}

/**
 * Persisted "Suggested by Meri" office recommendations for a client's Targets
 * tab. Computing them (tracked-bill resolution + scoring every congressional
 * office) is too slow to run on every page view, so we compute once — lazily, on
 * the first view — store the result, and serve the cache thereafter. A manual
 * "Refresh" recomputes on demand. One row per client (firm-wide, tenant-scoped
 * via RLS); the cache is intentionally NOT auto-invalidated — the user decides
 * when a recompute is worth the wait via the Refresh button.
 */
@Injectable()
export class ClientTargetRecommendationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intelligence: IntelligenceService,
  ) {}

  private async assertClient(ctx: TenantContext, clientId: string): Promise<void> {
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
        select: { id: true },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');
  }

  /**
   * Get the client's office recommendations. By default returns the persisted
   * cache, computing-and-storing it on the first request (none cached yet). With
   * `refresh: true`, always recomputes and overwrites the cache.
   */
  async getRecommendations(
    ctx: TenantContext,
    clientId: string,
    opts: { refresh?: boolean; beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void> } = {},
  ): Promise<OfficeRecommendationsResult> {
    await this.assertClient(ctx, clientId);

    if (!opts.refresh) {
      const cached = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clientTargetRecommendation.findUnique({ where: { clientId } }),
      );
      if (cached) {
        return {
          recommendations: (cached.recommendations ?? []) as unknown as OfficeRecommendation[],
          computedAt: cached.computedAt.toISOString(),
        };
      }
    }

    // Compute fresh (slow path) and persist. computeOfficeRecommendations runs
    // its own tenant-scoped reads, so it is called outside the cache transaction.
    const recommendations = await this.intelligence.computeOfficeRecommendations(
      clientId,
      ctx.tenantId,
    );
    const saved = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await opts.beforeWrite?.(tx);
      const updated = await tx.clientTargetRecommendation.upsert({
        where: { clientId },
        create: {
          tenantId: ctx.tenantId,
          clientId,
          recommendations: recommendations as unknown as object[],
          computedAt: new Date(),
        },
        update: {
          recommendations: recommendations as unknown as object[],
          computedAt: new Date(),
        },
      });
      await opts.beforeWrite?.(tx);
      return updated;
    });

    return { recommendations, computedAt: saved.computedAt.toISOString() };
  }
}
