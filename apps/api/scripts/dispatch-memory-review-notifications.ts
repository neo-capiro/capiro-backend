/**
 * Drain a bounded batch of Memory Review notification obligations into the
 * recipient-scoped in-app notification table.
 *
 * This command never enables Memory Review and has no email transport.
 * The dispatcher re-checks the exact feature flags and tenant selection for
 * every claimed row.
 *
 *   pnpm exec tsx scripts/dispatch-memory-review-notifications.ts
 *   pnpm exec tsx scripts/dispatch-memory-review-notifications.ts --limit 100
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';

dotenvConfig();

function parseLimit(): number {
  const index = process.argv.indexOf('--limit');
  if (index < 0) return 50;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error('--limit must be an integer from 1 through 200.');
  }
  return value;
}

async function loadNest(): Promise<{
  AppModule: unknown;
  MemoryReviewNotificationDispatcherService: unknown;
}> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const dispatcher = await import(
        `${base}/memory/memory-review-notification-dispatcher.service.js`
      );
      return {
        AppModule: app.AppModule,
        MemoryReviewNotificationDispatcherService:
          dispatcher.MemoryReviewNotificationDispatcherService,
      };
    } catch {
      // Try the next build root.
    }
  }
  throw new Error('Could not load Memory Review dispatcher from dist or src.');
}

async function main(): Promise<void> {
  const limit = parseLimit();
  const { AppModule, MemoryReviewNotificationDispatcherService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule as never, {
    logger: ['warn', 'error'],
  });
  try {
    const dispatcher = app.get(
      MemoryReviewNotificationDispatcherService as never,
    ) as { dispatchBatch(batchSize: number): Promise<Record<string, number>> };
    const summary = await dispatcher.dispatchBatch(limit);
    process.stdout.write(`MEMORY_REVIEW_NOTIFICATION_DISPATCH ${JSON.stringify(summary)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
