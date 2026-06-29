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

async function main() {
  const logger = new Logger('diag-tracker-readiness');
  const { AppModule, TrackerChangeDetectorService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const svc = app.get(TrackerChangeDetectorService);
    const { tenants, totals } = await svc.readinessReport();
    logger.log(
      `TOTALS: trackedBills=${totals.trackedBills} emailEnabledPrefs=${totals.emailEnabledPrefs} pendingChanges=${totals.pendingChanges} wouldEmail=${totals.wouldEmail}`,
    );
    for (const t of tenants.sort((a: any, b: any) => b.pendingChanges - a.pendingChanges)) {
      logger.log(
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
