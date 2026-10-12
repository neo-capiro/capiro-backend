/**
 * LegiWatch Live Hearings — committee-site enrichment job (Phase 3).
 *
 *   pnpm --filter @capiro/api enrich:committee-hearings -- --within-hours=48
 *
 * Walks upcoming canonical hearings that have an official page on their own
 * committee's host and pulls the facts only that page has yet: witnesses,
 * testimony/memo links, and any player the committee has posted. Separate from
 * central discovery because it runs on a different cadence (hot near an event)
 * and fails for different reasons (one committee's CMS, not a chamber feed).
 *
 * Never overwrites a Congress.gov-sourced witness list — see
 * DiscoveryJobsService.enrichCommitteeHearings for why filling beats clobbering.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { DiscoveryJobsService } from '../src/hearing-discovery/discovery-jobs.service.js';
import { SourceRegistryService } from '../src/hearing-discovery/source-registry.service.js';
import { boolFlag, numFlag } from './lib/job-flags.js';

dotenvConfig();

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/enrich-committee-hearings.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const dryRun = boolFlag('dry-run');
  try {
    await runWithSyncRun(prisma as never, 'enrich-committee-hearings', async () => {
      // Idempotent and cheap (one upsert per body); guarantees the per-committee
      // sources this job iterates actually exist rather than silently doing
      // nothing on a fresh environment.
      const registry = new SourceRegistryService(prisma);
      const { registered, skippedNoUrl } = await registry.ensureCommitteeSiteSources();
      console.log(
        `[enrich-committee-hearings] committee-site sources: ${registered} registered, ` +
          `${skippedNoUrl.length} bodies have no official URL in congress_committee`,
      );
      const jobs = new DiscoveryJobsService(prisma);
      return jobs.enrichCommitteeHearings({
        withinHours: numFlag(
          'within-hours',
          Number(process.env.HEARING_ENRICH_WITHIN_HOURS ?? 168),
        ),
        limit: numFlag('limit', 200),
        delayMs: numFlag('delay-ms', 250),
        dryRun,
        log: (m) => console.log(m),
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[enrich-committee-hearings] FAILED', err);
    process.exit(1);
  });
}
