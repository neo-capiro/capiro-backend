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
  type BizDevProjectionDb,
  type BizDevWatchSourceEventSink,
} from '../src/business-development/bizdev-watch-runner.js';
import { createSourceEventDispositionSink } from '../src/business-development/bizdev-watch-source-event.js';

dotenvConfig();

/**
 * Interactive-transaction budget for the audited runner transactions.
 *
 * Prisma's interactive default is a 5s timeout, which a VALID bounded source page can exceed: the TD7 run on
 * 2026-10-29 died at 5107ms with "Transaction already closed" while a legal page was still in flight. The
 * transaction is the unit of work for one claimed watch, and the runner already owns that watch through the
 * `lease_until = now + leaseSeconds` CAS — so the lease is the honest, finite bound for the transaction, not
 * an unlimited timeout.
 *
 * TIMEOUT  = lease window minus a reserve so the lease-predicated finalize/release still lands inside the
 *            window it protects (never equal to the lease, which would leave no room to release).
 * MAX_WAIT = bounded pool acquisition wait, never longer than the transaction itself.
 *
 * Both are finite and derived from the validated leaseSeconds (30..3600), so a run can never hold a
 * transaction past its own ownership window.
 */
export const BIZDEV_TRANSACTION_MAX_WAIT_MS = 10_000;
export const BIZDEV_TRANSACTION_LEASE_RESERVE_MS = 5_000;

export function bizDevTransactionOptions(leaseSeconds: number): { maxWait: number; timeout: number } {
  const leaseMs = Math.max(1, Math.trunc(leaseSeconds)) * 1000;
  const timeout = Math.max(BIZDEV_TRANSACTION_MAX_WAIT_MS, leaseMs - BIZDEV_TRANSACTION_LEASE_RESERVE_MS);
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
  options: { maxWait: number; timeout: number },
): BizDevWatchRunnerDb {
  return {
    withTenant: <T,>(
      tenantId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }, options),
    withSystem: <T,>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }, options),
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
  try {
    // Explicit finite transaction bounds derived from the validated lease: a legal source page must
    // outlive Prisma's 5s default, and no transaction may outlive the lease that owns it.
    const db = runnerDbFromClient(prisma, bizDevTransactionOptions(leaseSeconds));
    // Global projections are read through the same client handle (no
    // tenant_id, no RLS — the dossier's direct-delegate pattern).
    const projections = prisma as unknown as BizDevProjectionDb;
    // MB-05: the ONE authorized egress of this verb. With both the configured Meri Control origin
    // and the shared internal service secret present, committed canonical alerts are offered to
    // the existing routine delivery owner; without them the sink is absent and this run makes NO
    // network call at all (the pre-MB-05 behaviour, unchanged). It is never a runtime/control
    // bearer, and the binding read comes from Meri's own durable owner.
    const origin = process.env.MERI_CONTROL_ORIGIN;
    const secret = process.env.INTERNAL_SERVICE_SECRET;
    // The per-alert disposition owner: it reports Meri's exact terminal answer FOR EACH offered alert, so
    // the runner advances its durable oldest-first recovery cursor only over what Meri definitively
    // answered and never past an UNKNOWN. It reports the same aggregate counts as before.
    const sourceEvents: BizDevWatchSourceEventSink | null =
      origin && secret ? createSourceEventDispositionSink({ origin, secret }) : null;
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
