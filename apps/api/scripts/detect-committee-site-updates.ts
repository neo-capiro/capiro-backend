/**
 * LegiWatch Live Hearings — committee-site update detection job (Phase 3).
 *
 *   pnpm --filter @capiro/api detect:committee-site-updates
 *
 * Walks every registered COMMITTEE_SITE source with a conditional GET and files
 * normalized change facts into `committee_site_update` — announcements,
 * postponements, cancellations, testimony and memo publications. This is the
 * feed Committee Rooms read.
 *
 * Distinct from `enrich-committee-hearings`: that job is per-HEARING and only
 * looks at event pages; this one is per-COMMITTEE and watches the landing page,
 * so it can see a hearing being announced before any central feed has it.
 *
 * Never stores page bodies. An unchanged page produces no rows (304 or a
 * matching content hash), and a repeated fact dedupes on `content_hash`.
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
    console.error('Usage: apps/api/scripts/detect-committee-site-updates.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    await runWithSyncRun(prisma as never, 'detect-committee-site-updates', async () => {
      const registry = new SourceRegistryService(prisma);
      const { registered, skippedNoUrl } = await registry.ensureCommitteeSiteSources();
      console.log(
        `[detect-committee-site-updates] sources: ${registered} registered; ` +
          `${skippedNoUrl.length} bodies unregisterable (no official URL): ` +
          `${skippedNoUrl.map((b) => b.systemCode).join(', ') || 'none'}`,
      );
      const jobs = new DiscoveryJobsService(prisma);
      return jobs.detectCommitteeUpdates({
        limit: numFlag('limit', 500),
        delayMs: numFlag('delay-ms', 400),
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
    console.error('[detect-committee-site-updates] FAILED', err);
    process.exit(1);
  });
}
