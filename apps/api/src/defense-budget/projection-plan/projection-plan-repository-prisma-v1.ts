/**
 * Phase 7 Gap 5, decisions 3 and 4 — persistence and verified reload for
 * projection plans.
 *
 * The verification chain this exists to make possible, and which no earlier
 * design could perform because the plan was never written down:
 *
 *   persisted bytes -> content SHA -> certified inputs -> authorized plan hash
 *
 * `loadVerified` walks it. It re-parses the stored document through the shared
 * structural view, recomputes nothing about the family projection (that would
 * be Phase 7 recomputing a Phase 4/5/6 concern), and instead checks that the
 * document still declares the `contentSha256` the row is filed under, that the
 * derived summary still matches the denormalized counts, and that the artifact
 * set binding is unchanged. Any disagreement is storage tampering or a
 * producer bug, and is thrown rather than reported as a zero.
 *
 * Same narrow-handle raw-SQL pattern as every other adapter in this tree.
 */
import {
  buildProjectionPlanRecordV1,
  defenseBudgetProjectionPlanRecordV1Schema,
  projectionPlanDocumentViewV1Schema,
  summarizeProjectionPlanV1,
  type DefenseBudgetProjectionPlanRecordV1,
} from './projection-plan-record-v1.js';
import {
  NOOP_SLO_METRIC_RECORDER_V1,
  type SloMetricRecorderV1,
} from '../promotion/slo-metrics-v1.js';
import type { BudgetFamilyV1 } from '../contracts/extraction-artifact-v1.js';

export interface ProjectionPlanPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface ProjectionPlanRepositoryV1 {
  /** Idempotent on `projectionPlanId`, which is content-addressed. */
  insert(record: DefenseBudgetProjectionPlanRecordV1): Promise<void>;
  loadVerified(projectionPlanId: string): Promise<DefenseBudgetProjectionPlanRecordV1 | null>;
  loadForScope(
    cycleId: string,
    families: readonly BudgetFamilyV1[],
  ): Promise<DefenseBudgetProjectionPlanRecordV1[]>;
}

interface ProjectionPlanRowV1 {
  projectionPlanId: string;
  recordSchemaVersion: string;
  schemaVersion: string;
  family: string;
  cycleId: string;
  fiscalYear: number;
  contentSha256: string;
  producerVersion: string;
  certificationId: string | null;
  certificationSha256: string;
  artifactSetSha256: string;
  status: string;
  conflictCount: number;
  unsupportedCount: number;
  planDocument: unknown;
  planLocator: string | null;
}

const SELECT_COLUMNS = `
  "projection_plan_id"    AS "projectionPlanId",
  "record_schema_version" AS "recordSchemaVersion",
  "schema_version"        AS "schemaVersion",
  "family",
  "cycle_id"              AS "cycleId",
  "fiscal_year"           AS "fiscalYear",
  "content_sha256"        AS "contentSha256",
  "producer_version"      AS "producerVersion",
  "certification_id"      AS "certificationId",
  "certification_sha256"  AS "certificationSha256",
  "artifact_set_sha256"   AS "artifactSetSha256",
  "status",
  "conflict_count"        AS "conflictCount",
  "unsupported_count"     AS "unsupportedCount",
  "plan_document"         AS "planDocument",
  "plan_locator"          AS "planLocator"
`;

export class PrismaProjectionPlanRepositoryV1 implements ProjectionPlanRepositoryV1 {
  private readonly sloMetrics: SloMetricRecorderV1;

  /**
   * Phase 7 Gap 5 decision C. `sloMetrics` is optional and defaults to a
   * no-op, so every existing caller keeps compiling unchanged. Measures
   * `projection_plan_load_latency_ms` around `loadVerified` and
   * `loadForScope` — the reload-and-verify step decision A4's architecture
   * makes load-bearing for every family, so its latency is exactly the number
   * an SLO for "can Phase 7 reload a plan fast enough" needs.
   */
  constructor(
    private readonly prisma: ProjectionPlanPrismaLikeV1,
    sloMetrics?: SloMetricRecorderV1,
  ) {
    this.sloMetrics = sloMetrics ?? NOOP_SLO_METRIC_RECORDER_V1;
  }

  async insert(record: DefenseBudgetProjectionPlanRecordV1): Promise<void> {
    // Re-validated rather than trusted: this is the last gate before a row the
    // database then freezes with an append-only trigger.
    const parsed = defenseBudgetProjectionPlanRecordV1Schema.parse(record);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "defense_budget_projection_plan" (
         "projection_plan_id", "record_schema_version", "schema_version", "family",
         "cycle_id", "fiscal_year", "content_sha256", "producer_version",
         "certification_id", "certification_sha256", "artifact_set_sha256",
         "status", "conflict_count", "unsupported_count", "plan_document"
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
       ON CONFLICT ("projection_plan_id") DO NOTHING`,
      parsed.projectionPlanId,
      parsed.recordSchemaVersion,
      parsed.schemaVersion,
      parsed.family,
      parsed.cycleId,
      parsed.fiscalYear,
      parsed.contentSha256,
      parsed.producerVersion,
      parsed.certificationId,
      parsed.certificationSha256,
      parsed.artifactSetSha256,
      parsed.status,
      parsed.conflictCount,
      parsed.unsupportedCount,
      JSON.stringify(parsed.planDocument),
    );
  }

  async loadVerified(
    projectionPlanId: string,
  ): Promise<DefenseBudgetProjectionPlanRecordV1 | null> {
    const startedAtMs = Date.now();
    try {
      const rows = await this.prisma.$queryRawUnsafe<ProjectionPlanRowV1[]>(
        `SELECT ${SELECT_COLUMNS}
           FROM "defense_budget_projection_plan"
          WHERE "projection_plan_id" = $1`,
        projectionPlanId,
      );
      const row = rows[0];
      return row == null ? null : verifyRowV1(row);
    } finally {
      this.sloMetrics.record('projection_plan_load_latency_ms', Date.now() - startedAtMs, {
        family: 'unspecified_single_lookup',
      });
    }
  }

  async loadForScope(
    cycleId: string,
    families: readonly BudgetFamilyV1[],
  ): Promise<DefenseBudgetProjectionPlanRecordV1[]> {
    if (families.length === 0) return [];
    const startedAtMs = Date.now();
    try {
      return await this.loadForScopeInner(cycleId, families);
    } finally {
      this.sloMetrics.record('projection_plan_load_latency_ms', Date.now() - startedAtMs, {
        family: [...families].sort((a, b) => a.localeCompare(b)).join('+'),
      });
    }
  }

  private async loadForScopeInner(
    cycleId: string,
    families: readonly BudgetFamilyV1[],
  ): Promise<DefenseBudgetProjectionPlanRecordV1[]> {
    // Parameterized IN list rather than an interpolated one: the families come
    // from an operator-supplied scope.
    const placeholders = families.map((_, index) => `$${index + 2}`).join(', ');
    const rows = await this.prisma.$queryRawUnsafe<ProjectionPlanRowV1[]>(
      `SELECT ${SELECT_COLUMNS}
         FROM "defense_budget_projection_plan"
        WHERE "cycle_id" = $1
          AND "family" IN (${placeholders})
        ORDER BY "projection_plan_id"`,
      cycleId,
      ...families,
    );
    return rows.map(verifyRowV1);
  }
}

/**
 * Storage is not proof. Every read re-derives what the row claims and refuses a
 * disagreement, which is the same stance
 * `PrismaPromotionEligibilityPersistenceRepositoryV1.findByHash` takes.
 */
function verifyRowV1(row: ProjectionPlanRowV1): DefenseBudgetProjectionPlanRecordV1 {
  if (row.planDocument == null) {
    // The locator storage mode is representable in the schema but has no reader
    // yet. Refusing beats silently treating an externally-stored plan as empty.
    throw new Error(
      `projection plan ${row.projectionPlanId} is stored at locator ${row.planLocator ?? '<null>'}; ` +
        `this build only reads inline plan documents`,
    );
  }

  const view = projectionPlanDocumentViewV1Schema.parse(row.planDocument);
  if (view.contentSha256 !== row.contentSha256) {
    throw new Error(
      `projection plan ${row.projectionPlanId} is filed under content SHA ${row.contentSha256} but ` +
        `its stored document declares ${view.contentSha256}; storage was tampered with`,
    );
  }

  const summary = summarizeProjectionPlanV1(view);
  if (
    summary.conflictCount !== row.conflictCount ||
    summary.unsupportedCount !== row.unsupportedCount ||
    summary.artifactSetSha256 !== row.artifactSetSha256 ||
    summary.status !== row.status
  ) {
    throw new Error(
      `projection plan ${row.projectionPlanId}'s stored summary disagrees with its document ` +
        `(stored: status=${row.status} conflicts=${row.conflictCount} unsupported=${row.unsupportedCount}; ` +
        `derived: status=${summary.status} conflicts=${summary.conflictCount} unsupported=${summary.unsupportedCount})`,
    );
  }

  return defenseBudgetProjectionPlanRecordV1Schema.parse({
    recordSchemaVersion: row.recordSchemaVersion,
    projectionPlanId: row.projectionPlanId,
    schemaVersion: row.schemaVersion,
    family: row.family,
    cycleId: row.cycleId,
    fiscalYear: Number(row.fiscalYear),
    contentSha256: row.contentSha256,
    producerVersion: row.producerVersion,
    certificationId: row.certificationId,
    certificationSha256: row.certificationSha256,
    artifactSetSha256: row.artifactSetSha256,
    status: row.status,
    conflictCount: Number(row.conflictCount),
    unsupportedCount: Number(row.unsupportedCount),
    planDocument: row.planDocument,
  });
}

export { buildProjectionPlanRecordV1 };
