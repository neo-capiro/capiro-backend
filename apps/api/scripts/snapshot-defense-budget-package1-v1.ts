/**
 * Package 1 exact queue-recovery inventory.
 *
 * This command is SELECT-only by construction: it begins one interactive
 * transaction, marks it READ ONLY, and inventories only pending/failed/
 * dead-letter governed-ingestion rows. It reports the immutable identities
 * and live qualification counts Package E needs without printing payload
 * bytes, credentials, or free-form parser errors.
 */
import { PrismaClient } from '@prisma/client';

type QueryClient = {
  $executeRawUnsafe(query: string): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

export const PACKAGE1_QUEUE_INVENTORY_SQL = `
SELECT
  o.id,
  o.observation_id,
  o.cycle_id,
  o.job_kind,
  o.state,
  o.attempts,
  o.available_at,
  o.leased_by,
  o.leased_until,
  o.created_at,
  o.updated_at,
  encode(digest(coalesce(o.last_error, ''), 'sha256'), 'hex') AS last_error_sha256,
  o.metadata_jsonb ->> 'governedDisposition' AS governed_disposition,
  o.metadata_jsonb ->> 'verifierDecision' AS verifier_decision,
  obs.observation_state,
  obs.source_document_id,
  obs.content_sha256 AS observation_sha256,
  obs.byte_size AS observation_byte_size,
  obs.classified_fiscal_year,
  obs.classified_authority_track,
  obs.classified_stage,
  obs.classified_source_family,
  obs.discovered_url,
  obs.superseded_by_observation_id,
  sd.source_key,
  sd.fiscal_year AS source_fiscal_year,
  sd.component,
  sd.source_url,
  sd.sha256 AS source_sha256,
  sd.byte_size AS source_byte_size,
  sd.archive_bucket,
  sd.archive_s3_key,
  sd.archive_version_id,
  sd.superseded_by_document_id,
  coalesce(counts.candidate_count, 0)::int AS candidate_count,
  coalesce(counts.active_approval_count, 0)::int AS active_approval_count,
  coalesce(counts.correction_count, 0)::int AS correction_count,
  reservation.manifest_id AS reserved_manifest_id,
  reservation.item_status AS reserved_item_status,
  (o.available_at <= clock_timestamp()
    AND (o.leased_until IS NULL OR o.leased_until <= clock_timestamp())) AS due_and_unleased,
  (obs.observation_state = 'ingested') AS observation_ingested,
  (obs.superseded_by_observation_id IS NULL
    AND sd.superseded_by_document_id IS NULL) AS current_source,
  (sd.id IS NOT NULL
    AND sd.sha256 IS NOT NULL
    AND sd.byte_size IS NOT NULL
    AND sd.archive_bucket IS NOT NULL
    AND sd.archive_s3_key IS NOT NULL
    AND sd.archive_version_id IS NOT NULL) AS archive_version_pinned,
  (o.state IN ('pending', 'failed')
    AND o.available_at <= clock_timestamp()
    AND (o.leased_until IS NULL OR o.leased_until <= clock_timestamp())
    AND obs.observation_state = 'ingested'
    AND obs.superseded_by_observation_id IS NULL
    AND sd.id IS NOT NULL
    AND sd.superseded_by_document_id IS NULL
    AND sd.sha256 IS NOT NULL
    AND sd.byte_size IS NOT NULL
    AND sd.archive_bucket IS NOT NULL
    AND sd.archive_s3_key IS NOT NULL
    AND sd.archive_version_id IS NOT NULL
    AND coalesce(counts.candidate_count, 0) = 0
    AND coalesce(counts.active_approval_count, 0) = 0
    AND coalesce(counts.correction_count, 0) = 0
    AND reservation.manifest_id IS NULL) AS manifest_eligible_now,
  (o.state = 'dead_letter'
    AND o.leased_by IS NULL
    AND (o.metadata_jsonb ->> 'governedDisposition') = 'verification_rejected'
    AND (o.metadata_jsonb ->> 'verifierDecision') = 'REJECT') AS replay_eligible_now
FROM defense_budget_ingestion_outbox o
JOIN defense_budget_source_observation obs ON obs.id = o.observation_id
LEFT JOIN source_document sd ON sd.id = obs.source_document_id
LEFT JOIN LATERAL (
  SELECT
    (SELECT count(*)
       FROM budget_extraction_candidate_v1 c
      WHERE c.source_document_id = sd.id) AS candidate_count,
    (SELECT count(*)
       FROM budget_scoped_fact_review_v1 r
       JOIN budget_extraction_candidate_v1 c ON c.id = r.candidate_id
      WHERE c.source_document_id = sd.id AND r.status = 'active') AS active_approval_count,
    (SELECT count(DISTINCT cc.id)
       FROM budget_candidate_correction_v1 cc
       JOIN budget_extraction_candidate_v1 old_c ON old_c.id = cc.old_candidate_id
       JOIN budget_extraction_candidate_v1 new_c ON new_c.id = cc.new_candidate_id
      WHERE old_c.source_document_id = sd.id OR new_c.source_document_id = sd.id) AS correction_count
) counts ON true
LEFT JOIN LATERAL (
  SELECT mi.manifest_id, mi.status AS item_status
    FROM defense_budget_ingestion_manifest_item_v1 mi
   WHERE mi.outbox_row_id = o.id
   ORDER BY mi.created_at DESC
   LIMIT 1
) reservation ON true
WHERE o.state IN ('pending', 'failed', 'dead_letter')
ORDER BY o.state, o.available_at, o.id`;

export function normalizePackage1QueueInventoryValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizePackage1QueueInventoryValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizePackage1QueueInventoryValue(child),
      ]),
    );
  }
  return value;
}

export async function collectPackage1QueueInventory(client: QueryClient) {
  await client.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const rows = await client.$queryRawUnsafe<unknown[]>(PACKAGE1_QUEUE_INVENTORY_SQL);
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    environment: process.env.CAPIRO_ENVIRONMENT ?? process.env.NODE_ENV ?? 'unknown',
    gitSha: process.env.GIT_SHA ?? 'UNVERIFIED',
    transactionMode: 'READ ONLY',
    rowCount: rows.length,
    rows: normalizePackage1QueueInventoryValue(rows),
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/snapshot-defense-budget-package1-v1.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const unknownArgs = process.argv.slice(2).filter((arg) => arg !== '--pretty');
  if (unknownArgs.length > 0) throw new Error(`Unknown arguments: ${unknownArgs.join(', ')}`);

  const prisma = new PrismaClient();
  try {
    const inventory = await prisma.$transaction(
      async (transaction) => collectPackage1QueueInventory(transaction as unknown as QueryClient),
      { timeout: 60_000 },
    );
    const spacing = process.argv.includes('--pretty') ? 2 : 0;
    process.stdout.write(`${JSON.stringify(inventory, null, spacing)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
