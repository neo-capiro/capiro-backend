/**
 * Phase 7 Workstream L — Prisma behind the delta engine's two ports.
 *
 * Both sides of a change are read out of `defense_budget_canonical_row` by its
 * identity unique key, so each lookup returns at most one row and the engine
 * never has to decide which of several candidates it meant.
 *
 * Every NUMERIC column read here goes through `parseCanonicalDecimalString`.
 * Postgres pads a `NUMERIC(24,9)` to its declared scale, so a stored `1.25`
 * comes back `1.250000000`; comparing the padded form against a canonical form
 * would report a change on every unchanged row, and the engine decides "did
 * this move" by exact string equality.
 */
import {
  type CanonicalDeltaRecordV1,
  type CanonicalDeltaWriterV1,
  type CanonicalRowLookupV1,
  type CanonicalRowValuesV1,
} from './canonical-delta-engine-v1.js';
import { exactDecimalFromColumnV1 } from './promotion-outbox-drain-repository-prisma-v1.js';

export interface CanonicalDeltaPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

const LOOKUP_SQL = `
  SELECT "canonical_row_hash", "family", "fiscal_year", "funding_field", "stage",
         "money_original_value", "money_value_millions",
         "quantity", "unit_cost_dollars", "text_value", "date_value"
    FROM "defense_budget_canonical_row"
   WHERE "snapshot_id" = $1::uuid
     AND "canonical_entity" = $2
     AND "canonical_natural_key" = $3`;

/** A DATE column as `YYYY-MM-DD`, which is how the canonical row hash saw it. */
function isoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function canonicalRowValuesFromRowV1(row: Record<string, unknown>): CanonicalRowValuesV1 {
  return {
    canonicalRowHash: String(row.canonical_row_hash),
    family: String(row.family),
    fiscalYear: row.fiscal_year == null ? null : Number(row.fiscal_year),
    fundingField: row.funding_field == null ? null : String(row.funding_field),
    stage: row.stage == null ? null : String(row.stage),
    moneyOriginalValue: row.money_original_value == null ? null : String(row.money_original_value),
    moneyValueMillions: exactDecimalFromColumnV1(row.money_value_millions, 'money_value_millions'),
    quantity: exactDecimalFromColumnV1(row.quantity, 'quantity'),
    unitCostDollars: exactDecimalFromColumnV1(row.unit_cost_dollars, 'unit_cost_dollars'),
    textValue: row.text_value == null ? null : String(row.text_value),
    dateValue: isoDate(row.date_value),
  };
}

export function createCanonicalRowLookupPrismaV1(
  prisma: CanonicalDeltaPrismaLikeV1,
): CanonicalRowLookupV1 {
  return {
    async loadValues(snapshotId, canonicalEntity, canonicalNaturalKey) {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        LOOKUP_SQL,
        snapshotId,
        canonicalEntity,
        canonicalNaturalKey,
      );
      const row = rows[0];
      return row == null ? null : canonicalRowValuesFromRowV1(row);
    },
  };
}

/**
 * `ON CONFLICT DO NOTHING`, with no target named.
 *
 * Two unique constraints can reject this insert — the delta key and the
 * one-delta-per-outbox-row key — and a replayed drain can trip either. An
 * untargeted `DO NOTHING` covers both, where naming one would let the other
 * surface as an error on a retry that is behaving correctly.
 */
const INSERT_SQL = `
  INSERT INTO "defense_budget_canonical_delta" (
    "delta_key", "activation_id", "outbox_id", "old_snapshot_id", "new_snapshot_id",
    "canonical_entity", "canonical_natural_key", "family", "fiscal_year", "funding_field", "stage",
    "delta_kind", "changed_axes",
    "old_money_original_value", "old_money_value_millions",
    "new_money_original_value", "new_money_value_millions", "money_delta_millions",
    "old_quantity", "new_quantity", "old_unit_cost_dollars", "new_unit_cost_dollars",
    "change_classification", "suppress_alert", "alert_eligible",
    "materiality_score", "materiality_factors", "severity", "source_lineage"
  ) VALUES (
    $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
    $6, $7, $8, $9::int, $10, $11,
    $12, $13::jsonb,
    $14, $15::numeric,
    $16, $17::numeric, $18::numeric,
    $19::numeric, $20::numeric, $21::numeric, $22::numeric,
    $23, $24::boolean, $25::boolean,
    $26::numeric, $27::jsonb, $28, $29::jsonb
  )
  ON CONFLICT DO NOTHING`;

export function createCanonicalDeltaWriterPrismaV1(
  prisma: CanonicalDeltaPrismaLikeV1,
): CanonicalDeltaWriterV1 {
  return {
    async insertIfAbsent(record: CanonicalDeltaRecordV1) {
      await prisma.$queryRawUnsafe(
        INSERT_SQL,
        record.deltaKey,
        record.activationId,
        record.outboxId,
        record.oldSnapshotId,
        record.newSnapshotId,
        record.canonicalEntity,
        record.canonicalNaturalKey,
        record.family,
        record.fiscalYear,
        record.fundingField,
        record.stage,
        record.deltaKind,
        JSON.stringify(record.changedAxes),
        record.oldMoneyOriginalValue,
        record.oldMoneyValueMillions,
        record.newMoneyOriginalValue,
        record.newMoneyValueMillions,
        record.moneyDeltaMillions,
        record.oldQuantity,
        record.newQuantity,
        record.oldUnitCostDollars,
        record.newUnitCostDollars,
        record.changeClassification,
        record.suppressAlert,
        record.alertEligible,
        record.materialityScore,
        JSON.stringify(record.materialityFactors),
        record.severity,
        JSON.stringify(record.sourceLineage),
      );
    },
  };
}
