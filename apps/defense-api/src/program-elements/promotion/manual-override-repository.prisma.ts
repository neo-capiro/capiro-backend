import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  ManualOverrideRecordV1,
  ManualOverrideRepositoryV1,
  ManualOverrideTargetV1,
} from './manual-override-service-v1.js';

/**
 * Prisma adapter for ManualOverrideRepositoryV1, writing to the same
 * defense_budget_manual_override table apps/api's Phase 7 promotion module
 * owns. This adapter INSERTs/reads proposed/approved override rows; it never
 * calls a snapshot-activation or canonical-promotion method — there is none
 * in this module for it to call.
 */
export class ManualOverrideRepositoryPrisma implements ManualOverrideRepositoryV1 {
  constructor(private readonly prisma: PrismaService) {}

  async findLatestForTarget(
    target: ManualOverrideTargetV1,
  ): Promise<{ overrideId: string; version: number; status: string } | null> {
    const row = await this.prisma.defenseBudgetManualOverride.findFirst({
      where: { canonicalEntity: target.canonicalEntity, canonicalNaturalKey: target.naturalKey },
      orderBy: { version: 'desc' },
    });
    if (!row) return null;
    return { overrideId: row.overrideId, version: row.version, status: row.status };
  }

  async findById(overrideId: string): Promise<ManualOverrideRecordV1 | null> {
    const row = await this.prisma.defenseBudgetManualOverride.findUnique({ where: { overrideId } });
    if (!row) return null;
    return {
      overrideId: row.overrideId,
      canonicalEntity: row.canonicalEntity,
      canonicalNaturalKey: row.canonicalNaturalKey,
      fiscalYear: row.fiscalYear,
      fundingField: row.fundingField,
      value: {
        originalValue: row.moneyOriginalValue,
        originalUnit: row.moneyOriginalUnit,
        valueMillions: row.moneyValueMillions.toString(),
      },
      governance: {
        authorActorId: row.authorActorId,
        approverActorId: row.approverActorId,
        approverRole: row.approverRole,
        reason: row.reason,
        evidenceIds: Array.isArray(row.evidenceIds) ? (row.evidenceIds as string[]) : [],
      },
      status: row.status as 'proposed' | 'approved',
      version: row.version,
      priorOverrideId: row.priorOverrideId,
      effectiveFrom: row.effectiveFrom.toISOString(),
      proposedAt: row.proposedAt.toISOString(),
      approvedAt: row.approvedAt?.toISOString() ?? null,
    };
  }

  async insert(record: ManualOverrideRecordV1, overrideHash: string): Promise<void> {
    await this.prisma.defenseBudgetManualOverride.create({
      data: {
        overrideId: record.overrideId,
        canonicalEntity: record.canonicalEntity,
        canonicalNaturalKey: record.canonicalNaturalKey,
        fiscalYear: record.fiscalYear,
        fundingField: record.fundingField,
        moneyOriginalValue: record.value.originalValue,
        moneyOriginalUnit: record.value.originalUnit,
        moneyValueMillions: record.value.valueMillions,
        authorActorId: record.governance.authorActorId,
        reason: record.governance.reason,
        evidenceIds: record.governance.evidenceIds,
        status: record.status,
        version: record.version,
        priorOverrideId: record.priorOverrideId ?? null,
        effectiveFrom: new Date(record.effectiveFrom),
        proposedAt: new Date(record.proposedAt),
        overrideHash,
      },
    });
  }

  async markApproved(input: { overrideId: string; approverActorId: string; approvedAt: string }): Promise<void> {
    await this.prisma.defenseBudgetManualOverride.update({
      where: { overrideId: input.overrideId },
      data: {
        status: 'approved',
        approvedAt: new Date(input.approvedAt),
        approverActorId: input.approverActorId,
        approverRole: 'capiro_admin',
      },
    });
  }
}
