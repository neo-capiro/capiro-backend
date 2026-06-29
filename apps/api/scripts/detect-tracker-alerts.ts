/**
 * Tracker change-detection worker.
 *
 * Scans every tracked bill for a material legislative move (amendment, hearing,
 * committee/floor vote, enactment, ...), snapshots each bill's last-seen action
 * so a move alerts exactly once, writes an IntelligenceChange (in-app changes
 * inbox + board change chip), and fans the alert out to each user's enabled
 * email/SMS channels (SMS dormant until provisioned).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/detect-tracker-alerts.ts
 *
 * Run after sync-congress. Idempotent: re-runs never double-send (NotificationLog
 * unique on alert/user/channel) and never re-emit (snapshot + IntelligenceChange
 * dedupe). Boots a Nest app context so all RLS handling + config goes through the
 * normal service path.
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
  const logger = new Logger('detect-tracker-alerts');
  const { AppModule, TrackerChangeDetectorService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const svc = app.get(TrackerChangeDetectorService);
    const res = await svc.runDetectionCycle();
    const byType = Object.entries(res.byType ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
    logger.log(
      `done. scanned=${res.scanned} baseline=${res.baseline} changed=${res.changed} alerted=${res.alerted}` +
        (byType ? ` | byType: ${byType}` : ''),
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
