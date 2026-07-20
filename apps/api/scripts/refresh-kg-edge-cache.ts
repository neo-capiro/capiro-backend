/**
 * Refresh the kg_edge_cache materialized view (Track B M1).
 *
 *   pnpm --filter @capiro/api refresh:kg-edge-cache
 *
 * Calls refresh_kg_edge_cache() (SECURITY DEFINER, advisory-locked so two
 * overlapping cron fires can't pile up) which runs REFRESH MATERIALIZED VIEW.
 * Off-peak plain refresh — the nightly window has ~no graph reads, so the brief
 * ACCESS EXCLUSIVE is invisible. Wrapped in the shared SyncRun lifecycle so it
 * lands a run-ledger row + emits the one INGESTION_METRIC line the CloudWatch
 * IngestionErrorMetricFilter → alarm already watches (a failed refresh pages the
 * same way every other ingestion job does). Idempotent + safe to re-run.
 *
 * Requires DATABASE_URL. This is the autonomous replacement for the manual
 * out-of-band `SELECT refresh_kg_edge_cache()` used during the M1 bring-up.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runWithSyncRun(
      prisma as unknown as Parameters<typeof runWithSyncRun>[0],
      'refresh-kg-edge-cache',
      async (): Promise<RunCounts> => {
        console.log('[refresh-kg-edge-cache] starting REFRESH MATERIALIZED VIEW');
        await prisma.$executeRawUnsafe('SELECT refresh_kg_edge_cache()');
        // The MV has NO SELECT grant (only SECURITY DEFINER fns read it), so the
        // count goes through kg_edge_cache_count() — a definer-rights scalar.
        const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
          'SELECT kg_edge_cache_count() AS count',
        );
        const cached = Number(rows[0]?.count ?? 0);
        console.log(`[refresh-kg-edge-cache] DONE — ${cached} edges in kg_edge_cache`);
        // Report the materialized edge count as `inserted` so the run-ledger row
        // and INGESTION_METRIC carry the graph size (a sudden drop is visible in
        // the ingestion dashboard). No errors on the happy path.
        return { inserted: cached, updated: 0, skipped: 0, errors: 0 };
      },
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[refresh-kg-edge-cache] FAILED', err);
  process.exit(1);
});
