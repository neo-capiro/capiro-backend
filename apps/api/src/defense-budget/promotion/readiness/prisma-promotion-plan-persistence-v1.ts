/**
 * Phase 10B-2 Gap 2d — real `PromotionPlanPersistencePortV1` adapter.
 *
 * `persistPlan` is the EXACT INSERT statement (same table, same columns,
 * same idempotent-replay-by-plan_id-and-hash semantics, same
 * `plan_id_conflict` refusal) `file-defense-budget-promotion-plan-v1.ts`
 * already uses — copied, not reinvented. No new promotion table, no
 * parallel persistence format.
 *
 * `findPlanByPlanId` is new relative to that script (which never needed a
 * planId-only lookup — an operator always supplies both id and hash from a
 * plan document already on disk). It reads the row by `plan_id` alone,
 * which is exactly what Gap 4's time-independent replay check needs before
 * this orchestrator ever builds a plan object worth comparing.
 */
import type { DefenseBudgetPromotionPlanV1 } from '../promotion-planner-v1.js';
import type { PromotionPlanPersistencePortV1 } from './cycle-family-readiness-orchestrator-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../../contracts/canonical-json.js';

export interface PromotionPlanPersistencePrismaQueryPortV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Real thin adapter wrapping `file-defense-budget-promotion-plan-v1.ts`'s exact INSERT. */
export class PrismaPromotionPlanPersistenceV1 implements PromotionPlanPersistencePortV1 {
  constructor(private readonly prisma: PromotionPlanPersistencePrismaQueryPortV1) {}

  async persistPlan(
    plan: DefenseBudgetPromotionPlanV1,
  ): Promise<{ filed: boolean; replay: boolean }> {
    const existing = await this.prisma.$queryRawUnsafe<Array<{ planHash: string }>>(
      `SELECT "plan_hash" AS "planHash" FROM "defense_budget_promotion_plan" WHERE "plan_id" = $1`,
      plan.planId,
    );
    if (existing.length > 0 && existing[0]?.planHash !== plan.planHash) {
      throw new Error(
        `plan_id_conflict: plan ${plan.planId} already filed with a different hash (${existing[0]?.planHash})`,
      );
    }
    const replay = existing.length > 0;
    if (!replay) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "defense_budget_promotion_plan" (
           "plan_id", "plan_hash", "eligibility_hash", "mapping_registry_version",
           "mapping_registry_hash", "cycle_id", "fiscal_year", "scope", "scope_hash",
           "mode", "expected_active_snapshot_id", "proposed_snapshot_id",
           "item_count", "blocked_count", "plan_document"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::uuid, $12::uuid, $13, $14, $15::jsonb)`,
        plan.planId,
        plan.planHash,
        plan.eligibilityHash,
        plan.mappingRegistryVersion,
        plan.mappingRegistryHash,
        plan.scope.cycleId,
        plan.scope.fiscalYear,
        JSON.stringify(plan.scope),
        sha256CanonicalJson(plan.scope as unknown as JsonValue),
        plan.mode,
        plan.expectedActiveSnapshotId,
        plan.proposedSnapshotId,
        plan.counts.total,
        plan.counts.blocked,
        JSON.stringify(plan),
      );
    }
    return { filed: true, replay };
  }

  async findPlanByPlanId(planId: string): Promise<{ planId: string; planHash: string } | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ planId: string; planHash: string }>>(
      `SELECT "plan_id" AS "planId", "plan_hash" AS "planHash"
         FROM "defense_budget_promotion_plan" WHERE "plan_id" = $1`,
      planId,
    );
    return rows[0] ?? null;
  }
}
