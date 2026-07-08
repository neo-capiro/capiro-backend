import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { BillingOverageService } from '../billing/billing-overage.service.js';
import { LegalService } from '../legal/legal.service.js';
import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * One-off task runner (entrypoint `task <verb> [args...]`). Boots the Nest
 * application context WITHOUT the HTTP server, runs the verb, exits non-zero
 * on failure so ECS/EventBridge marks the run failed.
 *
 * Verbs registered here as the phases land:
 *   • lifecycle-daily  — trial conversions, reminder cadence, lockout,
 *                        retention sweep, never-started backstop (Phase 6).
 *   • report-llm-overage — daily Stripe overage meter reporting (Phase 2).
 *   • seed-legal-docs  — upsert the active ToS/SA versions (Phase 3, live).
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
   * Daily trial/billing lifecycle engine (Phase 6): day-31 conversions,
   * reminder cadence, never-started backstop, wire/ACH lockout, 90-day
   * retention. EventBridge → RunTask ["task", "lifecycle-daily"].
   */
  'lifecycle-daily': async (_args, app) => {
    const lifecycle = app.get(LifecycleService);
    const summary = await lifecycle.runDaily();
    // eslint-disable-next-line no-console
    console.log(`lifecycle-daily summary: ${JSON.stringify(summary)}`);
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

  /**
   * READ-ONLY billing-posture dump for every tenant (ops/diag — safe to run
   * any time as a one-off ECS task). Prints one JSON line per tenant so a
   * lockout/enforcement question ("will tenant X get locked out?") is
   * answerable from CloudWatch logs without ad-hoc SQL.
   */
  'diag-billing-state': async (_args, app) => {
    const prisma = app.get(PrismaService);
    const rows = await prisma.withSystem((tx) =>
      tx.tenant.findMany({
        select: {
          slug: true,
          billingStatus: true,
          lockedAt: true,
          onboardingFlowVersion: true,
          trialEndsAt: true,
          clientSlots: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          priceLockExpiresAt: true,
        },
        orderBy: { slug: 'asc' },
      }),
    );
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `diag-billing-state: ${JSON.stringify({
          ...r,
          stripeCustomerId: r.stripeCustomerId ? 'set' : null,
          stripeSubscriptionId: r.stripeSubscriptionId ? 'set' : null,
        })}`,
      );
    }
  },

  /**
   * Seed/refresh the ACTIVE legal documents (Phase 3): ToS (variant 'all') +
   * SA trial/paid variants, version 2026.07-draft1. The content is the
   * COUNSEL-PENDING prototype draft (decision Q7) — see
   * src/legal/legal-doc-seed.ts. Idempotent: upserts by
   * (docType, planVariant, version) and de-activates older versions.
   */
  'seed-legal-docs': async (_args, app) => {
    const legal = app.get(LegalService);
    const seeded = await legal.seedDraftDocs();
    for (const doc of seeded) {
      // eslint-disable-next-line no-console
      console.log(`seed-legal-docs: ${doc.docType}/${doc.planVariant} v${doc.version} active`);
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
