import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { BillingOverageService } from '../billing/billing-overage.service.js';

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
type Verb = (
  args: string[],
  app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>,
) => Promise<void>;

const VERBS: Record<string, Verb> = {
  // Keeping an explicit placeholder verb lets the deploy pipeline smoke-test
  // the runner before any real verb ships.
  noop: async () => {
    // eslint-disable-next-line no-console
    console.log('onboard task-runner: noop ok');
  },

  /**
   * Daily LLM-overage meter report (EventBridge → RunTask ["task",
   * "report-llm-overage"]). Moved from apps/api/scripts/report-llm-overage.ts
   * — onboard-api is the single Stripe writer.
   */
  'report-llm-overage': async (_args, app) => {
    const overage = app.get(BillingOverageService);
    const results = await overage.reportOverageForAllTenants();
    const reported = results.filter((r) => r.reportedDeltaCents > 0);
    // eslint-disable-next-line no-console
    console.log(
      `report-llm-overage: ${results.length} paying tenants, ${reported.length} with new overage`,
    );
    for (const r of reported) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${r.tenantSlug}: +${r.reportedDeltaCents}¢ (used $${r.usedUsd.toFixed(2)} / allow $${r.allowanceUsd.toFixed(2)})`,
      );
    }
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
