import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import {
  envDryRun,
  type EconomicSourceName,
  type EconomicSourceRunResult,
} from './district-economic-source.js';

/** Wrap the entire fetch/parse/write path, including failures before a source-run exists. */
export async function runEconomicSync(
  source: EconomicSourceName,
  run: (prisma: PrismaClient) => Promise<EconomicSourceRunResult>,
): Promise<void> {
  const prisma = new PrismaClient();
  const dryRun = envDryRun();
  try {
    // A rehearsal must never advance the committed job's watermark or block it.
    await runWithSyncRun(
      prisma,
      `sync-district-economic-${source}${dryRun ? ':dry-run' : ''}`,
      async () => {
        const result = await run(prisma);
        const unavailable = result.status === 'unavailable';
        return {
          inserted: 0,
          // The writer reports upserts, not an insert/update split.
          updated: result.rowsWritten,
          skipped: dryRun ? result.rowsSeen - result.rowsRejected : 0,
          errors: result.rowsRejected + (unavailable || result.status === 'failed' ? 1 : 0),
          complete: !dryRun && !unavailable && result.status !== 'failed',
          incompleteReason: unavailable
            ? 'Source unavailable; see district_economic_source_run'
            : dryRun
              ? 'Dry run: no facts committed'
              : undefined,
        };
      },
      { metricFormat: 'json' },
    );
  } finally {
    await prisma.$disconnect();
  }
}
