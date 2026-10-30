/**
 * The CLI transaction lifetime (TD7 defect) — proven through the REAL adapter and the REAL runner.
 *
 * Confirmed failure this fixes: a normal scheduled TD7 run on Core525cd completed with a partial/failed
 * summary and no alert because the per-watch Prisma interactive transaction hit its 5s default (configured
 * 5000ms elapsed 5107ms) while a VALID bounded source page was still in flight. Nothing here changes page
 * coverage, retries, projections or lease semantics: the transaction is simply bounded by the run's own
 * lease instead of Prisma's default.
 *
 * Everything below drives `runnerDbFromClient` + `runBizDevWatchEvaluation` with an inert Prisma double that
 * enforces the *passed* options against a deterministic clock — no real 5s wait, no DB, no network.
 */
import {
  BIZDEV_TRANSACTION_MAX_WAIT_MS,
  BIZDEV_TRANSACTION_LEASE_RESERVE_MS,
  bizDevTransactionOptions,
  runnerDbFromClient,
} from './run-bizdev-watch';
import {
  runBizDevWatchEvaluation,
  validateRunConfig,
  type BizDevWatchRunConfig,
} from '../src/business-development/bizdev-watch-runner';

type TxOptions = { maxWait: number; timeout: number } | undefined;

/** Prisma-shaped expiry error, raised only when the callback exceeds the options ACTUALLY passed. */
class TransactionClosed extends Error {
  readonly code = 'P2028';
  constructor(elapsed: number, budget: number) {
    super(`Transaction already closed: expired after ${elapsed}ms (budget ${budget}ms)`);
  }
}

interface Recorded {
  options: TxOptions[];
  updates: unknown[];
  disconnects: number;
}

const TENANT = 'tenant-fixture';
const WATCH = 'watch-fixture';
const STATE = 'state-fixture';

/**
 * Inert PrismaClient: the audited transactions run for real (the adapter's own callback + GUC statement),
 * while the delegate work advances a deterministic clock. Expiry is decided by the options the adapter
 * passed, exactly as Prisma decides it.
 */
function inertPrisma(work: { ms: number }, options?: { throwOnFind?: boolean }) {
  const recorded: Recorded = { options: [], updates: [], disconnects: 0 };
  let elapsed = 0;
  const advance = (ms: number) => {
    elapsed += ms;
  };

  const tx = {
    $executeRaw: async () => {
      advance(1);
      return 1;
    },
    $queryRaw: async () => {
      advance(2);
      // SYSTEM discovery: exactly one enrolled, unleased source-state row to claim.
      return [{ id: STATE, tenantId: TENANT, watchId: WATCH, sourceFamily: 'federal_award' }];
    },
    businessDevelopmentWatch: {
      findFirst: async () => {
        advance(work.ms);
        if (options?.throwOnFind) throw new Error('unexpected delegate failure');
        // 'skipped' path: the watch row is already finalized/absent, so the page work is the only cost.
        return null;
      },
    },
    businessDevelopmentWatchSourceState: {
      updateMany: async (args: unknown) => {
        advance(1);
        recorded.updates.push(args);
        return { count: 1 };
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, txOptions?: TxOptions) => {
      recorded.options.push(txOptions);
      elapsed = 0;
      const result = await fn(tx);
      const budget = txOptions?.timeout ?? 5_000; // Prisma's interactive default
      if (elapsed > budget) throw new TransactionClosed(elapsed, budget);
      return result;
    },
    $disconnect: async () => {
      recorded.disconnects += 1;
    },
  };

  return {
    prisma: prisma as never,
    recorded,
    elapsed: () => elapsed,
  };
}

const config = (over: Partial<BizDevWatchRunConfig> = {}): BizDevWatchRunConfig => ({
  enabled: true,
  maxWatchesPerRun: 50,
  maxRecordsPerSource: 200,
  leaseSeconds: 300,
  sourceFamilies: ['federal_award'],
  ...over,
});

/** The runner reads projections through the same client handle; an inert projection is enough here. */
const projections = {} as never;

describe('run-bizdev-watch transaction lifetime', () => {
  test('bounds the audited transactions by the validated lease, not the 5s default', () => {
    const at = (leaseSeconds: number) => bizDevTransactionOptions(leaseSeconds);

    expect(at(300)).toEqual({
      timeout: 295_000,
      maxWait: BIZDEV_TRANSACTION_MAX_WAIT_MS,
    });
    // Floor: a 30s lease still exceeds Prisma's default and keeps the release reserve.
    expect(at(30)).toEqual({ timeout: 25_000, maxWait: BIZDEV_TRANSACTION_MAX_WAIT_MS });
    // Ceiling: the largest validated lease stays finite and below the lease itself.
    expect(at(3600).timeout).toBe(3_595_000);
    for (const lease of [30, 300, 3600]) {
      const options = at(lease);
      expect(Number.isFinite(options.timeout)).toBe(true);
      expect(options.timeout).toBeGreaterThan(5_000);
      expect(options.timeout).toBe(lease * 1000 - BIZDEV_TRANSACTION_LEASE_RESERVE_MS);
      expect(options.maxWait).toBeLessThanOrEqual(options.timeout);
    }
    // An invalid lease cannot produce an unbounded transaction.
    expect(Number.isFinite(at(0).timeout)).toBe(true);
  });

  test('valid work longer than the Prisma 5s default completes through the real runner and adapter', async () => {
    const fixture = inertPrisma({ ms: 8_000 });
    const db = runnerDbFromClient(fixture.prisma, bizDevTransactionOptions(300));

    const metrics = await runBizDevWatchEvaluation(db, projections, config());

    // The audited per-watch transaction really did 8s of work — past Prisma's 5s default — and committed
    // instead of expiring. (This fixture's watch finalizes as `skipped`, so the counted work is the
    // transaction lifetime itself, not a page; page metrics are covered by the runner suite.)
    expect(fixture.elapsed()).toBeGreaterThan(5_000);
    expect(metrics.failed).toBe(0);
    expect(fixture.recorded.updates).toHaveLength(0); // nothing to roll back: no error finalize ran
    expect(fixture.recorded.options.length).toBeGreaterThanOrEqual(3);
    for (const options of fixture.recorded.options)
      expect(options).toEqual(bizDevTransactionOptions(300));

    // The identical work under Prisma's default fails — that is the TD7 defect, reproduced.
    const unbounded = inertPrisma({ ms: 8_000 });
    const defaultDb = runnerDbFromClient(unbounded.prisma, { maxWait: 2_000, timeout: 5_000 });
    const degraded = await runBizDevWatchEvaluation(defaultDb, projections, config());
    expect(degraded.failed).toBe(1);
  });

  test('a transaction that outlives its budget rolls back and releases the lease through the existing path', async () => {
    // 40s of work under a 30s lease: past the 25s budget derived from the lease.
    const fixture = inertPrisma({ ms: 40_000 });
    const db = runnerDbFromClient(fixture.prisma, bizDevTransactionOptions(30));

    const metrics = await runBizDevWatchEvaluation(db, projections, config({ leaseSeconds: 30 }));

    // Failure is visible and accounted for, never swallowed.
    expect(metrics.failed).toBe(1);
    expect(metrics.checked).toBe(1);

    // Ownership is released by the runner's own lease-predicated error finalize (health=error, lease cleared).
    const release = fixture.recorded.updates.at(-1) as {
      data: { health: string; leaseToken: null; leaseUntil: null; lastError: string };
      where: { id: string; leaseToken: string };
    };
    expect(release.data).toMatchObject({ health: 'error', leaseToken: null, leaseUntil: null });
    expect(release.data.lastError).toContain('Transaction already closed');
    expect(release.where.id).toBe(STATE);
    expect(typeof release.where.leaseToken).toBe('string');
  });

  test('the CLI validation contract that feeds the budget is unchanged', () => {
    expect(() => validateRunConfig(config({ leaseSeconds: 10 }))).toThrow();
    expect(() => validateRunConfig(config({ leaseSeconds: 3601 }))).toThrow();
    expect(() => validateRunConfig(config())).not.toThrow();
  });
});
