/**
 * Business Development Phase 5 — DB-only watch evaluator CLI.
 *
 * Scheduled-task verb (`bizdev-watch-scan`). Reads ONLY existing canonical
 * projections through the runner; adds no ingestion path, no polling, no
 * sleep/retry and no timer — the scheduler is the sole retry owner (exit 0 lets
 * it re-invoke; nonzero is reserved for invalid config / fatal setup).
 *
 * Its ONE egress (MB-05) is the existing internal routine delivery owner, and
 * only when MERI_CONTROL_ORIGIN and INTERNAL_SERVICE_SECRET are configured: it
 * offers the committed canonical alerts to Meri's approved routine binding.
 * Without both, no network call is made at all.
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
  type BizDevWatchRunConfig,
  type BizDevProjectionDb,
  type BizDevWatchSourceEventSink,
} from '../src/business-development/bizdev-watch-runner.js';
import { createSourceEventDispositionSink } from '../src/business-development/bizdev-watch-source-event.js';

dotenvConfig();

/**
 * Interactive-transaction budget for the audited runner transactions (TD7 fix).
 *
 * Prisma's interactive default is 5s, which a VALID bounded source page can exceed: the TD7 run died at 5107ms
 * with "Transaction already closed" while a legal page was in flight. Nothing here changes coverage, retries,
 * projections or the lease — it only stops a legal transaction from being killed by a default nobody chose.
 *
 * What this budget IS: a configured, conservative, finite per-transaction cap (`maxWait` for pool
 * acquisition, `timeout` for the work).
 * What it is NOT: proof that the transaction fits the lease. The pass claims ONE `lease_until` before
 * discovery, and later per-watch transactions start after earlier work has already spent part of that window,
 * so a fixed duration can never mean "remaining time". The runner therefore reports the claimed window to
 * this adapter (`noteOwnershipDeadline`), and every transaction is clamped to what actually REMAINS:
 *
 *   timeout = min(BIZDEV_TRANSACTION_MAX_MS, remaining - BIZDEV_TRANSACTION_RESERVE_MS)
 *   maxWait = min(BIZDEV_TRANSACTION_MAX_WAIT_MS, timeout)
 *
 * and a transaction is REFUSED outright once the remaining window is below `BIZDEV_TRANSACTION_MIN_MS`
 * (fail closed and visible; the runner then records the failure and releases the lease through its own path).
 * The cap also stops a large configured lease (up to 3600s) from producing hour-long transactions.
 */
export const BIZDEV_TRANSACTION_MAX_MS = 120_000;
export const BIZDEV_TRANSACTION_MAX_WAIT_MS = 5_000;
export const BIZDEV_TRANSACTION_RESERVE_MS = 5_000;
export const BIZDEV_TRANSACTION_MIN_MS = 10_000;

/** The configured ceiling when no ownership window is known (it always is, in the CLI path). */
export function bizDevTransactionBudget(): { maxWait: number; timeout: number } {
  return { maxWait: BIZDEV_TRANSACTION_MAX_WAIT_MS, timeout: BIZDEV_TRANSACTION_MAX_MS };
}

/**
 * Budget for one transaction, clamped to the time actually remaining in the claimed ownership window.
 * Returns null when the window is too small to start a transaction at all.
 */
export function bizDevTransactionOptionsFor(
  deadlineAt: number | null,
  now: number = Date.now(),
): { maxWait: number; timeout: number } | null {
  if (deadlineAt == null) return bizDevTransactionBudget();
  const remaining = deadlineAt - now - BIZDEV_TRANSACTION_RESERVE_MS;
  if (remaining < BIZDEV_TRANSACTION_MIN_MS) return null;
  const timeout = Math.min(BIZDEV_TRANSACTION_MAX_MS, remaining);
  return { maxWait: Math.min(BIZDEV_TRANSACTION_MAX_WAIT_MS, timeout), timeout };
}

/**
 * Adapter over a raw PrismaClient exposing BOTH audited transaction shapes
 * the runner needs: withTenant (per-tenant scoped, sets app.current_tenant)
 * and withSystem (the audited RLS-bypass path, sets app.bypass_rls) — the
 * SAME GUC semantics as the app's PrismaService, used by the runner for the
 * bounded cross-tenant candidate + tenant-settings discovery ONLY.
 */
export function runnerDbFromClient(
  prisma: PrismaClient,
  now: () => number = Date.now,
): BizDevWatchRunnerDb {
  // The ONE ownership window this pass claimed (reported by the runner); null until it is known.
  let deadlineAt: number | null = null;
  const run = <T,>(cb: (tx: Prisma.TransactionClient) => Promise<T>) => {
    const options = bizDevTransactionOptionsFor(deadlineAt, now());
    if (!options) {
      // Fail closed inside the remaining window: never start a transaction that may outlive the lease.
      return Promise.reject(
        new Error(
          'Ownership window exhausted: no transaction budget remains inside the claimed lease (the run must not start further work)',
        ),
      );
    }
    return prisma.$transaction(cb, options);
  };
  return {
    noteOwnershipDeadline: (leaseUntil: Date) => {
      deadlineAt = leaseUntil.getTime();
    },
    withTenant: <T,>(
      tenantId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ) =>
      run(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }),
    withSystem: <T,>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      run(async (tx) => {
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
        sourceEvents: null,
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
  // MB-05: the ONE authorized egress of this verb. With both the configured Meri Control origin and the
  // shared internal service secret present, committed canonical alerts are offered to the existing routine
  // delivery owner; without them the sink is absent and this run makes NO network call at all.
  const origin = process.env.MERI_CONTROL_ORIGIN;
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  const sourceEvents: BizDevWatchSourceEventSink | null =
    origin && secret ? createSourceEventDispositionSink({ origin, secret }) : null;
  return runOnceWithClient(prisma, config, sourceEvents);
}

/**
 * ONE run against an already-constructed client: exactly the composition main() uses, with the clean
 * `$disconnect()` in `finally` (never `process.exit()` inside it). Exported so the transaction-lifetime tests
 * prove the CLI's own cleanup on the real path rather than a counter nobody calls.
 */
export async function runOnceWithClient(
  prisma: PrismaClient,
  config: BizDevWatchRunConfig,
  sourceEvents: BizDevWatchSourceEventSink | null,
): Promise<number> {
  try {
    // Explicit finite transaction bounds: a legal source page must outlive Prisma's 5s default, and every
    // transaction is clamped to the time actually remaining in the lease this pass claimed.
    const db = runnerDbFromClient(prisma);
    // Global projections are read through the same client handle (no
    // tenant_id, no RLS — the dossier's direct-delegate pattern).
    const projections = prisma as unknown as BizDevProjectionDb;
    const metrics = await runBizDevWatchEvaluation(db, projections, config, undefined, sourceEvents);
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
