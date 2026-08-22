/**
 * LegiWatch Live Hearings — committee coverage audit (Phase 3).
 *
 *   pnpm --filter @capiro/api audit:hearing-coverage
 *   pnpm --filter @capiro/api audit:hearing-coverage -- --json > coverage.json
 *
 * Emits one explicit status per congressional body — HEALTHY, DEGRADED,
 * CUSTOM_ADAPTER_REQUIRED, REVIEW_REQUIRED or UNAVAILABLE — derived from
 * measured source health and measured discovery, never asserted. The central
 * calendar working is NOT coverage of 46 committees, and this job exists to say
 * so out loud.
 *
 * Read-only: it writes nothing. Every unsupported body is printed with the
 * reason it is unsupported, which is the queue of adapter tasks.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { CoverageAuditService } from '../src/hearing-discovery/coverage-audit.service.js';
import { SourceRegistryService } from '../src/hearing-discovery/source-registry.service.js';
import { boolFlag, numFlag } from './lib/job-flags.js';

dotenvConfig();

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const asJson = boolFlag('json');
  try {
    await runWithSyncRun(prisma as never, 'audit-hearing-coverage', async () => {
      // Registering sources first means a fresh environment reports "no events
      // discovered yet" rather than the misleading "no source registered".
      if (!boolFlag('no-seed')) {
        const registry = new SourceRegistryService(prisma);
        await registry.ensureCommitteeSiteSources();
      }
      const audit = new CoverageAuditService(prisma);
      const report = await audit.run({ windowDays: numFlag('window-days', 60) });

      if (asJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(
          `\n[coverage] ${report.totals.bodies} congressional bodies, window ${report.windowDays}d\n` +
            `  HEALTHY=${report.totals.HEALTHY}  DEGRADED=${report.totals.DEGRADED}  ` +
            `CUSTOM_ADAPTER_REQUIRED=${report.totals.CUSTOM_ADAPTER_REQUIRED}  ` +
            `REVIEW_REQUIRED=${report.totals.REVIEW_REQUIRED}  UNAVAILABLE=${report.totals.UNAVAILABLE}\n`,
        );
        for (const b of report.bodies) {
          console.log(
            `  ${b.status.padEnd(24)} ${b.chamber.padEnd(6)} ${b.systemCode.padEnd(8)} ` +
              `events=${String(b.hearingsDiscovered).padStart(4)} upcoming=${String(b.upcomingHearings).padStart(3)} ` +
              `obs=${String(b.observations).padStart(4)} streams=${b.canResolveStreams ? 'y' : 'n'} ` +
              `serverCapture=${b.serverCaptureAllowed ? 'y' : 'n'}  ${b.committee.slice(0, 46)}`,
          );
        }
        if (report.unsupported.length) {
          console.log(`\n[coverage] ${report.unsupported.length} bodies need attention:`);
          for (const u of report.unsupported) {
            console.log(`  · ${u.systemCode} ${u.status} — ${u.reason}`);
          }
        }
      }
      // Read-only audit: reported as skipped rows, never as writes.
      return {
        inserted: 0,
        updated: 0,
        skipped: report.totals.bodies,
        errors: report.totals.UNAVAILABLE,
      };
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[audit-hearing-coverage] FAILED', err);
    process.exit(1);
  });
}
