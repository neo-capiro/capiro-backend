/**
 * Phase 7 Gap 5 — the fact-computing side of `PromotionEligibilityRepositoryV1`.
 *
 * Gap 3's closeout left this port unimplemented. Attempting it produced Gap 5:
 * only three of its seven reads had a persisted source of truth, and the other
 * four were blocked on storage that was never created or on a semantic choice
 * nobody had made. All four decisions have since been made and the storage
 * built, so this adapter now implements the port completely:
 *
 *   - `loadCandidates` reads `family` and `extraction_method`, denormalized
 *     onto `budget_extraction_candidate_v1` at verification time (decision 1),
 *     and resolves a governed candidate's source-profile hash from the Phase 6
 *     projections it actually produced (decision 2).
 *   - `loadProjectionPlans`, `countOpenBlockingConflicts` and
 *     `countUnsupportedProjections` all read `defense_budget_projection_plan`,
 *     the immutable producer-side store (decisions 3 and 4). The counts are
 *     derived from the stored plan documents themselves and cross-checked
 *     against the denormalized summary columns, never taken from the columns
 *     alone.
 *
 * The stance that survived from the partial version: nothing here answers a
 * question it cannot answer from persistence. A candidate whose metadata was
 * never backfilled is refused rather than promoted on a default, and an
 * unclassified projection exclusion throws rather than counting as zero —
 * `open_blocking_conflict_ignored` and `unsupported_mapping_silently_dropped`
 * are mandatory negative controls whose safe-looking answer is `0`.
 *
 * Same narrow-handle raw-SQL pattern as every other Prisma adapter in this
 * module, `::uuid` casts included.
 */
import type {
  PromotionEligibilityRepositoryV1,
  TrustedActiveSnapshotRecordV1,
  TrustedCandidateRecordV1,
  TrustedCycleCertificationRecordV1,
  TrustedProjectionPlanRecordV1,
} from './promotion-eligibility-service-v1.js';
import {
  budgetFamilyV1Schema,
  extractionMethodV1Schema,
  type BudgetFamilyV1,
} from '../contracts/extraction-artifact-v1.js';
import { familyRequiresStageSourceProfileV1 } from '../stages/stage-source-profile-coverage-v1.js';
import {
  PrismaProjectionPlanRepositoryV1,
  type ProjectionPlanPrismaLikeV1,
} from '../projection-plan/projection-plan-repository-prisma-v1.js';

/** The narrowest Prisma surface this adapter needs. Reads only. */
export interface EligibilityReadPrismaLikeV1 extends ProjectionPlanPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * Thrown when persistence cannot answer a question and the only alternatives
 * would be a default or a guess. Distinguishable from a genuine query failure.
 */
export class PromotionEligibilityReadUnavailableErrorV1 extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'PromotionEligibilityReadUnavailableErrorV1';
  }
}

interface CycleCertificationRowV1 {
  certificationId: string;
  contentSha256: string;
  status: string;
}

interface ActiveSnapshotRowV1 {
  snapshotId: string;
  snapshotHash: string | null;
  status: string;
}

interface CandidateRowV1 {
  candidateId: string;
  status: string;
  terminalVerificationRunId: string | null;
  family: string | null;
  extractionMethod: string | null;
  artifactSha256: string;
  sourceSha256: string;
  verificationPolicySha256: string;
  manifestSha256: string;
  reviewDecisionId: string | null;
  reviewerActorId: string | null;
  acceptedAssertionIds: unknown;
  sourceProfileSha256: string | null;
  sourceProfileHashCount: number;
}

export class PrismaPromotionEligibilityReadRepositoryV1 implements PromotionEligibilityRepositoryV1 {
  private readonly projectionPlans: PrismaProjectionPlanRepositoryV1;

  constructor(private readonly prisma: EligibilityReadPrismaLikeV1) {
    this.projectionPlans = new PrismaProjectionPlanRepositoryV1(prisma);
  }

  /**
   * Phase 6's `phase6_cycle_certification`. Every certification for the cycle is
   * returned, not only the CERTIFIED ones: the service distinguishes "no
   * certification exists" from "certifications exist but none is CERTIFIED",
   * and those are different refusals.
   */
  async loadCycleCertifications(
    cycleId: string,
    fiscalYear: number,
  ): Promise<TrustedCycleCertificationRecordV1[]> {
    const rows = await this.prisma.$queryRawUnsafe<CycleCertificationRowV1[]>(
      `SELECT "id"::text AS "certificationId",
              "content_sha256" AS "contentSha256",
              "status"
         FROM "phase6_cycle_certification"
        WHERE "cycle_id" = $1
          AND "fiscal_year" = $2
        ORDER BY "created_at", "content_sha256"`,
      cycleId,
      fiscalYear,
    );
    return rows.map((row) => ({
      certificationId: row.certificationId,
      contentSha256: row.contentSha256,
      status: row.status,
    }));
  }

  /**
   * Candidates in scope, with the two facts Gap 5 decision 1 denormalized onto
   * the row and the source-profile hash decision 2 requires for a governed
   * family.
   *
   * The `family` filter is honoured in SQL rather than in memory — the port's
   * own contract is that an implementation must not accidentally widen the
   * query, and a NULL `family` (a row written before the metadata migration and
   * never backfilled) is therefore excluded by the `IN` rather than swept in.
   * Such a row is not silently dropped either: the metadata check below turns a
   * partially-backfilled candidate into a refusal the operator can see.
   *
   * A governed candidate's profile hash comes from the Phase 6 audit
   * projections it actually produced — the only place a
   * `DefenseBudgetStageSourceProfileV1` hash is persisted. More than one
   * distinct hash for one candidate means the candidate spans two profiles,
   * which no promotion should paper over, so the count is carried out of SQL
   * and refused here rather than collapsed by `DISTINCT`.
   */
  async loadCandidates(
    cycleId: string,
    families: BudgetFamilyV1[],
  ): Promise<TrustedCandidateRecordV1[]> {
    if (families.length === 0) return [];
    const placeholders = families.map((_, index) => `$${index + 2}`).join(', ');
    const rows = await this.prisma.$queryRawUnsafe<CandidateRowV1[]>(
      `SELECT c."id"::text                       AS "candidateId",
              c."status",
              c."current_run_id"::text           AS "terminalVerificationRunId",
              c."family",
              c."extraction_method"              AS "extractionMethod",
              c."extraction_artifact_sha256"     AS "artifactSha256",
              c."source_sha256"                  AS "sourceSha256",
              c."policy_sha256"                  AS "verificationPolicySha256",
              c."manifest_content_sha256"        AS "manifestSha256",
              r."id"::text                       AS "reviewDecisionId",
              r."reviewer_id"                    AS "reviewerActorId",
              COALESCE(run."result_snapshot_jsonb" -> 'acceptedAssertionIds', '[]'::jsonb)
                                                 AS "acceptedAssertionIds",
              p."source_profile_hash"            AS "sourceProfileSha256",
              COALESCE(p."hash_count", 0)::int   AS "sourceProfileHashCount"
         FROM "budget_extraction_candidate_v1" c
         LEFT JOIN "budget_verification_run_v1" run
                ON run."id" = c."current_run_id"
         LEFT JOIN LATERAL (
                SELECT rd."id", rd."reviewer_id"
                  FROM "budget_review_decision_v1" rd
                 WHERE rd."candidate_id" = c."id"
                 ORDER BY rd."created_at" DESC
                 LIMIT 1
              ) r ON TRUE
         LEFT JOIN LATERAL (
                SELECT MIN(ap."source_profile_hash") AS "source_profile_hash",
                       COUNT(DISTINCT ap."source_profile_hash") AS "hash_count"
                  FROM "phase6_audit_projection" ap
                 WHERE ap."verification_candidate_id" = c."id"::text
              ) p ON TRUE
        WHERE c."cycle_id" = $1
          AND c."family" IN (${placeholders})
        ORDER BY c."id"`,
      cycleId,
      ...families,
    );

    return rows.map((row) => this.toTrustedCandidateV1(row));
  }

  private toTrustedCandidateV1(row: CandidateRowV1): TrustedCandidateRecordV1 {
    // A NULL here means the row predates the Gap 5 metadata migration and the
    // backfill has not reached it. Refused, never defaulted: `extractionMethod`
    // feeds `isHighRiskExtractionMethodV1`, so a default would make the
    // authorizer-equals-extractor control vacuous.
    if (row.family == null || row.extractionMethod == null) {
      throw new PromotionEligibilityReadUnavailableErrorV1(
        `candidate ${row.candidateId} has no persisted ${row.family == null ? 'family' : 'extraction method'}; ` +
          `run backfill-budget-candidate-source-metadata-v1 before promoting this cycle`,
      );
    }

    const family = budgetFamilyV1Schema.parse(row.family);
    const requiresProfile = familyRequiresStageSourceProfileV1(family);

    if (requiresProfile && row.sourceProfileHashCount > 1) {
      throw new PromotionEligibilityReadUnavailableErrorV1(
        `candidate ${row.candidateId} spans ${row.sourceProfileHashCount} distinct stage source ` +
          `profiles; a promotion cannot bind to one of them`,
      );
    }

    return {
      candidateId: row.candidateId,
      status: row.status,
      terminalVerificationRunId: row.terminalVerificationRunId,
      family,
      extractionMethod: extractionMethodV1Schema.parse(row.extractionMethod),
      // `null` for an ungoverned family is the correct answer, and the contract
      // refuses a non-null one there, so this is not merely permissive.
      sourceProfileSha256: requiresProfile ? row.sourceProfileSha256 : null,
      reviewDecisionId: row.reviewDecisionId,
      reviewerActorId: row.reviewerActorId,
      acceptedAssertionIds: parseAcceptedAssertionIdsV1(row.candidateId, row.acceptedAssertionIds),
      artifactSha256: row.artifactSha256,
      sourceSha256: row.sourceSha256,
      verificationPolicySha256: row.verificationPolicySha256,
      manifestSha256: row.manifestSha256,
    };
  }

  /**
   * The newest run for the candidate, of any status.
   *
   * "Terminal" is read as "completed", which is every persisted row —
   * `budget_verification_run_v1.completed_at` is NOT NULL, so the table holds no
   * in-flight runs. Restricting to `VERIFICATION_PASSED`/`REJECTED` instead
   * would be wrong in a way that is easy to miss: a `REVIEW_ACCEPTED` candidate
   * points at the `NEEDS_REVIEW` run a human then accepted, so excluding
   * `NEEDS_REVIEW` would make `latest` never equal that candidate's own run and
   * would block every review-accepted candidate as stale.
   */
  async loadLatestTerminalRunId(candidateId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ runId: string }>>(
      `SELECT "id"::text AS "runId"
         FROM "budget_verification_run_v1"
        WHERE "candidate_id" = $1::uuid
        ORDER BY "completed_at" DESC, "created_at" DESC, "id" DESC
        LIMIT 1`,
      candidateId,
    );
    return rows[0]?.runId ?? null;
  }

  /**
   * The immutable plans the producing phase filed for this scope. Every one is
   * reloaded and verified — document reparsed, content SHA re-checked, summary
   * re-derived — so what the eligibility record names is a plan that can still
   * be independently reproduced, not a hash with nothing behind it.
   */
  async loadProjectionPlans(
    cycleId: string,
    families: BudgetFamilyV1[],
  ): Promise<TrustedProjectionPlanRecordV1[]> {
    const records = await this.projectionPlans.loadForScope(cycleId, families);
    return records.map((record) => ({
      projectionPlanId: record.projectionPlanId,
      contentSha256: record.contentSha256,
    }));
  }

  /**
   * Gap 5 decision 4. Promotion-level conflicts are a property of the projection
   * plan — not of `budget_verification_discrepancy_v1` (per-run verification
   * evidence, already reflected in candidate status) and not of
   * `reconciliation_review_queue` (the legacy mutable PE path Phase 7 retires).
   *
   * Derived from the stored plan documents by `loadForScope`, which refuses any
   * row whose denormalized counts disagree with its own document, so the
   * integer columns act as an integrity check rather than as the answer.
   */
  async countOpenBlockingConflicts(cycleId: string, families: BudgetFamilyV1[]): Promise<number> {
    const records = await this.projectionPlans.loadForScope(cycleId, families);
    return records.reduce((total, record) => total + record.conflictCount, 0);
  }

  async countUnsupportedProjections(cycleId: string, families: BudgetFamilyV1[]): Promise<number> {
    const records = await this.projectionPlans.loadForScope(cycleId, families);
    return records.reduce((total, record) => total + record.unsupportedCount, 0);
  }

  /**
   * The activation pointer joined to the snapshot it names.
   *
   * A null `snapshot_hash` on an *active* snapshot is an invariant break, not a
   * missing optional. Returning `null` here would be read by the service as "no
   * active snapshot yet", which is a legitimate first-promotion state, so a
   * broken pointer must not be able to impersonate one.
   */
  async loadActiveSnapshot(
    domain: string,
    environment: string,
  ): Promise<TrustedActiveSnapshotRecordV1 | null> {
    const rows = await this.prisma.$queryRawUnsafe<ActiveSnapshotRowV1[]>(
      `SELECT a."snapshot_id"::text AS "snapshotId",
              s."snapshot_hash" AS "snapshotHash",
              s."status"
         FROM "defense_budget_active_snapshot" a
         JOIN "defense_budget_canonical_snapshot" s
           ON s."id" = a."snapshot_id"
        WHERE a."domain" = $1
          AND a."environment" = $2`,
      domain,
      environment,
    );
    const row = rows[0];
    if (row == null) return null;
    if (row.snapshotHash == null) {
      throw new Error(
        `active snapshot ${row.snapshotId} for ${domain}/${environment} has status ${row.status} ` +
          `and no snapshot_hash; an activation pointer must never name an unhashed snapshot`,
      );
    }
    return { snapshotId: row.snapshotId, snapshotHash: row.snapshotHash };
  }
}

/**
 * `acceptedAssertionIds` lives inside the run's result snapshot rather than in a
 * column. Read strictly: a malformed snapshot is a refusal, because an empty
 * list is itself a meaningful eligibility signal (`assertion_not_accepted`) and
 * must not be produced by a parse failure.
 */
function parseAcceptedAssertionIdsV1(candidateId: string, value: unknown): string[] {
  if (value == null) return [];
  const raw = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    throw new PromotionEligibilityReadUnavailableErrorV1(
      `candidate ${candidateId}'s run result snapshot has a malformed acceptedAssertionIds`,
    );
  }
  return raw as string[];
}
