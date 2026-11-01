/**
 * SCRUM-240 / TD7 — the CLI's interactive-transaction lifetime, proven through the REAL adapter and the
 * REAL runner on a REAL federal-award page path.
 *
 * The confirmed failure: a normal scheduled TD7 run ended partial/failed with no alert because the per-watch
 * Prisma interactive transaction hit its 5s default (configured 5000ms, elapsed 5107ms) while a valid bounded
 * page was in flight.
 *
 * `inertPrisma` is an in-memory store with Prisma-like transaction semantics: the callback runs against the
 * store, a transaction that exceeds the budget ACTUALLY PASSED to it throws the Prisma-shaped expiry error and
 * its callback writes are rolled back (snapshot/restore), and the assertions read the STORE — so "rolled back"
 * means the state row is untouched, not that a counter was incremented. The page cost is a deterministic
 * logical clock advance inside `federalAward.findMany`, so no real 5s wait is needed.
 */
import {
  BIZDEV_TRANSACTION_MAX_MS,
  BIZDEV_TRANSACTION_MAX_WAIT_MS,
  BIZDEV_TRANSACTION_MIN_MS,
  BIZDEV_TRANSACTION_RESERVE_MS,
  bizDevTransactionOptionsFor,
  runOnceWithClient,
  runnerDbFromClient,
} from './run-bizdev-watch';
import {
  runBizDevWatchEvaluation,
  validateRunConfig,
  type BizDevWatchRunConfig,
} from '../src/business-development/bizdev-watch-runner';

const TENANT = '11111111-1111-4111-8111-111111111111';
const WATCH = '22222222-2222-4222-8222-222222222222';
const STATE = '33333333-3333-4333-8333-333333333333';
const PROSPECT = '44444444-4444-4444-8444-444444444444';
const OWNER = '55555555-5555-4555-8555-555555555555';
const UEI = 'UEI000000001';

type TxOptions = { maxWait: number; timeout: number } | undefined;

class TransactionClosed extends Error {
  readonly code = 'P2028';
  constructor(elapsed: number, budget: number) {
    super(`Transaction already closed: expired after ${elapsed}ms (budget ${budget}ms)`);
  }
}

/** The budget the adapter uses before any ownership window is known (early in every run). */
const configuredBudget = () => ({ maxWait: BIZDEV_TRANSACTION_MAX_WAIT_MS, timeout: BIZDEV_TRANSACTION_MAX_MS });

const award = () => ({
  id: 'award-1',
  awardUniqueId: 'CONT_A1',
  recipientUei: UEI,
  actionDate: new Date('2026-09-20T00:00:00.000Z'),
  amount: 100,
  awardingAgency: 'DEPT OF DEFENSE',
});

function inertPrisma(options: { pageMs: number; now?: () => number; discoveryFails?: boolean }) {
  const now = options.now ?? Date.now;
  let logical = 0;
  let disconnects = 0;
  const advance = (ms: number) => {
    logical += ms;
  };

  const store = {
    state: {
      id: STATE,
      tenantId: TENANT,
      watchId: WATCH,
      sourceFamily: 'federal_award' as string,
      health: 'pending',
      baselineState: null as unknown,
      baselinedAt: null as Date | null,
      lastSuccessfulCompleteCheckAt: null as Date | null,
      sourceWatermark: null as unknown,
      lastError: null as string | null,
      consecutiveFailures: 0,
      leaseToken: null as string | null,
      leaseUntil: null as Date | null,
    },
    alerts: [] as Array<Record<string, unknown>>,
    commits: 0,
  };

  const watchRow = {
    id: WATCH,
    tenantId: TENANT,
    prospectId: PROSPECT,
    ownerUserId: OWNER,
    status: 'active',
    mutedUntil: null,
    categories: [] as string[],
    prospect: {
      id: PROSPECT,
      status: 'active',
      dismissedAt: null,
      conflictExcluded: false,
      canonicalEntity: {
        tenantId: null,
        identityScope: 'global_public',
        canonicalName: 'ACME CORP',
        normalizedName: 'acme corp',
        status: 'active',
        mergedIntoEntityId: null,
        identifiers: [{ identifierType: 'uei', identifierValue: UEI }],
        aliases: [{ alias: 'Acme Corporation', normalizedAlias: 'acme corporation' }],
      },
    },
  };

  const tx: Record<string, unknown> = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // The lease claim writes this pass's token; the healthy finalize predicates on it. The GUC statement
      // (set_config) is a different statement and must not be mistaken for the claim.
      if (String(strings.join('')).includes('lease_token') && typeof values[0] === 'string') {
        store.state.leaseToken = values[0] as string;
        store.state.leaseUntil = new Date('2026-10-30T00:05:00.000Z');
      }
      return 1;
    },
    $queryRaw: async () => {
      if (options.discoveryFails) throw new Error('discovery unavailable');
      return [{ id: STATE, tenantId: TENANT, watchId: WATCH, sourceFamily: 'federal_award' }];
    },
    tenantMembership: { findFirst: async () => ({ id: OWNER }) },
    businessDevelopmentWatch: {
      findFirst: async ({ where }: { where: { tenantId: string; id: string } }) =>
        where.tenantId === TENANT && where.id === WATCH ? watchRow : null,
    },
    businessDevelopmentWatchSourceState: {
      findFirst: async ({ where }: { where: { tenantId: string; id: string } }) =>
        where.tenantId === TENANT && where.id === STATE ? store.state : null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (
          where.tenantId !== store.state.tenantId ||
          where.id !== store.state.id ||
          where.leaseToken !== store.state.leaseToken
        )
          return { count: 0 };
        for (const key of [
          'health',
          'lastError',
          'leaseToken',
          'leaseUntil',
          'baselineState',
          'baselinedAt',
          'lastSuccessfulCompleteCheckAt',
          'sourceWatermark',
        ] as const) {
          if (key in data && data[key] !== undefined)
            (store.state as unknown as Record<string, unknown>)[key] = data[key];
        }
        if (typeof data.consecutiveFailures === 'object') store.state.consecutiveFailures += 1;
        return { count: 1 };
      },
    },
    businessDevelopmentAlert: {
      findFirst: async () => null,
      findMany: async () => [],
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const row of data) store.alerts.push({ ...row });
        return { count: data.length };
      },
    },
    businessDevelopmentAlertDelivery: { create: async ({ data }: { data: unknown }) => data },
    businessDevelopmentProspectActivity: { create: async ({ data }: { data: unknown }) => data },
  };

  // Unknown delegates answer benignly so an unmodelled shape cannot block the page path.
  const txProxy = new Proxy(tx, {
    get: (target, prop) => (prop in target ? (target as never)[prop as never] : async () => ({ count: 0 })),
  });

  const transactions: { options: TxOptions; elapsed: number; expired: boolean }[] = [];

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, txOptions?: TxOptions) => {
      const snapshot = structuredClone(store);
      logical = 0;
      const result = await fn(txProxy);
      const budget = txOptions?.timeout ?? 5_000; // Prisma's interactive default when none is passed
      const expired = logical > budget;
      transactions.push({ options: txOptions, elapsed: logical, expired });
      if (expired) {
        Object.assign(store, snapshot); // real rollback: nothing from the callback survives
        throw new TransactionClosed(logical, budget);
      }
      store.commits += 1;
      return result;
    },
    // The SAM projection page is read through the same handle; its cost lives here.
    federalAward: {
      findMany: async () => {
        advance(options.pageMs);
        return [award()];
      },
    },
    federalAssistanceAward: { findMany: async () => [] },
    samOpportunity: { findMany: async () => [] },
    tangoResource: { findMany: async () => [] },
    ldaFiling: { findMany: async () => [] },
    $disconnect: async () => {
      disconnects += 1;
    },
  };

  return { prisma: prisma as never, store, transactions, disconnects: () => disconnects, now };
}

const config = (over: Partial<BizDevWatchRunConfig> = {}): BizDevWatchRunConfig => ({
  enabled: true,
  sourceFamilies: ['federal_award'],
  maxWatchesPerRun: 50,
  maxRecordsPerSource: 50,
  leaseSeconds: 300,
  ...over,
});

describe('run-bizdev-watch transaction lifetime (TD7)', () => {
  test('budget is a configured finite cap, clamped by the time actually remaining in the claimed lease', () => {
    const deadline = 1_000_000_000_000;

    // No window known yet: the configured ceiling — never infinite, never scaled to the lease.
    expect(bizDevTransactionOptionsFor(null)).toEqual(configuredBudget());

    // Early in a 3600s lease the CAP binds: a large configured lease buys no hour-long transactions.
    expect(bizDevTransactionOptionsFor(deadline, deadline - 3_600_000)).toEqual(configuredBudget());

    // Late in the window the REMAINING time binds, minus the reserve.
    const remaining = 40_000;
    expect(bizDevTransactionOptionsFor(deadline, deadline - remaining)).toEqual({
      maxWait: BIZDEV_TRANSACTION_MAX_WAIT_MS,
      timeout: remaining - BIZDEV_TRANSACTION_RESERVE_MS,
    });

    // Below the floor no transaction may start at all (fail closed).
    expect(
      bizDevTransactionOptionsFor(deadline, deadline - BIZDEV_TRANSACTION_MIN_MS - 4_000),
    ).toBeNull();

    // Every accepted budget is finite and leaves the reserve inside the window it belongs to.
    for (const spent of [0, 60_000, 200_000, 280_000, 295_000]) {
      const options = bizDevTransactionOptionsFor(deadline, deadline - spent);
      if (!options) continue;
      expect(Number.isFinite(options.timeout)).toBe(true);
      expect(options.timeout).toBeLessThanOrEqual(BIZDEV_TRANSACTION_MAX_MS);
      expect(options.maxWait).toBeLessThanOrEqual(options.timeout);
      expect(spent + options.timeout + BIZDEV_TRANSACTION_RESERVE_MS).toBeLessThanOrEqual(1_000_000);
    }
  });

  test('a real federal-award page taking >5s commits through the real runner and adapter', async () => {
    const { prisma, store, transactions } = inertPrisma({ pageMs: 8_000 });
    const db = runnerDbFromClient(prisma);

    const metrics = await runBizDevWatchEvaluation(db, prisma as never, config());

    // The page really cost 8s of logical work inside its transaction — past Prisma's 5s default.
    const pageTx = transactions.find((entry) => entry.elapsed >= 8_000);
    expect(pageTx).toBeDefined();
    expect(pageTx!.expired).toBe(false);

    // It committed: the watch was counted, no family failed, and the DURABLE state row carries the
    // committed baseline/watermark with a healthy finalize and a released lease — read from the store.
    expect(metrics.checked).toBe(1);
    expect(metrics.failed).toBe(0);
    expect(metrics.baselined + metrics.partial).toBeGreaterThan(0);
    expect(store.commits).toBeGreaterThanOrEqual(3);
    expect(store.state.health).toBe('healthy');
    expect(store.state.baselineState).not.toBeNull();
    expect(store.state.sourceWatermark).not.toBeNull();
    expect(store.state.leaseToken).toBeNull();
    expect(store.state.lastError).toBeNull();

    // Every audited transaction received the configured finite budget.
    for (const entry of transactions) expect(entry.options).toEqual(configuredBudget());

    // The SAME page with NO options (the pre-fix adapter) expires under Prisma's 5s default and rolls back.
    const legacy = inertPrisma({ pageMs: 8_000 });
    const raw = legacy.prisma as unknown as {
      $transaction: (fn: (tx: unknown) => Promise<unknown>, o?: TxOptions) => Promise<unknown>;
    };
    const legacyDb = {
      withTenant: (async (_tenant: string, fn: (tx: unknown) => Promise<unknown>) =>
        raw.$transaction(fn)) as never,
      withSystem: (async (fn: (tx: unknown) => Promise<unknown>) => raw.$transaction(fn)) as never,
    };
    const degraded = await runBizDevWatchEvaluation(legacyDb as never, legacy.prisma as never, config());
    expect(degraded.failed).toBe(1);
    expect(legacy.store.state.health).toBe('error');
    expect(legacy.store.state.baselineState).toBeNull(); // the expired page committed nothing
    expect(legacy.store.alerts).toHaveLength(0);
  });

  test('a page that outlives its remaining window rolls back, releases ownership and commits no alert', async () => {
    // 40s of page work under a 30s lease: the run's own clock sits at the window start, so the clamped
    // budget (~25s) must expire mid-page.
    const startMs = Date.parse('2026-10-30T00:00:00.000Z');
    const clock = () => new Date(startMs); // the runner takes a Date; the adapter a millisecond clock
    const { prisma, store, transactions } = inertPrisma({ pageMs: 40_000, now: () => startMs });
    const db = runnerDbFromClient(prisma, () => startMs);

    const metrics = await runBizDevWatchEvaluation(db, prisma as never, config({ leaseSeconds: 30 }), clock);

    expect(metrics.failed).toBe(1);
    expect(transactions.some((entry) => entry.expired)).toBe(true);

    // The expired page committed nothing and the failure is VISIBLE, with ownership released through the
    // runner's own lease-predicated error finalize.
    expect(store.state.health).toBe('error');
    expect(store.state.baselineState).toBeNull();
    expect(store.state.sourceWatermark).toBeNull();
    expect(store.state.leaseToken).toBeNull();
    expect(store.state.leaseUntil).toBeNull();
    expect(store.alerts).toHaveLength(0);
    expect(store.state.lastError).toContain('Transaction already closed');
  });

  test('no transaction starts once the ownership window is exhausted', async () => {
    const startMs = Date.parse('2026-10-30T00:00:00.000Z');
    const late = () => new Date(startMs); // the runner claims its 30s window here…
    const pastDeadline = () => startMs + 31_000; // …and the adapter is asked to run after it closed
    const { prisma, store, transactions } = inertPrisma({ pageMs: 0, now: pastDeadline });
    const db = runnerDbFromClient(prisma, pastDeadline);

    // Fail closed and visible: the run refuses to start work it cannot finish inside its own lease.
    await expect(
      runBizDevWatchEvaluation(db, prisma as never, config({ leaseSeconds: 30 }), late),
    ).rejects.toThrow(/Ownership window exhausted/);

    expect(transactions).toHaveLength(0); // not one transaction was started
    expect(store.commits).toBe(0);
    expect(store.state.health).toBe('pending');
    expect(store.state.leaseToken).toBeNull();
    expect(store.alerts).toHaveLength(0);
  });

  test('the CLI disconnects its owned client even when the run fails', async () => {
    const { prisma, disconnects } = inertPrisma({ pageMs: 0, discoveryFails: true });

    await expect(runOnceWithClient(prisma, config(), null)).rejects.toThrow(/discovery unavailable/);

    expect(disconnects()).toBe(1);
  });

  test('the CLI validation contract that feeds the budget is unchanged', () => {
    expect(() => validateRunConfig(config({ leaseSeconds: 10 }))).toThrow();
    expect(() => validateRunConfig(config({ leaseSeconds: 3601 }))).toThrow();
    expect(() => validateRunConfig(config())).not.toThrow();
  });
});
