import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export interface EvaluationRecordSummary {
  id: string;
  surface: string;
  operation: string;
  status: string;
  skipReason: string | null;
  metrics: unknown;
  observedAt: Date;
  completedAt: Date | null;
}

/**
 * Minimal read surface for Phase 27F — enough to prove the mechanics work
 * end to end and to support the eventual sampling-rate/cost-per-request
 * decisions Phase 27G needs, not a full analytics dashboard. Read-only:
 * nothing here writes `evaluation_record` or any governed-write table.
 */
@Injectable()
export class EvaluationQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every recorded evaluation decision for one artifact, oldest first. */
  async getArtifactEvaluations(
    ctx: TenantContext,
    artifactType: string,
    artifactId: string,
  ): Promise<EvaluationRecordSummary[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.evaluationRecord.findMany({
        where: { tenantId: ctx.tenantId, treatmentArtifactType: artifactType, treatmentArtifactId: artifactId },
        orderBy: { observedAt: 'asc' },
        select: {
          id: true,
          surface: true,
          operation: true,
          status: true,
          skipReason: true,
          metricsJsonb: true,
          observedAt: true,
          completedAt: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        surface: row.surface,
        operation: row.operation,
        status: row.status,
        skipReason: row.skipReason,
        metrics: row.metricsJsonb,
        observedAt: row.observedAt,
        completedAt: row.completedAt,
      }));
    });
  }
}
