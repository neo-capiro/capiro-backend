/**
 * Tracker alert readiness diagnostic (READ-ONLY — sends nothing, writes nothing).
 *
 * Answers "will the next detection cycle do anything, and is anyone configured
 * to receive it?" Per tenant it reports: tracked bills, email-enabled alert
 * prefs, tracked bills with a PENDING material move (not yet snapshotted), and
 * how many of those would actually email someone under current gates.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/diag-tracker-readiness.ts
 *
 * Safe to run anytime / as a one-off ECS task on any environment.
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';

dotenvConfig();

async function loadNest(): Promise<{ AppModule: any; TrackerChangeDetectorService: any }> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const det = await import(`${base}/tracker/tracker-change-detector.service.js`);
      return {
        AppModule: app.AppModule,
        TrackerChangeDetectorService: det.TrackerChangeDetectorService,
      };
    } catch {
      // try next base
    }
  }
  throw new Error('Could not load AppModule from dist or src');
}

/** Optional `--bill <billId>` arg → per-bill diagnosis instead of the aggregate. */
function parseBillArg(): string | null {
  const i = process.argv.indexOf('--bill');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const logger = new Logger('diag-tracker-readiness');
  const billId = parseBillArg();
  const { AppModule, TrackerChangeDetectorService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const svc = app.get(TrackerChangeDetectorService);

    if (billId) {
      const s = await svc.billStatus(billId);
      console.log(
        `BILL ${s.billId}: inCongressDb=${s.inCongressDb} latestAction="${(s.latestActionText ?? '').slice(0, 80)}" (${s.latestActionDate ?? 'n/a'})`,
      );
      console.log(
        `  pendingTypes=[${s.pendingTypes.join(',')}] trackedBy=${s.trackedBy.length} client(s)`,
      );
      for (const t of s.trackedBy) {
        console.log(
          `  tenant=${t.tenantId} client=${t.clientId} baselined=${t.baselined} lastSeen=${t.lastSeenActionDate ?? 'n/a'} currentlyPending=${t.currentlyPending} emailReadyRecipients=${t.emailReadyRecipients}`,
        );
      }
      if (!s.trackedBy.length) {
        logger.warn(
          `${s.billId} is NOT tracked by any client — it will never alert until Tracked.`,
        );
      } else if (s.trackedBy.every((t) => t.emailReadyRecipients === 0)) {
        logger.warn(
          `${s.billId} is tracked but NO recipient is email-ready for a floor-vote-class event (enable email + ensure Floor vote trigger + materiality ≤ Medium).`,
        );
      }
      return;
    }

    const { tenants, totals } = await svc.readinessReport();
    // console.log (not logger.log) so the report survives the ['warn','error']
    // boot log-level — Nest's Logger.log() is suppressed at those levels.
    console.log(
      `TOTALS: trackedBills=${totals.trackedBills} emailEnabledPrefs=${totals.emailEnabledPrefs} pendingChanges=${totals.pendingChanges} wouldEmail=${totals.wouldEmail}`,
    );
    for (const t of tenants.sort((a: any, b: any) => b.pendingChanges - a.pendingChanges)) {
      console.log(
        `  tenant=${t.tenantId} tracked=${t.trackedBills} emailPrefs=${t.emailEnabledPrefs} pending=${t.pendingChanges} wouldEmail=${t.wouldEmail}`,
      );
    }
    if (totals.trackedBills > 0 && totals.emailEnabledPrefs === 0) {
      logger.warn(
        'No alert preferences have email enabled anywhere — detection will write in-app changes but email nothing. Users must save Configure with email on.',
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
