import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed, fetchDeniedClientIds } from '../memory/memory-wall.helpers.js';

export interface LearningSignalSummary {
  id: string;
  clientId: string | null;
  sourceSurface: string;
  signalType: string;
  status: string;
  createdAt: Date;
}

interface LearningSignalRow {
  id: string;
  clientId: string | null;
  sourceSurface: string;
  signalType: string;
  status: string;
  createdAt: Date;
}

/**
 * Minimal, wall-aware read path for `learning_signal` (Phase 27A). There is
 * no review UI yet (that lands with governance integration, 27D) — this
 * exists so the ethical-wall security invariant is real and testable now,
 * not deferred until a UI exists to hang it off of.
 *
 * Every method fails closed exactly like memory recall does
 * (`memory-wall.helpers.ts`): an unresolvable or walled client denies rather
 * than defaulting to allow.
 */
@Injectable()
export class LearningSignalQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(ctx: TenantContext, id: string): Promise<LearningSignalSummary | null> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.learningSignal.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!row) return null;
      if (row.clientId) {
        const allowed = await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, row.clientId);
        if (!allowed) return null;
      }
      return toSummary(row);
    });
  }

  async listRecentForClient(
    ctx: TenantContext,
    clientId: string,
    limit = 50,
  ): Promise<LearningSignalSummary[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const allowed = await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId);
      if (!allowed) return [];
      const rows = await tx.learningSignal.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
      });
      return rows.map(toSummary);
    });
  }

  /** Tenant-wide listing, excluding every walled client this actor lacks a grant for. */
  async listRecentForTenant(ctx: TenantContext, limit = 50): Promise<LearningSignalSummary[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      const rows = await tx.learningSignal.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(denied.length ? { NOT: { clientId: { in: denied } } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
      });
      return rows.map(toSummary);
    });
  }
}

function toSummary(row: LearningSignalRow): LearningSignalSummary {
  return {
    id: row.id,
    clientId: row.clientId,
    sourceSurface: row.sourceSurface,
    signalType: row.signalType,
    status: row.status,
    createdAt: row.createdAt,
  };
}
