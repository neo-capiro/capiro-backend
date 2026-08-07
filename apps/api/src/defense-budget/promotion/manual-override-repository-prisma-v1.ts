/**
 * Phase 7 Workstream K — the Prisma adapter behind `ManualOverrideRepositoryV1`.
 *
 * The only place in Workstream K that knows about a database. Everything the
 * service decides is decided against the port; this file just moves rows.
 *
 * Two conversions matter and are done deliberately rather than incidentally:
 *
 * 1. **Money never becomes a JavaScript number.** `money_value_millions` is
 *    `NUMERIC(24,9)`, which the Prisma client hands back as a `Decimal`. It is
 *    stringified, never `.toNumber()`d, and it is written from the exact
 *    decimal string the proposer supplied.
 *
 *    It is then re-normalized, because those are not the same string. Postgres
 *    pads a NUMERIC to its declared scale, so `1.25` comes back `1.250000000`,
 *    which is not canonical form — canonical strips trailing fractional zeros.
 *    Without `parseCanonicalDecimalString` here, every override written to the
 *    database would fail to parse on the way back out. Normalization is exact:
 *    it moves no decimal point and drops no significant digit.
 * 2. **Timestamps cross as ISO strings**, because the contract compares them as
 *    instants and a `Date` round-trip through the record schema would have to
 *    be reparsed anyway.
 */
import type { PrismaClient } from '@prisma/client';
import {
  defenseBudgetManualOverrideV1Schema,
  DEFENSE_BUDGET_MANUAL_OVERRIDE_SCHEMA_VERSION,
  type DefenseBudgetManualOverrideV1,
} from './manual-override-v1.js';
import type {
  ManualOverrideRepositoryV1,
  ManualOverrideTargetV1,
} from './manual-override-service-v1.js';
import { parseCanonicalDecimalString } from '../contracts/decimal-string.js';

/** The Prisma delegate this adapter needs, named structurally so a test can fake it. */
type ManualOverrideDelegate = PrismaClient['defenseBudgetManualOverride'];

const iso = (value: Date | null | undefined): string | undefined =>
  value == null ? undefined : value.toISOString();

/**
 * A stored row back into the governed record.
 *
 * Parsed rather than cast: a row written before a schema change, or by anything
 * that bypassed the service, fails here instead of flowing on as a
 * well-typed-looking lie.
 */
export function manualOverrideFromRowV1(row: {
  overrideId: string;
  canonicalEntity: string;
  canonicalNaturalKey: string;
  fiscalYear: number | null;
  fundingField: string | null;
  moneyOriginalValue: string;
  moneyOriginalUnit: string;
  moneyValueMillions: { toString(): string };
  authorActorId: string;
  approverActorId: string | null;
  approverRole: string | null;
  reason: string;
  evidenceIds: unknown;
  changeRequestRef: string | null;
  status: string;
  version: number;
  priorOverrideId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  proposedAt: Date;
  approvedAt: Date | null;
  revokedAt: Date | null;
}): DefenseBudgetManualOverrideV1 {
  return defenseBudgetManualOverrideV1Schema.parse({
    schemaVersion: DEFENSE_BUDGET_MANUAL_OVERRIDE_SCHEMA_VERSION,
    overrideId: row.overrideId,
    canonicalEntity: row.canonicalEntity,
    naturalKey: row.canonicalNaturalKey,
    fiscalYear: row.fiscalYear ?? undefined,
    fundingField: row.fundingField ?? undefined,
    value: {
      originalValue: row.moneyOriginalValue,
      originalUnit: row.moneyOriginalUnit,
      // Decimal -> string -> canonical. Never `.toNumber()`.
      valueMillions: parseCanonicalDecimalString(row.moneyValueMillions.toString()),
    },
    governance: {
      authorActorId: row.authorActorId,
      approverActorId: row.approverActorId ?? undefined,
      approverRole: row.approverRole ?? undefined,
      reason: row.reason,
      evidenceIds: Array.isArray(row.evidenceIds) ? row.evidenceIds : [],
      changeRequestRef: row.changeRequestRef ?? undefined,
    },
    status: row.status,
    version: row.version,
    priorOverrideId: row.priorOverrideId ?? undefined,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: iso(row.effectiveTo),
    proposedAt: row.proposedAt.toISOString(),
    approvedAt: iso(row.approvedAt),
    revokedAt: iso(row.revokedAt),
  });
}

export function createManualOverrideRepositoryPrismaV1(
  delegate: ManualOverrideDelegate,
): ManualOverrideRepositoryV1 {
  return {
    async findLatestForTarget(target: ManualOverrideTargetV1) {
      const row = await delegate.findFirst({
        where: {
          canonicalEntity: target.canonicalEntity,
          canonicalNaturalKey: target.naturalKey,
          fiscalYear: target.fiscalYear,
          fundingField: target.fundingField,
        },
        orderBy: { version: 'desc' },
        select: { overrideId: true, version: true, status: true },
      });
      return row ?? null;
    },

    async findById(overrideId: string) {
      const row = await delegate.findUnique({ where: { overrideId } });
      return row == null ? null : manualOverrideFromRowV1(row);
    },

    async insert(record: DefenseBudgetManualOverrideV1, overrideHash: string) {
      await delegate.create({
        data: {
          overrideId: record.overrideId,
          canonicalEntity: record.canonicalEntity,
          canonicalNaturalKey: record.naturalKey,
          fiscalYear: record.fiscalYear ?? null,
          fundingField: record.fundingField ?? null,
          moneyOriginalValue: record.value.originalValue,
          moneyOriginalUnit: record.value.originalUnit,
          // The exact decimal string goes to NUMERIC(24,9) untouched.
          moneyValueMillions: record.value.valueMillions,
          authorActorId: record.governance.authorActorId,
          approverActorId: record.governance.approverActorId ?? null,
          approverRole: record.governance.approverRole ?? null,
          reason: record.governance.reason,
          evidenceIds: record.governance.evidenceIds,
          changeRequestRef: record.governance.changeRequestRef ?? null,
          status: record.status,
          version: record.version,
          priorOverrideId: record.priorOverrideId ?? null,
          effectiveFrom: new Date(record.effectiveFrom),
          effectiveTo: record.effectiveTo == null ? null : new Date(record.effectiveTo),
          proposedAt: new Date(record.proposedAt),
          approvedAt: record.approvedAt == null ? null : new Date(record.approvedAt),
          revokedAt: record.revokedAt == null ? null : new Date(record.revokedAt),
          overrideHash,
        },
      });
    },

    async markApproved({ overrideId, approverActorId, approvedAt }) {
      /*
       * Guarded on `status: 'proposed'` so a concurrent approval updates zero
       * rows rather than overwriting the first approver. The database refuses
       * the illegal transitions regardless — this makes the loser of the race
       * fail as a no-op instead of a constraint violation.
       */
      const result = await delegate.updateMany({
        where: { overrideId, status: 'proposed' },
        data: {
          status: 'approved',
          approverActorId,
          approverRole: 'capiro_admin',
          approvedAt: new Date(approvedAt),
        },
      });
      if (result.count === 0) {
        throw new Error(
          `manual override ${overrideId} was not awaiting approval; it may have been approved concurrently`,
        );
      }
    },
  };
}
