import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export interface MemoryItemUsageSummary {
  memoryItemId: string;
  /** How many distinct packets this item was included in. */
  inclusionCount: number;
  surfaces: string[];
  lastIncludedAt: Date | null;
}

export interface ArtifactTelemetryTimelineEntry {
  id: string;
  eventType: string;
  observedAt: Date;
  contextPacketId: string | null;
  editMetrics: unknown;
}

/**
 * Minimal read/aggregation surface for Phase 27E (handoff §8, "query/
 * aggregation service"). Deliberately narrow — enough to prove the
 * telemetry mechanics work end to end (a memory item's usage can be
 * aggregated, an artifact's lifecycle can be replayed) — not a full
 * analytics dashboard, which is 27F/product scope, not this phase's.
 *
 * Read-only: nothing here writes learning_signal / memory_candidate /
 * memory_items, or quality_telemetry_event itself.
 */
@Injectable()
export class QualityTelemetryQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Usefulness signal for one memory item (handoff §12): how many packets
   * included it, across which surfaces, and when it was last included.
   * Deliberately does NOT compute "positive vs negative outcomes that
   * followed" here — that requires joining against each surface's own
   * outcome semantics (different per surface) and belongs in a later,
   * surface-aware query, not this generic one (handoff §21: do not encode a
   * causal claim just because it's convenient to compute).
   */
  async getMemoryItemUsageSummary(
    ctx: TenantContext,
    memoryItemId: string,
  ): Promise<MemoryItemUsageSummary> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const uses = await tx.qualityTelemetryMemoryItemUse.findMany({
        where: { tenantId: ctx.tenantId, memoryItemId },
        include: { telemetryEvent: { select: { surface: true, observedAt: true } } },
      });
      const surfaces = Array.from(new Set(uses.map((u) => u.telemetryEvent.surface)));
      const lastIncludedAt = uses.reduce<Date | null>((latest, u) => {
        const at = u.telemetryEvent.observedAt;
        return !latest || at > latest ? at : latest;
      }, null);
      return { memoryItemId, inclusionCount: uses.length, surfaces, lastIncludedAt };
    });
  }

  /**
   * Full recorded lifecycle for one artifact (handoff §11: "packet →
   * generated version → subsequent human version(s) must be traceable"),
   * oldest first.
   */
  async getArtifactTimeline(
    ctx: TenantContext,
    artifactType: string,
    artifactId: string,
  ): Promise<ArtifactTelemetryTimelineEntry[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.qualityTelemetryEvent.findMany({
        where: { tenantId: ctx.tenantId, artifactType, artifactId },
        orderBy: { observedAt: 'asc' },
        select: { id: true, eventType: true, observedAt: true, contextPacketId: true, editMetrics: true },
      });
      return rows.map((row) => ({
        id: row.id,
        eventType: row.eventType,
        observedAt: row.observedAt,
        contextPacketId: row.contextPacketId,
        editMetrics: row.editMetrics,
      }));
    });
  }
}
