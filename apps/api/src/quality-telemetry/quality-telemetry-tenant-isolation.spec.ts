import { describe, expect, it, jest } from '@jest/globals';
import { QualityTelemetryQueryService } from './quality-telemetry-query.service.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMORY_ITEM = 'ccccccc1-cccc-4ccc-8ccc-cccccccccccc';

/**
 * Behavioral isolation spec, same style as
 * `engagement-owner-isolation.spec.ts` / `program-element-watch.tenant-
 * isolation.spec.ts`: a fake DB seeded with rows for TWO tenants sharing the
 * same memoryItemId/artifactId, asserting a tenant-A-scoped query never
 * returns tenant B's rows even when the raw where-clause is otherwise
 * identical. Complements (does not replace) the static
 * `tenant-scope-guard.spec.ts` census, which already auto-covers
 * QualityTelemetryEvent/QualityTelemetryMemoryItemUse because both carry a
 * `tenantId` field.
 */
function fakeScopedPrisma(rows: {
  memoryItemUses: Array<{ tenantId: string; memoryItemId: string; telemetryEvent: { surface: string; observedAt: Date } }>;
  events: Array<{ id: string; tenantId: string; artifactType: string; artifactId: string; eventType: string; observedAt: Date; contextPacketId: string | null; editMetrics: unknown }>;
}) {
  return {
    withTenant: jest.fn(async (tenantId: string, fn: (tx: unknown) => unknown) => {
      // Mirrors what the REAL tenant-scope Prisma extension does: every
      // query implicitly gets `where.tenantId = tenantId` injected. A bug
      // that forgot to pass `tenantId` in a `where` clause would be
      // invisible to a naive mock — this fake enforces the filter itself,
      // exactly like the production tenant-scope hook does, so the test
      // proves the SERVICE queries by tenantId at all, not just that the
      // fake happens to be scoped.
      const tx = {
        qualityTelemetryMemoryItemUse: {
          findMany: jest.fn(async (args: { where: { tenantId: string; memoryItemId?: string } }) =>
            rows.memoryItemUses.filter(
              (r) => r.tenantId === tenantId && r.tenantId === args.where.tenantId && (!args.where.memoryItemId || r.memoryItemId === args.where.memoryItemId),
            ),
          ),
        },
        qualityTelemetryEvent: {
          findMany: jest.fn(async (args: { where: { tenantId: string; artifactType?: string; artifactId?: string } }) =>
            rows.events.filter(
              (r) =>
                r.tenantId === tenantId &&
                r.tenantId === args.where.tenantId &&
                (!args.where.artifactType || r.artifactType === args.where.artifactType) &&
                (!args.where.artifactId || r.artifactId === args.where.artifactId),
            ),
          ),
        },
      };
      return fn(tx);
    }),
  };
}

describe('QualityTelemetryQueryService tenant isolation', () => {
  it("tenant A's memory-item usage summary never includes tenant B's inclusion rows for the SAME memoryItemId", async () => {
    const prisma = fakeScopedPrisma({
      memoryItemUses: [
        { tenantId: TENANT_A, memoryItemId: MEMORY_ITEM, telemetryEvent: { surface: 'outreach', observedAt: new Date('2026-08-01') } },
        { tenantId: TENANT_B, memoryItemId: MEMORY_ITEM, telemetryEvent: { surface: 'workspace', observedAt: new Date('2026-08-20') } },
      ],
      events: [],
    });
    const service = new QualityTelemetryQueryService(prisma as never);

    const summaryA = await service.getMemoryItemUsageSummary({ tenantId: TENANT_A, userId: USER_A } as never, MEMORY_ITEM);
    expect(summaryA.inclusionCount).toBe(1);
    expect(summaryA.surfaces).toEqual(['outreach']);

    const summaryB = await service.getMemoryItemUsageSummary({ tenantId: TENANT_B, userId: USER_A } as never, MEMORY_ITEM);
    expect(summaryB.inclusionCount).toBe(1);
    expect(summaryB.surfaces).toEqual(['workspace']);
  });

  it("tenant A's artifact timeline never includes tenant B's events for the SAME artifactType/artifactId", async () => {
    const artifactId = 'shared-collision-id';
    const prisma = fakeScopedPrisma({
      memoryItemUses: [],
      events: [
        { id: 'evt-a', tenantId: TENANT_A, artifactType: 'crm_fill_finding', artifactId, eventType: 'approved', observedAt: new Date('2026-08-01'), contextPacketId: null, editMetrics: null },
        { id: 'evt-b', tenantId: TENANT_B, artifactType: 'crm_fill_finding', artifactId, eventType: 'rejected', observedAt: new Date('2026-08-02'), contextPacketId: null, editMetrics: null },
      ],
    });
    const service = new QualityTelemetryQueryService(prisma as never);

    const timelineA = await service.getArtifactTimeline({ tenantId: TENANT_A, userId: USER_A } as never, 'crm_fill_finding', artifactId);
    expect(timelineA.map((e) => e.id)).toEqual(['evt-a']);

    const timelineB = await service.getArtifactTimeline({ tenantId: TENANT_B, userId: USER_A } as never, 'crm_fill_finding', artifactId);
    expect(timelineB.map((e) => e.id)).toEqual(['evt-b']);
  });
});
