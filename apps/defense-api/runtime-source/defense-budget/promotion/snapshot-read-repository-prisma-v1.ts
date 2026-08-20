/**
 * Phase 7 Workstream M — Prisma behind `SnapshotReadPortV1`.
 *
 * Reads only. This adapter holds no INSERT, UPDATE, or DELETE, which is what
 * lets the general API serve role use it: `capiro_app` has SELECT on the
 * canonical tables and nothing more, and the canonical-row trigger refuses a
 * write from it regardless.
 */
import type {
  ActiveSnapshotV1,
  SnapshotCanonicalRowV1,
  SnapshotReadPortV1,
  SnapshotRowQueryV1,
} from './snapshot-read-repository-v1.js';
import { exactDecimalFromColumnV1 } from './promotion-outbox-drain-repository-prisma-v1.js';
import { manualOverrideFromRowV1 } from './manual-override-repository-prisma-v1.js';

export interface SnapshotReadPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

const DEFAULT_ROW_LIMIT = 5_000;
const MAX_ROW_LIMIT = 50_000;

const ACTIVE_SNAPSHOT_SQL = `
  SELECT s."id"::text AS "snapshot_id", p."domain", p."environment", s."status",
         s."activated_at", s."snapshot_hash"
    FROM "defense_budget_active_snapshot" p
    JOIN "defense_budget_canonical_snapshot" s ON s."id" = p."snapshot_id"
   WHERE p."domain" = $1 AND p."environment" = $2`;

const ROW_COLUMNS = `
  "snapshot_id"::text AS "snapshot_id", "canonical_entity", "canonical_natural_key",
  "parent_natural_key", "family", "fiscal_year", "funding_field", "stage",
  "canonical_row_hash", "money_original_value", "money_original_unit", "money_value_millions",
  "quantity", "unit_cost_dollars", "text_value", "date_value", "attributes",
  "direct_or_derived", "source_projection_id", "verification_candidate_id",
  "verification_run_id", "artifact_id", "source_document_id", "enactment_proof_id"`;

function isoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isoInstant(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function snapshotRowFromDbV1(row: Record<string, unknown>): SnapshotCanonicalRowV1 {
  const originalValue = row.money_original_value == null ? null : String(row.money_original_value);
  const originalUnit = row.money_original_unit == null ? null : String(row.money_original_unit);
  const valueMillions = exactDecimalFromColumnV1(row.money_value_millions, 'money_value_millions');
  return {
    snapshotId: String(row.snapshot_id),
    canonicalEntity: String(row.canonical_entity),
    canonicalNaturalKey: String(row.canonical_natural_key),
    parentNaturalKey: row.parent_natural_key == null ? null : String(row.parent_natural_key),
    family: String(row.family),
    fiscalYear: row.fiscal_year == null ? null : Number(row.fiscal_year),
    fundingField: row.funding_field == null ? null : String(row.funding_field),
    stage: row.stage == null ? null : String(row.stage),
    canonicalRowHash: String(row.canonical_row_hash),
    money:
      originalValue != null && originalUnit != null && valueMillions != null
        ? { originalValue, originalUnit, valueMillions }
        : null,
    quantity: exactDecimalFromColumnV1(row.quantity, 'quantity'),
    unitCostDollars: exactDecimalFromColumnV1(row.unit_cost_dollars, 'unit_cost_dollars'),
    textValue: row.text_value == null ? null : String(row.text_value),
    dateValue: isoDate(row.date_value),
    attributes:
      row.attributes != null && typeof row.attributes === 'object'
        ? (row.attributes as Record<string, unknown>)
        : {},
    directOrDerived: String(row.direct_or_derived),
    lineage: {
      sourceProjectionId: String(row.source_projection_id),
      verificationCandidateId: String(row.verification_candidate_id),
      verificationRunId: String(row.verification_run_id),
      artifactId: String(row.artifact_id),
      sourceDocumentId: String(row.source_document_id),
      enactmentProofId: row.enactment_proof_id == null ? null : String(row.enactment_proof_id),
    },
  };
}

function inClause(
  column: string,
  values: readonly (string | number)[] | undefined,
  params: unknown[],
  cast = '',
): string | null {
  if (values == null || values.length === 0) return null;
  const placeholders = values.map((value) => {
    params.push(value);
    return `$${params.length}${cast}`;
  });
  return `${column} IN (${placeholders.join(', ')})`;
}

export function buildSnapshotRowSqlV1(query: SnapshotRowQueryV1): {
  sql: string;
  params: unknown[];
} {
  const params: unknown[] = [query.snapshotId];
  const where = [`"snapshot_id" = $1::uuid`];

  if (query.canonicalEntity != null) {
    params.push(query.canonicalEntity);
    where.push(`"canonical_entity" = $${params.length}`);
  }
  const entities = inClause('"canonical_entity"', query.canonicalEntities, params);
  if (entities != null) where.push(entities);

  if (query.family != null) {
    params.push(query.family);
    where.push(`"family" = $${params.length}`);
  }
  if (query.parentNaturalKey != null) {
    params.push(query.parentNaturalKey);
    where.push(`"parent_natural_key" = $${params.length}`);
  }
  const keys = inClause('"canonical_natural_key"', query.naturalKeys, params);
  if (keys != null) where.push(keys);
  const years = inClause('"fiscal_year"', query.fiscalYears, params, '::int');
  if (years != null) where.push(years);
  const fields = inClause('"funding_field"', query.fundingFields, params);
  if (fields != null) where.push(fields);

  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_ROW_LIMIT), MAX_ROW_LIMIT);
  return {
    sql: `SELECT ${ROW_COLUMNS}
            FROM "defense_budget_canonical_row"
           WHERE ${where.join('\n             AND ')}
           ORDER BY "canonical_entity", "canonical_natural_key"
           LIMIT ${limit}`,
    params,
  };
}

/**
 * Exact target query for governed overrides. We query only targets already
 * present in the selected snapshot row set, so an override for another PE can
 * never bleed into this response. `IS NOT DISTINCT FROM` is required because
 * fiscalYear/fundingField are nullable parts of the governed target identity.
 */
export function buildSnapshotOverrideSqlV1(rows: readonly SnapshotCanonicalRowV1[]): {
  sql: string;
  params: unknown[];
} | null {
  const targets = new Map<string, SnapshotCanonicalRowV1>();
  for (const row of rows) {
    const key = `${row.canonicalEntity}\u0001${row.canonicalNaturalKey}\u0001${row.fiscalYear ?? ''}\u0001${row.fundingField ?? ''}`;
    targets.set(key, row);
  }
  if (targets.size === 0) return null;

  const params: unknown[] = [];
  const clauses: string[] = [];
  for (const row of targets.values()) {
    params.push(row.canonicalEntity);
    const entity = `$${params.length}`;
    params.push(row.canonicalNaturalKey);
    const naturalKey = `$${params.length}`;
    params.push(row.fiscalYear);
    const fiscalYear = `$${params.length}::int`;
    params.push(row.fundingField);
    const fundingField = `$${params.length}`;
    clauses.push(
      `("canonical_entity" = ${entity} AND "canonical_natural_key" = ${naturalKey} ` +
        `AND "fiscal_year" IS NOT DISTINCT FROM ${fiscalYear} ` +
        `AND "funding_field" IS NOT DISTINCT FROM ${fundingField})`,
    );
  }

  return {
    sql: `SELECT
            "override_id" AS "overrideId",
            "canonical_entity" AS "canonicalEntity",
            "canonical_natural_key" AS "canonicalNaturalKey",
            "fiscal_year" AS "fiscalYear",
            "funding_field" AS "fundingField",
            "money_original_value" AS "moneyOriginalValue",
            "money_original_unit" AS "moneyOriginalUnit",
            "money_value_millions" AS "moneyValueMillions",
            "author_actor_id" AS "authorActorId",
            "approver_actor_id" AS "approverActorId",
            "approver_role" AS "approverRole",
            "reason", "evidence_ids" AS "evidenceIds",
            "change_request_ref" AS "changeRequestRef",
            "status", "version",
            "prior_override_id" AS "priorOverrideId",
            "effective_from" AS "effectiveFrom",
            "effective_to" AS "effectiveTo",
            "proposed_at" AS "proposedAt",
            "approved_at" AS "approvedAt",
            "revoked_at" AS "revokedAt"
          FROM "defense_budget_manual_override"
         WHERE ${clauses.join('\n            OR ')}
         ORDER BY "canonical_entity", "canonical_natural_key", "fiscal_year", "funding_field", "version" DESC`,
    params,
  };
}

export function createSnapshotReadPortPrismaV1(
  prisma: SnapshotReadPrismaLikeV1,
): SnapshotReadPortV1 {
  return {
    async loadActiveSnapshot(domain: string, environment: string) {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        ACTIVE_SNAPSHOT_SQL,
        domain,
        environment,
      );
      const row = rows[0];
      if (row == null) return null;
      const active: ActiveSnapshotV1 = {
        snapshotId: String(row.snapshot_id),
        domain: String(row.domain),
        environment: String(row.environment),
        status: String(row.status),
        activatedAt: isoInstant(row.activated_at),
        snapshotHash: row.snapshot_hash == null ? null : String(row.snapshot_hash),
      };
      return active;
    },

    async loadRows(query: SnapshotRowQueryV1) {
      const { sql, params } = buildSnapshotRowSqlV1(query);
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
      return rows.map(snapshotRowFromDbV1);
    },

    async loadManualOverridesForRows(rows) {
      const built = buildSnapshotOverrideSqlV1(rows);
      if (built == null) return [];
      const stored = await prisma.$queryRawUnsafe<Array<Parameters<typeof manualOverrideFromRowV1>[0]>>(
        built.sql,
        ...built.params,
      );
      return stored.map(manualOverrideFromRowV1);
    },
  };
}
