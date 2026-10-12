/**
 * Business Development Phase 5 — DB-only watch evaluator CLI.
 *
 * Scheduled-task verb (`bizdev-watch-scan`). Reads ONLY existing canonical
 * projections through the runner; performs ZERO network calls (INV-0), adds
 * no ingestion path, no polling, no sleep/retry — the scheduler is the sole
 * retry owner (exit 0 lets it re-invoke; nonzero is reserved for invalid
 * config / fatal setup).
 *
 * Args:
 *   --source-family <family>   repeatable / comma-separated; must be known
 *   --limit <n>                max watches this run (1..500)
 *
 * Prints ONE structured JSON metric summary line:
 *   {checked, baselined, candidates, duplicates, delivered, suppressed,
 *    partial, failed, durationMs}
 */
import { config as dotenvConfig } from 'dotenv';
import { parseArgs } from 'node:util';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  runBizDevWatchEvaluation,
  parseSourceFamilies,
  validateRunConfig,
  BIZDEV_WATCH_SOURCE_FAMILIES,
  type BizDevWatchRunnerDb,
  type BizDevProjectionDb,
} from '../src/business-development/bizdev-watch-runner.js';

dotenvConfig();

/**
 * Adapter over a raw PrismaClient exposing BOTH audited transaction shapes
 * the runner needs: withTenant (per-tenant scoped, sets app.current_tenant)
 * and withSystem (the audited RLS-bypass path, sets app.bypass_rls) — the
 * SAME GUC semantics as the app's PrismaService, used by the runner for the
 * bounded cross-tenant candidate + tenant-settings discovery ONLY.
 */
function runnerDbFromClient(prisma: PrismaClient): BizDevWatchRunnerDb {
  return {
    withTenant: <T,>(
      tenantId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }),
    withSystem: <T,>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }),
  };
}

/** Validated-run marker: the bounds validation above already ran (fail
 * closed, exit 2). This exists so the control flow reads clearly after the
 * early disabled-exit branch was hoisted above all validation. */
function validateThisRun(): boolean {
  return true;
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/run-bizdev-watch.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const { values } = parseArgs({
    options: {
      'source-family': { type: 'string', multiple: true },
      limit: { type: 'string' },
    },
  });

  // Global kill-switch from the validated env config. Reading process.env
  // directly (not the zod schema) keeps this script boot-independent; the
  // value semantics match config.schema.ts exactly.
  const enabled = ['true', '1', 'yes', 'on'].includes(
    (process.env.BIZDEV_WATCH_ENABLED ?? 'false').trim().toLowerCase(),
  );

  if (!enabled) {
    // Kill-switch off (or no source env): NOT an error — the scheduler keeps
    // ticking with zero work. Checked BEFORE any config validation so a
    // disabled run with no/empty source env still prints ONE zero-metric
    // JSON line and exits 0. Config validity is only enforced when the
    // evaluator would actually run.
    process.stdout.write(
      JSON.stringify({
        checked: 0,
        baselined: 0,
        candidates: 0,
        duplicates: 0,
        delivered: 0,
        suppressed: 0,
        partial: 0,
        failed: 0,
        durationMs: 0,
      }) + '\n',
    );
    return 0;
  }

  // --source-family: repeat flags and/or comma lists; unknown family is a
  // FATAL config error (nonzero exit) — never a silent skip.
  const familyArgs = values['source-family'] ?? [];
  const familyParts = familyArgs
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const known = new Set<string>(BIZDEV_WATCH_SOURCE_FAMILIES);
  for (const f of familyParts) {
    if (!known.has(f)) {
      process.stderr.write(
        `Unknown source family "${f}" (allowed: ${BIZDEV_WATCH_SOURCE_FAMILIES.join(', ')})\n`,
      );
      return 2;
    }
  }
  const sourceFamilies =
    familyParts.length > 0
      ? (familyParts as ('federal_award' | 'federal_assistance_award' | 'sam_opportunity' | 'tango_resource' | 'lda_filing' | 'acquisition_revision')[])
      : parseSourceFamilies(process.env.BIZDEV_WATCH_SOURCE_FAMILIES);

  // --limit: explicit per-run override of the max-watches bound.
  let maxWatchesPerRun: number;
  if (values.limit !== undefined) {
    const parsed = Number.parseInt(values.limit, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      process.stderr.write('--limit must be an integer between 1 and 500\n');
      return 2;
    }
    maxWatchesPerRun = parsed;
  } else {
    maxWatchesPerRun = Number.parseInt(process.env.BIZDEV_WATCH_MAX_PER_RUN ?? '50', 10);
    if (!Number.isInteger(maxWatchesPerRun) || maxWatchesPerRun < 1 || maxWatchesPerRun > 500) {
      process.stderr.write('BIZDEV_WATCH_MAX_PER_RUN must be an integer between 1 and 500\n');
      return 2;
    }
  }

  const maxRecordsPerSource = Number.parseInt(
    process.env.BIZDEV_WATCH_MAX_RECORDS_PER_SOURCE ?? '50',
    10,
  );
  const leaseSeconds = Number.parseInt(process.env.BIZDEV_WATCH_LEASE_SECONDS ?? '300', 10);

  const config = {
    enabled,
    sourceFamilies,
    maxWatchesPerRun,
    maxRecordsPerSource,
    leaseSeconds,
  };
  // Invalid bounds fail closed BEFORE any DB work.
  try {
    validateRunConfig(config);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (!validateThisRun()) return 2;
  const prisma = new PrismaClient();
  try {
    const db = runnerDbFromClient(prisma);
    // Global projections are read through the same client handle (no
    // tenant_id, no RLS — the dossier's direct-delegate pattern).
    const projections = prisma as unknown as BizDevProjectionDb;
    const metrics = await runBizDevWatchEvaluation(db, projections, config);
    // One structured JSON metric summary.
    process.stdout.write(JSON.stringify(metrics) + '\n');
    return 0;
  } finally {
    // Clean disconnect — never process.exit() inside this try/finally.
    await prisma.$disconnect();
  }
}

// main() resolves to the exit code; disconnect happens INSIDE main's
// try/finally and process.exit runs only AFTER it completes.
if (require.main === module) {
void main().then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
}
