/** @cleanup-smoke noArgsExit=2 */
/**
 * Step 3.2 — generate materiality-gated, client-specific ActionRecommendation cards.
 *
 *   pnpm --filter @capiro/api generate-actions                      # DRY RUN (default)
 *   pnpm --filter @capiro/api generate-actions -- --commit          # persist (idempotent)
 *   pnpm --filter @capiro/api generate-actions -- --commit --tenant=<uuid>
 *   pnpm --filter @capiro/api generate-actions -- --commit --since=14
 *
 * Walks the current, material budget deltas and upserts ONE action card per
 * (client, delta, actionType) for every relevant (tenant, client). Idempotent: a re-run
 * creates no duplicates and never resets a card a human has moved past `new`.
 *
 * --commit actually persists; without it the script runs end-to-end in DRY RUN and reports
 * what WOULD be generated WITHOUT writing (it threads a `dryRun` flag into the generator,
 * which computes + counts each card but skips the DB upsert entirely). main() is guarded so
 * importing this module never auto-runs.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ClientPeRelevanceService } from '../src/intelligence/client-pe-relevance.service.js';
import { ActionRecommendationService } from '../src/intelligence/actions/action-recommendation.service.js';

dotenvConfig();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Read `--name value` or `--name=value`. */
function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function run(): Promise<{ mode: string; tenant: string; since: string; generated: number }> {
  const commit = flag('commit');
  const tenantId = arg('tenant');
  const sinceArg = arg('since');
  const sinceDays = sinceArg !== undefined ? Number(sinceArg) : undefined;
  if (sinceArg !== undefined && !Number.isFinite(sinceDays)) {
    throw new Error(`Invalid --since ${sinceArg}`);
  }

  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    const relevance = new ClientPeRelevanceService(prisma);
    const service = new ActionRecommendationService(prisma, relevance);

    // DRY RUN by default: the generator computes + counts each card but performs NO DB write
    // (it skips the per-card upsert when dryRun is set). --commit flips dryRun off and persists.
    const dryRun = !commit;
    const { generated } = await service.generate({ tenantId, sinceDays, dryRun });
    return {
      mode: commit ? 'COMMIT' : 'DRY_RUN',
      tenant: tenantId ?? 'all',
      since: sinceArg ?? 'all',
      generated,
    };
  } finally {
    await prisma.onModuleDestroy();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: generate-actions [--tenant=<uuid>] [--since=<days>] [--commit] (requires DATABASE_URL)');
    process.exitCode = 2;
    return;
  }
  const summary = await run();
  console.log(JSON.stringify(summary, null, 2));
}

// Guard against auto-running on import (so the spec can import `run` without side effects).
// `process.argv[1]` is the entrypoint path when invoked directly via tsx/node.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /generate-actions(\.[cm]?[jt]s)?$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  void main().catch((e) => {
    console.error('[generate-actions] fatal', (e as Error)?.stack || e);
    process.exit(1);
  });
}
