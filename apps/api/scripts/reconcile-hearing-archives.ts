/**
 * LegiWatch Live Hearings — post-event archive reconciliation (Phase 3).
 *
 *   pnpm --filter @capiro/api reconcile:hearing-archives -- --lookback-days=30
 *
 * Closes out events whose day has fully passed: moves `event_status` to
 * 'completed' and, when an official transcript now exists for the hearing,
 * records an `official_transcript_posted` change-feed entry and advances
 * `coverage_status`.
 *
 * Deliberately conservative about completion — an event is only completed once
 * its calendar day is entirely past, never on a "start + N hours" guess, because
 * a consumer has to be able to trust `event_status` while a hearing is still
 * gavelled in.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { DiscoveryJobsService } from '../src/hearing-discovery/discovery-jobs.service.js';
import { boolFlag, numFlag } from './lib/job-flags.js';

dotenvConfig();

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runWithSyncRun(prisma as never, 'reconcile-hearing-archives', async () => {
      const jobs = new DiscoveryJobsService(prisma);
      return jobs.reconcileArchives({
        lookbackDays: numFlag('lookback-days', 30),
        limit: numFlag('limit', 1000),
        dryRun: boolFlag('dry-run'),
        log: (m) => console.log(m),
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[reconcile-hearing-archives] FAILED', err);
    process.exit(1);
  });
}
