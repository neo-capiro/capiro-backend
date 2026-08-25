/**
 * Phase 10B-2 Gap 2d — dedicated real-adapter spec for
 * `PrismaPromotionPlanPersistenceV1`.
 *
 * Proves `findPlanByPlanId` / `persistPlan` against the actual adapter class
 * with a narrow Prisma-like fake, mirroring the exact
 * `file-defense-budget-promotion-plan-v1.ts` idempotent-replay-by-hash and
 * plan_id_conflict semantics this adapter is documented to copy verbatim.
 */
import { PrismaPromotionPlanPersistenceV1 } from './prisma-promotion-plan-persistence-v1.js';
import type { DefenseBudgetPromotionPlanV1 } from '../promotion-planner-v1.js';

const SHA = (c: string) => c.repeat(64);

function plan(overrides: Partial<DefenseBudgetPromotionPlanV1> = {}): DefenseBudgetPromotionPlanV1 {
  return {
    schemaVersion: 'defense_budget_promotion_plan_v1',
    planId: 'plan-abc',
    mappingRegistryVersion: 'canonical_mapping_registry_v1',
    mappingRegistryHash: SHA('3'),
    eligibilityHash: SHA('2'),
    scope: { cycleId: 'cycle-fy2027', fiscalYear: 2027, families: ['om'], stages: [] },
    mode: 'new_cycle',
    expectedActiveSnapshotId: null,
    proposedSnapshotId: '11111111-1111-4111-8111-111111111111',
    items: [],
    counts: { total: 0, insert: 0, supersede: 0, correction: 0, unchanged: 0, blocked: 0, alertEligible: 0 },
    diffsByFamily: [],
    diffsByEntity: [],
    diffsByFiscalYear: [],
    diffsByFundingField: [],
    blockReasonCounts: [],
    blocked: false,
    planHash: SHA('1'),
    ...overrides,
  } as unknown as DefenseBudgetPromotionPlanV1;
}

class FakePersistencePrisma {
  public rows = new Map<string, { planHash: string }>();
  public queries: Array<{ query: string; values: unknown[] }> = [];
  public executes: Array<{ query: string; values: unknown[] }> = [];

  async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    this.queries.push({ query, values });
    const planId = values[0] as string;
    const row = this.rows.get(planId);
    if (query.includes('SELECT "plan_hash"')) {
      return (row ? [{ planHash: row.planHash }] : []) as unknown as T;
    }
    if (query.includes('SELECT "plan_id"')) {
      return (row ? [{ planId, planHash: row.planHash }] : []) as unknown as T;
    }
    throw new Error(`unexpected query: ${query}`);
  }

  async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
    this.executes.push({ query, values });
    const planId = values[0] as string;
    const planHash = values[1] as string;
    this.rows.set(planId, { planHash });
    return 1;
  }
}

describe('PrismaPromotionPlanPersistenceV1', () => {
  describe('findPlanByPlanId', () => {
    it('returns the persisted plan/hash for an existing plan', async () => {
      const prisma = new FakePersistencePrisma();
      prisma.rows.set('plan-abc', { planHash: SHA('1') });
      const adapter = new PrismaPromotionPlanPersistenceV1(prisma);

      await expect(adapter.findPlanByPlanId('plan-abc')).resolves.toEqual({
        planId: 'plan-abc',
        planHash: SHA('1'),
      });
    });

    it('returns null when no plan exists under that planId', async () => {
      const adapter = new PrismaPromotionPlanPersistenceV1(new FakePersistencePrisma());
      await expect(adapter.findPlanByPlanId('nope')).resolves.toBeNull();
    });
  });

  describe('persistPlan', () => {
    it('first insert -> filed: true, replay: false', async () => {
      const prisma = new FakePersistencePrisma();
      const adapter = new PrismaPromotionPlanPersistenceV1(prisma);
      const result = await adapter.persistPlan(plan());
      expect(result).toEqual({ filed: true, replay: false });
      expect(prisma.executes).toHaveLength(1);
    });

    it('identical replay (same planId, same hash) -> filed: true, replay: true, no duplicate insert', async () => {
      const prisma = new FakePersistencePrisma();
      const adapter = new PrismaPromotionPlanPersistenceV1(prisma);
      const first = await adapter.persistPlan(plan());
      const second = await adapter.persistPlan(plan());

      expect(first).toEqual({ filed: true, replay: false });
      expect(second).toEqual({ filed: true, replay: true });
      // Only ONE actual INSERT — the replay branch never re-inserts.
      expect(prisma.executes).toHaveLength(1);
    });

    it('same planId + different content (different planHash) -> plan_id_conflict, thrown, no weakened guard', async () => {
      const prisma = new FakePersistencePrisma();
      const adapter = new PrismaPromotionPlanPersistenceV1(prisma);
      await adapter.persistPlan(plan({ planHash: SHA('1') }));

      await expect(
        adapter.persistPlan(plan({ planHash: SHA('different') })),
      ).rejects.toThrow(/plan_id_conflict/);
      // The conflicting attempt must never have inserted/overwritten the row.
      expect(prisma.executes).toHaveLength(1);
    });

    it('the conflict guard fires even when the caller retries with the SAME planId under a superficially valid but distinct plan object', async () => {
      const prisma = new FakePersistencePrisma();
      const adapter = new PrismaPromotionPlanPersistenceV1(prisma);
      await adapter.persistPlan(plan({ planId: 'plan-xyz', planHash: SHA('a') }));
      await expect(
        adapter.persistPlan(plan({ planId: 'plan-xyz', planHash: SHA('b') })),
      ).rejects.toThrow(/plan_id_conflict: plan plan-xyz already filed with a different hash/);
    });
  });
});
