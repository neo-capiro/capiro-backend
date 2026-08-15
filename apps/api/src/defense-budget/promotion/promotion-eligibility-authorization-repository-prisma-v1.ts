/**
 * Phase 7 Gap 3 closeout — the persistence adapters `authorize-defense-budget-
 * promotion-v1` was missing.
 *
 * Two repositories, because they serve two different ports that were already
 * fully specified and fully untested against a real database:
 *
 *   - `PromotionEligibilityPersistenceRepositoryV1` (new) — insert/lookup for
 *     `defense_budget_promotion_eligibility`, the table Gap 3 added.
 *   - `PromotionAuthorizationRepositoryV1` (from `promotion-authorization-
 *     service-v1.ts`, already existed) — `loadPlan` now genuinely joins the
 *     plan to its eligibility record instead of having nothing to join to.
 *
 * Both use the MAIN Prisma client's raw SQL, the same pattern as every other
 * Prisma adapter this module has (`canonical-promotion-repository-prisma-v1.ts`,
 * `phase6-audit-projection-repository-prisma-v1.ts`, ...) — no second
 * `PrismaClient`, no ORM-mapped model access, exact decimal/JSON round trips
 * verified by hand rather than assumed.
 */
import {
  defenseBudgetPromotionEligibilityV1Schema,
  promotionEligibilityHashV1,
  type DefenseBudgetPromotionEligibilityV1,
} from './promotion-eligibility-v1.js';
import {
  defenseBudgetPromotionAuthorizationV1Schema,
  type DefenseBudgetPromotionAuthorizationV1,
} from './promotion-authorization-v1.js';
import type {
  PromotionAuthorizationRepositoryV1,
  StoredPromotionPlanV1,
} from './promotion-authorization-service-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';

/** The narrowest Prisma surface these adapters need. */
export interface EligibilityAuthorizationPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface PromotionEligibilityPersistenceRepositoryV1 {
  /**
   * Idempotent on `eligibilityHash`: recording the identical evaluation twice
   * is a no-op, not an error — the row is content-addressed, so a second
   * insert of the same content changes nothing worth rejecting.
   */
  insert(eligibility: DefenseBudgetPromotionEligibilityV1): Promise<void>;
  findByHash(eligibilityHash: string): Promise<DefenseBudgetPromotionEligibilityV1 | null>;
}

export class PrismaPromotionEligibilityPersistenceRepositoryV1 implements PromotionEligibilityPersistenceRepositoryV1 {
  constructor(private readonly prisma: EligibilityAuthorizationPrismaLikeV1) {}

  async insert(eligibility: DefenseBudgetPromotionEligibilityV1): Promise<void> {
    const hash = promotionEligibilityHashV1(eligibility);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "defense_budget_promotion_eligibility" (
         "eligibility_id", "eligibility_hash", "cycle_id",
         "mapping_registry_version", "mapping_registry_hash",
         "scope", "scope_hash", "open_conflict_count", "unsupported_item_count",
         "document", "generated_at"
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11::timestamptz)
       ON CONFLICT ("eligibility_hash") DO NOTHING`,
      eligibility.eligibilityId,
      hash,
      eligibility.cycleId,
      eligibility.mappingRegistryVersion,
      eligibility.mappingRegistryHash,
      JSON.stringify(eligibility.scope),
      sha256CanonicalJson(eligibility.scope as unknown as JsonValue),
      eligibility.openConflictCount,
      eligibility.unsupportedItemCount,
      JSON.stringify(eligibility),
      eligibility.generatedAt,
    );
  }

  async findByHash(eligibilityHash: string): Promise<DefenseBudgetPromotionEligibilityV1 | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ document: unknown }>>(
      `SELECT "document" FROM "defense_budget_promotion_eligibility" WHERE "eligibility_hash" = $1`,
      eligibilityHash,
    );
    const row = rows[0];
    if (row == null) return null;
    // Re-parsed rather than trusted verbatim: storage is not proof. The schema
    // is deterministic (sorted ID sets, canonical transforms), so a row that
    // really came from `insert` above reparses to byte-identical shape and its
    // hash still matches; anything else fails loudly rather than silently.
    const parsed = defenseBudgetPromotionEligibilityV1Schema.parse(row.document);
    if (promotionEligibilityHashV1(parsed) !== eligibilityHash) {
      throw new Error(
        `stored eligibility document at hash ${eligibilityHash} no longer hashes to its own key; storage was tampered with`,
      );
    }
    return parsed;
  }
}

export class PrismaPromotionAuthorizationRepositoryV1 implements PromotionAuthorizationRepositoryV1 {
  constructor(private readonly prisma: EligibilityAuthorizationPrismaLikeV1) {}

  async loadPlan(planId: string): Promise<StoredPromotionPlanV1 | null> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        planId: string;
        planHash: string;
        eligibilityHash: string;
        blockedCount: number;
        expectedActiveSnapshotId: string | null;
        document: unknown;
      }>
    >(
      `SELECT p."plan_id" AS "planId", p."plan_hash" AS "planHash",
              p."eligibility_hash" AS "eligibilityHash", p."blocked_count" AS "blockedCount",
              p."expected_active_snapshot_id" AS "expectedActiveSnapshotId",
              e."document" AS "document"
         FROM "defense_budget_promotion_plan" p
         JOIN "defense_budget_promotion_eligibility" e
           ON e."eligibility_hash" = p."eligibility_hash"
        WHERE p."plan_id" = $1`,
      planId,
    );
    const row = rows[0];
    if (row == null) return null;

    const eligibility = defenseBudgetPromotionEligibilityV1Schema.parse(row.document);
    if (promotionEligibilityHashV1(eligibility) !== row.eligibilityHash) {
      throw new Error(
        `plan ${planId}'s joined eligibility document no longer hashes to ${row.eligibilityHash}; storage was tampered with`,
      );
    }

    return {
      planId: row.planId,
      planHash: row.planHash,
      eligibilityHash: row.eligibilityHash,
      blockedCount: row.blockedCount,
      expectedActiveSnapshotId: row.expectedActiveSnapshotId,
      eligibility,
    };
  }

  async findAuthorizationById(
    authorizationId: string,
  ): Promise<{ authorizationId: string } | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ authorizationId: string }>>(
      `SELECT "authorization_id" AS "authorizationId"
         FROM "defense_budget_promotion_authorization" WHERE "authorization_id" = $1`,
      authorizationId,
    );
    return rows[0] ?? null;
  }

  async insertAuthorization(
    record: DefenseBudgetPromotionAuthorizationV1 & { authorizationHash: string },
  ): Promise<void> {
    // Re-validated rather than trusted: this is the last gate before a row
    // lands in a table the database itself then freezes (append-only trigger,
    // one-use index). `defenseBudgetPromotionAuthorizationV1Schema` is the
    // same schema `promotion-authorization-service-v1.ts` already parsed the
    // record through — this call is cheap and catches a caller that
    // constructed the object by hand instead of through the service.
    //
    // `authorizationHash` is destructured out first: the schema is `.strict()`
    // and knows nothing of that field (it is this repository's own storage
    // concern, not part of the authorization document itself), so parsing the
    // whole `record` verbatim would fail every legitimate call.
    const { authorizationHash, ...authorization } = record;
    const parsed = defenseBudgetPromotionAuthorizationV1Schema.parse(authorization);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "defense_budget_promotion_authorization" (
         "authorization_id", "plan_id", "plan_hash", "eligibility_hash", "scope_hash",
         "expected_active_snapshot_id", "authorizer_actor_id", "authorizer_role",
         "reason", "issued_at", "expires_at", "segregation",
         "change_request_reference", "authorization_hash"
       ) VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12::jsonb, $13, $14)`,
      parsed.authorizationId,
      parsed.planId,
      parsed.planHash,
      parsed.eligibilityHash,
      sha256CanonicalJson(parsed.scope as unknown as JsonValue),
      parsed.expectedActiveSnapshotId,
      parsed.authorizerActorId,
      parsed.segregation.authorizerRole,
      parsed.reason,
      parsed.issuedAt,
      parsed.expiresAt,
      JSON.stringify(parsed.segregation),
      parsed.changeRequestReference ?? null,
      record.authorizationHash,
    );
  }
}
