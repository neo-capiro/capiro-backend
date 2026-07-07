import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module.js';

/**
 * One-off task runner (entrypoint `task <verb> [args...]`). Boots the Nest
 * application context WITHOUT the HTTP server, runs the verb, exits non-zero
 * on failure so ECS/EventBridge marks the run failed.
 *
 * Verbs registered here as the phases land:
 *   • lifecycle-daily  — trial conversions, reminder cadence, lockout,
 *                        retention sweep, never-started backstop (Phase 6).
 *   • report-llm-overage — daily Stripe overage meter reporting (Phase 2).
 *   • seed-legal-docs  — upsert the active ToS/SA versions (Phase 3).
 */
type Verb = (args: string[], app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>) => Promise<void>;

const VERBS: Record<string, Verb> = {
  // Registered by later phases. Keeping an explicit placeholder verb lets the
  // deploy pipeline smoke-test the runner before any real verb ships.
  noop: async () => {
    // eslint-disable-next-line no-console
    console.log('onboard task-runner: noop ok');
  },
};

async function main() {
  const [verb, ...args] = process.argv.slice(2);
  if (!verb || !VERBS[verb]) {
    // eslint-disable-next-line no-console
    console.error(`Unknown verb "${verb ?? ''}". Registered: ${Object.keys(VERBS).join(', ')}`);
    process.exit(2);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  const logger = new Logger('OnboardTaskRunner');
  const started = Date.now();
  try {
    logger.log(`Running verb "${verb}" args=[${args.join(', ')}]`);
    await VERBS[verb](args, app);
    logger.log(`Verb "${verb}" completed in ${Date.now() - started}ms`);
    await app.close();
    process.exit(0);
  } catch (err) {
    logger.error(`Verb "${verb}" failed: ${(err as Error).stack ?? err}`);
    await app.close().catch(() => undefined);
    process.exit(1);
  }
}

void main();

export { VERBS };
