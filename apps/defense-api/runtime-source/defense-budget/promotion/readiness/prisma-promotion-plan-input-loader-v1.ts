/**
 * Phase 10B-2 Gap 2c — real `PromotionPlanInputLoaderPortV1` adapter.
 *
 * Every query here is copied verbatim (same tables, same columns, same
 * ordering, same filters) from the existing Phase 7 read paths — this
 * adapter invents no new query shape:
 *
 *   - `loadProjections`: composes the EXISTING
 *     `PrismaEligibilityBoundProjectionSourceV1.loadForEligibilityHash`
 *     (`eligibility-bound-projection-source-prisma-v1.ts`) exactly as
 *     `plan-defense-budget-promotion-v1.ts` already does. That method
 *     requires the eligibility record to already be durably persisted and
 *     findable by its own content hash — `plan-defense-budget-promotion-v1`
 *     takes `--eligibility-hash` as an operator-supplied CLI argument on the
 *     assumption an earlier step already filed it (see
 *     `promotion-eligibility-authorization-repository-prisma-v1.ts`'s
 *     `PrismaPromotionEligibilityPersistenceRepositoryV1`). This orchestrator
 *     has no earlier human step, so `loadProjections` performs that same
 *     idempotent (`ON CONFLICT ... DO NOTHING`, content-addressed) insert
 *     itself immediately before reloading — it is not inventing a new
 *     persistence format, it is calling the one Phase 7 already defined for
 *     exactly this purpose. This requires `PromotionPlanInputLoaderPortV1
 *     .loadProjections` to carry the exact evaluated eligibility record and
 *     hash (not merely the certification hash) — see that port's doc
 *     comment in `cycle-family-readiness-orchestrator-v1.ts` for why.
 *   - `loadPriorRows`: identical query to `plan-defense-budget-promotion-v1.ts`'s
 *     `priorRows` block (`defense_budget_canonical_row` for the given
 *     `snapshotId`).
 *   - `loadOverlays`: identical query to the same script's `overlayRows`
 *     block (`defense_budget_manual_override`, `status <> 'proposed'`,
 *     newest version per target).
 *   - `loadExpectedActiveSnapshot`: identical query to
 *     `promotion-eligibility-read-repository-prisma-v1.ts`'s
 *     `loadActiveSnapshot` (`defense_budget_active_snapshot` joined to
 *     `defense_budget_canonical_snapshot`).
 */
import {
  type ManualOverlayV1,
  type PriorCanonicalRowV1,
  type PromotionProjectionInputV1,
} from '../promotion-planner-v1.js';
import { type CanonicalEntityV1 } from '../canonical-mapping-registry-v1.js';
import {
  PrismaEligibilityBoundProjectionSourceV1,
  type EligibilityBoundProjectionPrismaLikeV1,
} from '../eligibility-bound-projection-source-prisma-v1.js';
import {
  PrismaPromotionEligibilityPersistenceRepositoryV1,
  type EligibilityAuthorizationPrismaLikeV1,
} from '../promotion-eligibility-authorization-repository-prisma-v1.js';
import type { DefenseBudgetPromotionEligibilityV1 } from '../promotion-eligibility-v1.js';
import type { FundingFieldV1 } from '../../contracts/extraction-artifact-v1.js';
import type { CycleFamilyReadinessIdentityV1 } from './cycle-family-readiness-v1.js';
import type { PromotionPlanInputLoaderPortV1 } from './cycle-family-readiness-orchestrator-v1.js';

export interface PromotionPlanInputPrismaQueryPortV1
  extends EligibilityBoundProjectionPrismaLikeV1,
    EligibilityAuthorizationPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

type PriorRowQueryResultV1 = {
  canonicalEntity: string;
  canonicalNaturalKey: string;
  canonicalRowHash: string;
  snapshotId: string;
};
type OverlayQueryResultV1 = {
  canonicalEntity: string;
  canonicalNaturalKey: string;
  fiscalYear: number;
  fundingField: string | null;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};
type ActiveSnapshotRowV1 = { snapshotId: string; snapshotHash: string | null };

/**
 * Real thin adapter for `PromotionPlanInputLoaderPortV1`. `cycleId` is read
 * from the identity's own `CycleFamilyCorpusInputV1.cycleId` at call sites
 * that have it; this class independently resolves `DefenseBudgetCycle` from
 * `(fiscalYear, authorityTrack)` for calls that only carry the identity, to
 * stay usable from either seam without forcing callers to thread `cycleId`
 * through every method.
 */
export class PrismaPromotionPlanInputLoaderV1 implements PromotionPlanInputLoaderPortV1 {
  constructor(
    private readonly prisma: PromotionPlanInputPrismaQueryPortV1,
    private readonly domain: string,
    private readonly environment: string,
  ) {}

  private async resolveCycleId(identity: CycleFamilyReadinessIdentityV1): Promise<string> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "defense_budget_cycle" WHERE "fiscal_year" = $1 AND "authority_track" = $2 LIMIT 1`,
      identity.fiscalYear,
      identity.authorityTrack,
    );
    const cycle = rows[0];
    if (cycle == null) {
      throw new Error(`defense_budget_cycle_not_found:${identity.fiscalYear}:${identity.authorityTrack}`);
    }
    return cycle.id;
  }

  async loadProjections(
    identity: CycleFamilyReadinessIdentityV1,
    certificationContentSha256: string,
    eligibility: DefenseBudgetPromotionEligibilityV1,
    eligibilityHash: string,
  ): Promise<readonly PromotionProjectionInputV1[]> {
    void identity;
    void certificationContentSha256;
    // Persist the EXACT eligibility record the orchestrator just evaluated
    // (idempotent, content-addressed insert — a second call for the same
    // hash is a no-op, matching `PromotionEligibilityPersistenceRepositoryV1
    // .insert`'s own documented contract) so it durably exists under its own
    // hash, then reload producer-plan projections through it using the
    // EXISTING Phase 7 seam exactly as `plan-defense-budget-promotion-v1.ts`
    // already does. This never recomputes eligibility or certification —
    // it only makes the record this orchestrator already computed once,
    // in-memory, durably re-loadable by the seam that already requires that.
    await new PrismaPromotionEligibilityPersistenceRepositoryV1(this.prisma).insert(eligibility);
    const source = new PrismaEligibilityBoundProjectionSourceV1(this.prisma);
    const loaded = await source.loadForEligibilityHash(eligibilityHash);
    if (loaded.refusals.length > 0) {
      throw new Error(
        `exact producer-plan reload for eligibility ${eligibilityHash} produced ${loaded.refusals.length} projector refusal(s): ` +
          loaded.refusals.map((refusal) => `${refusal.naturalKey}:${refusal.reason}`).join('; '),
      );
    }
    return loaded.projections;
  }

  async loadPriorRows(
    identity: CycleFamilyReadinessIdentityV1,
  ): Promise<readonly PriorCanonicalRowV1[]> {
    const activeSnapshot = await this.loadExpectedActiveSnapshot(identity);
    if (activeSnapshot == null) return [];
    const rows = await this.prisma.$queryRawUnsafe<PriorRowQueryResultV1[]>(
      `SELECT "canonical_entity" AS "canonicalEntity",
              "canonical_natural_key" AS "canonicalNaturalKey",
              "canonical_row_hash" AS "canonicalRowHash",
              "snapshot_id" AS "snapshotId"
         FROM "defense_budget_canonical_row"
        WHERE "snapshot_id" = $1::uuid
        ORDER BY "canonical_entity", "canonical_natural_key"`,
      activeSnapshot.snapshotId,
    );
    return rows.map((row) => ({
      canonicalEntity: row.canonicalEntity as CanonicalEntityV1,
      naturalKey: row.canonicalNaturalKey,
      rowHash: row.canonicalRowHash,
      snapshotId: row.snapshotId,
    }));
  }

  async loadOverlays(
    _identity: CycleFamilyReadinessIdentityV1,
  ): Promise<readonly ManualOverlayV1[]> {
    const rows = await this.prisma.$queryRawUnsafe<OverlayQueryResultV1[]>(
      `SELECT DISTINCT ON ("canonical_entity", "canonical_natural_key", "fiscal_year", "funding_field")
              "canonical_entity" AS "canonicalEntity",
              "canonical_natural_key" AS "canonicalNaturalKey",
              "fiscal_year" AS "fiscalYear",
              "funding_field" AS "fundingField",
              "status", "effective_from" AS "effectiveFrom", "effective_to" AS "effectiveTo"
         FROM "defense_budget_manual_override"
        WHERE "status" <> 'proposed'
        ORDER BY "canonical_entity", "canonical_natural_key", "fiscal_year", "funding_field",
                 "version" DESC`,
    );
    const now = Date.now();
    return rows.map((row) => {
      const status: ManualOverlayV1['status'] =
        row.status === 'revoked'
          ? 'revoked'
          : row.effectiveTo != null && new Date(row.effectiveTo).getTime() <= now
            ? 'expired'
            : 'active';
      return {
        canonicalEntity: row.canonicalEntity as CanonicalEntityV1,
        naturalKey: row.canonicalNaturalKey,
        fiscalYear: row.fiscalYear,
        fundingField: row.fundingField as FundingFieldV1 | null,
        status,
      };
    });
  }

  async loadExpectedActiveSnapshot(
    _identity: CycleFamilyReadinessIdentityV1,
  ): Promise<{ snapshotId: string; snapshotHash: string } | null> {
    const rows = await this.prisma.$queryRawUnsafe<ActiveSnapshotRowV1[]>(
      `SELECT a."snapshot_id" AS "snapshotId", s."snapshot_hash" AS "snapshotHash"
         FROM "defense_budget_active_snapshot" a
         JOIN "defense_budget_canonical_snapshot" s ON s."id" = a."snapshot_id"
        WHERE a."domain" = $1 AND a."environment" = $2`,
      this.domain,
      this.environment,
    );
    const row = rows[0];
    if (row == null) return null;
    if (row.snapshotHash == null) return null;
    return { snapshotId: row.snapshotId, snapshotHash: row.snapshotHash };
  }
}
