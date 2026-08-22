/**
 * Phase 27B — explicit, batch-triggered LearningSignal → candidate
 * generation worker.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/run-learning-signal-candidate-generation.ts [--tenant <tenantId>]
 *
 * Deliberately NOT wired to any cron/event trigger yet (handoff §18: prefer
 * explicit batch-triggering when nothing else fits, over inventing a new job
 * system this repo doesn't otherwise use for this kind of work). Run
 * manually, or from an operator-owned schedule, once
 * LEARNING_CANDIDATE_GENERATION=enabled for a tenant.
 *
 * Idempotent: every signal gets at most one outcome, ever
 * (learning_signal_candidate_outcome's unique constraint +
 * LearningSignalCandidateService's own existence check) — re-running this
 * script only processes signals that haven't been decided yet. A signal
 * that failed processing last run is retried automatically (no outcome row
 * was written for it), consistent with "failures do not break the
 * originating product action" — nothing here can, since it runs completely
 * decoupled from Meri feedback / CRM Fill's own request paths.
 *
 * Boots a Nest app context so tenant scoping, config, and DI all go through
 * the normal service path — no bespoke DB client.
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';

dotenvConfig();

async function loadNest(): Promise<{ AppModule: any; LearningSignalCandidateService: any; PrismaService: any }> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const svc = await import(`${base}/learning/learning-signal-candidate.service.js`);
      const prisma = await import(`${base}/prisma/prisma.service.js`);
      return {
        AppModule: app.AppModule,
        LearningSignalCandidateService: svc.LearningSignalCandidateService,
        PrismaService: prisma.PrismaService,
      };
    } catch {
      // try next base
    }
  }
  throw new Error('Could not load AppModule from dist or src');
}

function parseTenantArg(): string | null {
  const idx = process.argv.indexOf('--tenant');
  return idx >= 0 ? (process.argv[idx + 1] ?? null) : null;
}

async function main() {
  const { AppModule, LearningSignalCandidateService, PrismaService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const candidateGeneration = app.get(LearningSignalCandidateService);
    const prisma = app.get(PrismaService);

    const onlyTenant = parseTenantArg();
    const tenantIds: string[] = onlyTenant
      ? [onlyTenant]
      : (await prisma.withSystem((tx: any) => tx.tenant.findMany({ select: { id: true } }))).map(
          (t: { id: string }) => t.id,
        );

    let totalProcessed = 0;
    const byEligibility: Record<string, number> = {};
    for (const tenantId of tenantIds) {
      const outcomes = await candidateGeneration.processBatch(tenantId, 200);
      for (const outcome of outcomes) {
        totalProcessed += 1;
        byEligibility[outcome.eligibility] = (byEligibility[outcome.eligibility] ?? 0) + 1;
      }
    }

    const breakdown = Object.entries(byEligibility)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
    console.log(
      `done. tenants=${tenantIds.length} processed=${totalProcessed}` +
        (breakdown ? ` | byEligibility: ${breakdown}` : ' | nothing new to process'),
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
