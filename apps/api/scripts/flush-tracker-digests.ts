/**
 * Tracker digest flusher.
 *
 * Drains queued tracked-bill alerts (alert_digest_queue) and delivers ONE
 * summary per (user, channel) for the given cadence. Email supports daily +
 * weekly digests; SMS uses the daily bucket (quiet-hours + non-realtime SMS).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/flush-tracker-digests.ts --cadence daily
 *   pnpm --filter @capiro/api exec tsx scripts/flush-tracker-digests.ts --cadence weekly
 *
 * Schedule daily at the morning send time, weekly on Monday. Idempotent: rows
 * are marked flushed after each batch.
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';

dotenvConfig();

function parseCadence(): 'daily' | 'weekly' {
  const idx = process.argv.indexOf('--cadence');
  const v = idx >= 0 ? process.argv[idx + 1] : 'daily';
  return v === 'weekly' ? 'weekly' : 'daily';
}

async function loadNest(): Promise<{ AppModule: any; TrackerAlertService: any }> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const svc = await import(`${base}/tracker/notifications/tracker-alert.service.js`);
      return { AppModule: app.AppModule, TrackerAlertService: svc.TrackerAlertService };
    } catch {
      // try next base
    }
  }
  throw new Error('Could not load AppModule from dist or src');
}

async function main() {
  const cadence = parseCadence();
  const logger = new Logger('flush-tracker-digests');
  const { AppModule, TrackerAlertService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const svc = app.get(TrackerAlertService);
    const res = await svc.flushDigests(cadence);
    logger.log(`done. cadence=${cadence} flushed=${res.flushed} sent=${res.sent}`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
