/** Prisma claim/lease adapter for the lifecycle ingestion outbox. */
import {
  drainBackoffMsV1,
  OUTBOX_DEFAULT_BATCH_SIZE_V1,
  OUTBOX_PROCESSING_LEASE_MS_V1,
} from './promotion/promotion-outbox-drain-v1.js';

export interface IngestionOutboxRowV1 {
  id: string;
  observationId: string;
  attempts: number;
}
export interface IngestionOutboxDrainRepositoryV1 {
  claimBatch(input: {
    leaseOwner: string;
    limit?: number;
    now: Date;
  }): Promise<IngestionOutboxRowV1[]>;
  claimReadinessPendingBatch(input: {
    leaseOwner: string;
    limit?: number;
    now: Date;
  }): Promise<IngestionOutboxRowV1[]>;
  claimReadinessPendingRow(input: {
    rowId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<boolean>;
  markSucceeded(rowId: string, leasedBy: string, now: Date): Promise<boolean>;
  markRetryableFailure(input: {
    rowId: string;
    leasedBy: string;
    now: Date;
    attemptsBefore: number;
    detail: string;
  }): Promise<boolean>;
  markGoverned(input: {
    rowId: string;
    leasedBy: string;
    disposition: 'governed_review' | 'governed_reject';
    detail: string;
    metadata: Record<string, unknown>;
  }): Promise<boolean>;
  markDeadLetterPoison(input: {
    rowId: string;
    leasedBy: string;
    detail: string;
    metadata: Record<string, unknown>;
  }): Promise<boolean>;
  markReadinessSucceeded(input: {
    rowId: string;
    leasedBy: string;
    now: Date;
    outcome: Record<string, unknown>;
  }): Promise<boolean>;
  markReadinessRetryableFailure(input: {
    rowId: string;
    leasedBy: string;
    now: Date;
    attemptsBefore: number;
    detail: string;
  }): Promise<boolean>;
  markReadinessDeferredCommittee(input: { rowId: string; leasedBy: string }): Promise<boolean>;
  markReadinessNotApplicable(input: { rowId: string; leasedBy: string }): Promise<boolean>;
}
export interface IngestionOutboxDrainPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}
export interface IngestionOutboxRepositoryOptionsV1 {
  leaseMs?: number;
}
const MAX_ERROR_LENGTH = 4_000;

export function ingestionOutboxClaimSqlV1(
  options: IngestionOutboxRepositoryOptionsV1 = {},
): string {
  const leaseMs = options.leaseMs ?? OUTBOX_PROCESSING_LEASE_MS_V1;
  return `WITH eligible AS (
 SELECT o."id" FROM "defense_budget_ingestion_outbox" o
 WHERE ((o."state" IN ('pending','failed') AND o."available_at" <= $1::timestamptz)
    OR (o."state" = 'leased' AND o."leased_until" <= $1::timestamptz))
 ORDER BY o."created_at", o."id" LIMIT $2 FOR UPDATE OF o SKIP LOCKED
) UPDATE "defense_budget_ingestion_outbox" t
 SET "state"='leased', "leased_by"=$3, "leased_until"=$1::timestamptz + (${leaseMs} * INTERVAL '1 millisecond'), "updated_at"=$1::timestamptz
 FROM eligible e WHERE t."id"=e."id"
 RETURNING t."id", t."observation_id", t."attempts"`;
}

export function ingestionOutboxReadinessClaimSqlV1(
  options: IngestionOutboxRepositoryOptionsV1 = {},
): string {
  const leaseMs = options.leaseMs ?? OUTBOX_PROCESSING_LEASE_MS_V1;
  return `WITH eligible AS (
 SELECT o."id" FROM "defense_budget_ingestion_outbox" o
 WHERE o."state"='succeeded'
   AND o."metadata_jsonb"->>'readinessPhase'='pending'
   AND (o."leased_until" IS NULL OR o."leased_until" <= $1::timestamptz)
   AND o."available_at" <= $1::timestamptz
 ORDER BY o."created_at", o."id" LIMIT $2 FOR UPDATE OF o SKIP LOCKED
) UPDATE "defense_budget_ingestion_outbox" t
 SET "leased_by"=$3, "leased_until"=$1::timestamptz + (${leaseMs} * INTERVAL '1 millisecond'), "updated_at"=$1::timestamptz
 FROM eligible e WHERE t."id"=e."id"
 RETURNING t."id", t."observation_id", COALESCE((t."metadata_jsonb"->>'readinessAttempts')::int, 0) AS "attempts"`;
}

export function createIngestionOutboxDrainRepositoryPrismaV1(
  prisma: IngestionOutboxDrainPrismaLikeV1,
  options: IngestionOutboxRepositoryOptionsV1 = {},
): IngestionOutboxDrainRepositoryV1 {
  const guarded = `WHERE "id"=$1::uuid AND "state"='leased' AND "leased_by"=$2 RETURNING "id"`;
  const readinessGuarded = `WHERE "id"=$1::uuid AND "state"='succeeded' AND "metadata_jsonb"->>'readinessPhase'='pending' AND "leased_by"=$2 RETURNING "id"`;
  const matched = (rows: unknown[]) => rows.length > 0;
  return {
    async claimBatch(input) {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        ingestionOutboxClaimSqlV1(options),
        input.now.toISOString(),
        input.limit ?? OUTBOX_DEFAULT_BATCH_SIZE_V1,
        input.leaseOwner,
      );
      return rows.map((r) => ({
        id: String(r.id),
        observationId: String(r.observation_id),
        attempts: Number(r.attempts ?? 0),
      }));
    },
    async claimReadinessPendingBatch(input) {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        ingestionOutboxReadinessClaimSqlV1(options),
        input.now.toISOString(),
        input.limit ?? OUTBOX_DEFAULT_BATCH_SIZE_V1,
        input.leaseOwner,
      );
      return rows.map((r) => ({
        id: String(r.id),
        observationId: String(r.observation_id),
        attempts: Number(r.attempts ?? 0),
      }));
    },
    async claimReadinessPendingRow(input) {
      const leaseMs = options.leaseMs ?? OUTBOX_PROCESSING_LEASE_MS_V1;
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `UPDATE "defense_budget_ingestion_outbox" SET "leased_by"=$2, "leased_until"=$3::timestamptz + (${leaseMs} * INTERVAL '1 millisecond'), "updated_at"=$3::timestamptz WHERE "id"=$1::uuid AND "state"='succeeded' AND "metadata_jsonb"->>'readinessPhase'='pending' AND "leased_until" IS NULL AND "available_at" <= $3::timestamptz RETURNING "id"`,
        input.rowId,
        input.leaseOwner,
        input.now.toISOString(),
      );
      return matched(rows);
    },
    async markSucceeded(rowId, leasedBy, now) {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `UPDATE "defense_budget_ingestion_outbox" SET "state"='succeeded', "metadata_jsonb"="metadata_jsonb" || '{"readinessPhase":"pending","readinessAttempts":0}'::jsonb, "last_error"=NULL, "leased_by"=NULL, "leased_until"=NULL, "available_at"=$3::timestamptz, "updated_at"=$3::timestamptz ${guarded}`,
        rowId,
        leasedBy,
        now.toISOString(),
      );
      return matched(rows);
    },
    async markRetryableFailure(input) {
      const available = new Date(input.now.getTime() + drainBackoffMsV1(input.attemptsBefore));
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `UPDATE "defense_budget_ingestion_outbox" SET "state"='pending', "attempts"="attempts"+1, "available_at"=$3::timestamptz, "last_error"=$4, "leased_by"=NULL, "leased_until"=NULL, "updated_at"=$5::timestamptz ${guarded}`,
        input.rowId,
        input.leasedBy,
        available.toISOString(),
        input.detail.slice(0, MAX_ERROR_LENGTH),
        input.now.toISOString(),
      );
      return matched(rows);
    },
    async markGoverned(input) {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `UPDATE "defense_budget_ingestion_outbox" SET "state"='dead_letter', "metadata_jsonb"="metadata_jsonb" || $3::jsonb, "last_error"=$4, "leased_by"=NULL, "leased_until"=NULL, "updated_at"=now() ${guarded}`,
        input.rowId,
        input.leasedBy,
        JSON.stringify(input.metadata),
        input.detail.slice(0, MAX_ERROR_LENGTH),
      );
      return matched(rows);
    },
    async markDeadLetterPoison(input) {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `UPDATE "defense_budget_ingestion_outbox" SET "state"='dead_letter', "attempts"="attempts"+1, "metadata_jsonb"="metadata_jsonb" || $3::jsonb, "last_error"=$4, "leased_by"=NULL, "leased_until"=NULL, "updated_at"=now() ${guarded}`,
        input.rowId,
        input.leasedBy,
        JSON.stringify(input.metadata),
        input.detail.slice(0, MAX_ERROR_LENGTH),
      );
      return matched(rows);
    },
    async markReadinessSucceeded(input) {
      const metadata = { ...input.outcome, readinessPhase: 'succeeded' };
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `UPDATE "defense_budget_ingestion_outbox" SET "metadata_jsonb"="metadata_jsonb" || $3::jsonb, "last_error"=NULL, "leased_by"=NULL, "leased_until"=NULL, "updated_at"=$4::timestamptz ${readinessGuarded}`,
        input.rowId,
        input.leasedBy,
        JSON.stringify(metadata),
        input.now.toISOString(),
      );
      return matched(rows);
    },
    async markReadinessRetryableFailure(input) {
      const available = new Date(input.now.getTime() + drainBackoffMsV1(input.attemptsBefore));
      const metadata = {
        readinessPhase: 'pending',
        readinessAttempts: input.attemptsBefore + 1,
        readinessFailure: input.detail.slice(0, MAX_ERROR_LENGTH),
      };
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `UPDATE "defense_budget_ingestion_outbox" SET "metadata_jsonb"="metadata_jsonb" || $3::jsonb, "available_at"=$4::timestamptz, "leased_by"=NULL, "leased_until"=NULL, "updated_at"=$5::timestamptz ${readinessGuarded}`,
        input.rowId,
        input.leasedBy,
        JSON.stringify(metadata),
        available.toISOString(),
        input.now.toISOString(),
      );
      return matched(rows);
    },
    async markReadinessDeferredCommittee(input) {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `UPDATE "defense_budget_ingestion_outbox" SET "metadata_jsonb"="metadata_jsonb" || '{"readinessPhase":"deferred_committee"}'::jsonb, "leased_by"=NULL, "leased_until"=NULL, "updated_at"=now() ${readinessGuarded}`,
        input.rowId,
        input.leasedBy,
      );
      return matched(rows);
    },
    async markReadinessNotApplicable(input) {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `UPDATE "defense_budget_ingestion_outbox" SET "metadata_jsonb"="metadata_jsonb" || '{"readinessPhase":"not_applicable"}'::jsonb, "leased_by"=NULL, "leased_until"=NULL, "updated_at"=now() ${readinessGuarded}`,
        input.rowId,
        input.leasedBy,
      );
      return matched(rows);
    },
  };
}
