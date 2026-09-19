/**
 * LegiWatch Live Hearings — committee source health probe (Phase 3).
 *
 *   pnpm --filter @capiro/api probe:committee-sources
 *
 * Probes every enabled `committee_source` and writes back
 * last_checked/last_success/last_error + a derived health state. This is the
 * cheapest job in the phase and the one that makes a silently-broken official
 * feed visible BEFORE a user notices a hearing missing from the calendar.
 *
 * Probes all configured adapters, not just the committee sites, because a central feed
 * going dark is the higher-impact failure — it takes a whole chamber with it.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import {
  DiscoveryJobsService,
  type ProbeAdapterMap,
  type ProbeableAdapter,
} from '../src/hearing-discovery/discovery-jobs.service.js';
import { SourceRegistryService } from '../src/hearing-discovery/source-registry.service.js';
import {
  CongressGovAdapter,
  currentCongress,
} from '../src/hearing-discovery/adapters/congress-gov.adapter.js';
import { HouseRepositoryAdapter } from '../src/hearing-discovery/adapters/house-repository.adapter.js';
import { SenateScheduleAdapter } from '../src/hearing-discovery/adapters/senate-schedule.adapter.js';
import { SenateCommitteeCalendarAdapter } from '../src/hearing-discovery/adapters/senate-committee-calendar.adapter.js';
import { CommitteeSiteAdapter } from '../src/hearing-discovery/adapters/committee-site.adapter.js';
import { GovInfoChrgAdapter } from '../src/hearing-discovery/adapters/govinfo-chrg.adapter.js';
import { numFlag } from './lib/job-flags.js';

dotenvConfig();

export function buildProbeAdapters(congress: number): ProbeAdapterMap {
  // Explicit type args: `new Map([...])` infers the FIRST entry's value type,
  // so an unannotated literal rejects the other configured adapters.
  return new Map<string, ProbeableAdapter>([
    [
      'congress-gov',
      new CongressGovAdapter({
        apiKey: process.env.CONGRESS_API_KEY ?? '',
        congresses: [congress],
      }),
    ],
    ['house-repository', new HouseRepositoryAdapter({ congress })],
    ['senate-schedule', new SenateScheduleAdapter({ congress })],
    ['senate-committee-calendar', new SenateCommitteeCalendarAdapter({ congress })],
    ['committee-site', new CommitteeSiteAdapter()],
    ['govinfo-chrg', new GovInfoChrgAdapter(process.env.GOVINFO_API_KEY ?? '')],
  ]);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const congress = numFlag('congress', currentCongress());
  try {
    await runWithSyncRun(prisma as never, 'probe-committee-sources', async () => {
      const registry = new SourceRegistryService(prisma);
      await registry.ensureCentralSources(congress);
      await registry.ensureCommitteeSiteSources();

      const adapters = buildProbeAdapters(congress);

      const jobs = new DiscoveryJobsService(prisma);
      return jobs.probeSources({
        adapters,
        limit: numFlag('limit', 200),
        delayMs: numFlag('delay-ms', 200),
        log: (m) => console.log(m),
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[probe-committee-sources] FAILED', err);
    process.exit(1);
  });
}
