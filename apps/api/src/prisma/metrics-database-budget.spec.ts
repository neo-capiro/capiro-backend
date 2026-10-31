import { createMetricsDatabaseBudget } from './metrics-database-budget.js';
import { readClassicOutreachMetrics } from '../engagement/classic-outreach-metrics.js';
import { readResearchPortfolioMetrics } from '../research-portfolios/research-portfolio-metrics.js';

const start = Date.parse('2026-10-31T12:00:00Z');
const ctx = { tenantId: 'synthetic-tenant', userId: 'synthetic-user', clerkUserId: 'synthetic-clerk', role: 'standard_user' } as any;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(start); });
afterEach(() => { jest.useRealTimers(); });

/** Emulates server-enforced statement cancellation and transaction settlement;
 * never opens a database. No test-owned timer races the endpoint promise. */
function database() {
  const state = { firstRead: true, active: 0, cleanupStarted: 0, cleanupDone: 0,
    statements: [] as Array<{ label: string; statementMs: number; lockMs: number }>, options: [] as any[],
    countEntered: deferred<void>(), cleanup: deferred<void>(), delayCleanup: false, failSetup: false,
    countDelayMs: null as number | null };
  const prisma: any = { withTenant: jest.fn(async (_tenant: string, run: any, options: any) => {
    state.options.push(options);
    let statementMs = 0, lockMs = 0;
    const note = (label: string) => { state.statements.push({ label, statementMs, lockMs }); };
    const count = async () => {
      note('count'); state.active++; state.countEntered.resolve();
      try {
        if (state.countDelayMs !== null) { await new Promise(resolve => setTimeout(resolve, state.countDelayMs!)); return 0; }
        return await new Promise<number>((_resolve, reject) => {
          setTimeout(() => reject(Object.assign(Error('statement cancelled'), { code: '57014' })), statementMs);
        });
      } finally { state.active--; }
    };
    const rows = async () => {
      note('rows');
      if (state.firstRead) { state.firstRead = false; await new Promise(resolve => setTimeout(resolve, 6000)); }
      return [];
    };
    const tx = {
      $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (state.failSetup) throw Error('timeout setup unavailable');
        expect(strings.join('?')).toContain("set_config('statement_timeout', ?, true)");
        expect(strings.join('?')).toContain("set_config('lock_timeout', ?, true)");
        statementMs = Number.parseInt(values[0] as string, 10); lockMs = Number.parseInt(values[1] as string, 10);
        expect(statementMs).toBeGreaterThan(0); expect(lockMs).toBe(statementMs);
        return 1;
      }),
      tenantMembership: { findFirst: async () => { note('member'); return { id: 'synthetic-member', role: 'standard_user', updatedAt: new Date(start) }; } },
      outreachRecord: { findMany: rows, count }, researchPortfolio: { findMany: rows, count },
    };
    try { return await run(tx); }
    finally {
      state.cleanupStarted++;
      if (state.delayCleanup && state.options.length === 2) await state.cleanup.promise;
      state.cleanupDone++;
    }
  }) };
  return { state, prisma };
}

test.each([['Classic', readClassicOutreachMetrics], ['Research', readResearchPortfolioMetrics]] as const)(
  '%s count gets only the remaining budget and waits for cancellation and rollback', async (_name, read) => {
    const f = database(); f.state.delayCleanup = true; let settled = false;
    const request = read(f.prisma, ctx, {}, Date.now).then(
      value => { settled = true; return value; }, error => { settled = true; return error; });
    try {
      await jest.advanceTimersByTimeAsync(6000); await f.state.countEntered.promise;
      expect(f.state.options.map(value => value.timeoutMs)).toEqual([10000, 4000]);
      expect(f.state.options.every(value => value.readOnly === undefined)).toBe(true);
      expect(f.state.statements.at(-1)).toEqual({ label: 'count', statementMs: 4000, lockMs: 4000 });
      await jest.advanceTimersByTimeAsync(3999);
      expect(settled).toBe(false); expect(f.state.active).toBe(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(f.state.active).toBe(0); expect(f.state.cleanupStarted).toBe(2);
      expect(f.state.cleanupDone).toBe(1); expect(settled).toBe(false);
      f.state.cleanup.resolve();
      expect(await request).toMatchObject({ status: 503 });
      expect(f.state.cleanupDone).toBe(2); expect(f.prisma.withTenant).toHaveBeenCalledTimes(2);
      expect(f.state.statements.filter(value => value.label === 'count')).toHaveLength(1);
    } finally {
      f.state.cleanup.resolve(); await jest.runAllTimersAsync(); await request;
      expect(f.state.active).toBe(0); expect(jest.getTimerCount()).toBe(0);
    }
  },
);

test.each([['Classic', readClassicOutreachMetrics], ['Research', readResearchPortfolioMetrics]] as const)(
  '%s postcheck shares the same budget and returns a full zero only after cleanup', async (_name, read) => {
    const f = database(); f.state.countDelayMs = 1000;
    const request = read(f.prisma, ctx, {}, Date.now);
    await jest.advanceTimersByTimeAsync(7000);
    expect(await request).toMatchObject({ count: 0, complete: true, capped: false });
    expect(f.state.options.map(value => value.timeoutMs)).toEqual([10000, 4000, 3000]);
    expect(f.state.statements.at(-1)).toMatchObject({ statementMs: 3000, lockMs: 3000 });
    expect(f.state.cleanupDone).toBe(3); expect(f.state.active).toBe(0);
  },
);

test('queued canonical raw locks and ORM queries receive decreasing budgets and keep their receiver', async () => {
  const ms: number[] = [], events: string[] = [];
  const delegate = { async count() { expect(this).toBe(delegate); events.push('count'); return 7; } };
  const tx = {
    $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...values: any[]) => {
      if (sql.join('').includes('set_config')) { ms.push(Number.parseInt(values[0])); return 1; }
      expect(sql.join('')).toContain('FOR UPDATE'); events.push('lock');
      await new Promise(resolve => setTimeout(resolve, 6000)); return 1;
    }),
    outreachRecord: delegate,
  };
  const source: any = { withTenant: async (_tenant: string, run: any) => run(tx) };
  const budget = createMetricsDatabaseBudget(source, start, Date.now);
  const request = budget.prisma.withTenant('synthetic-tenant', async client => {
    const results = await Promise.all([client.$executeRaw`SELECT id FROM synthetic_lock FOR UPDATE`, client.outreachRecord.count()]);
    return results;
  });
  await jest.advanceTimersByTimeAsync(6000);
  expect(await request).toEqual([1, 7]); expect(events).toEqual(['lock', 'count']); expect(ms).toEqual([10000, 4000]);
});

test('a failed queued statement prevents subsequent dispatch and settles transaction cleanup', async () => {
  const calls: string[] = [];
  const tx = { $executeRaw: async () => 1, outreachRecord: {
    count: async () => { calls.push('count'); throw Error('synthetic failure'); },
    findMany: async () => { calls.push('rows'); return []; },
  } };
  let cleaned = false;
  const source: any = { withTenant: async (_tenant: string, run: any) => { try { return await run(tx); } finally { cleaned = true; } } };
  const budget = createMetricsDatabaseBudget(source, start, Date.now);
  await expect(budget.prisma.withTenant('synthetic-tenant', client => Promise.all([
    client.outreachRecord.count(), client.outreachRecord.findMany(),
  ]))).rejects.toThrow('synthetic failure');
  expect(calls).toEqual(['count']); expect(cleaned).toBe(true);
});

test('pool delay consumes admission time and prevents late domain dispatch', async () => {
  const query = jest.fn(), setup = jest.fn(); let cleaned = false;
  const source: any = { withTenant: async (_tenant: string, run: any, options: any) => {
    expect(options.timeoutMs).toBe(10000);
    await new Promise(resolve => setTimeout(resolve, 10000));
    try { return await run({ $executeRaw: setup, outreachRecord: { count: query } }); }
    finally { cleaned = true; }
  } };
  const budget = createMetricsDatabaseBudget(source, start, Date.now);
  const request = budget.prisma.withTenant('synthetic-tenant', tx => tx.outreachRecord.count()).catch(error => error);
  await jest.advanceTimersByTimeAsync(10000);
  expect(await request).toMatchObject({ status: 503 }); expect(query).not.toHaveBeenCalled();
  expect(setup).not.toHaveBeenCalled(); expect(cleaned).toBe(true);
});

test('timeout configuration failure never dispatches an unbounded query', async () => {
  const f = database(); f.state.failSetup = true;
  await expect(readResearchPortfolioMetrics(f.prisma, ctx, {}, Date.now)).rejects.toThrow('timeout setup unavailable');
  expect(f.state.statements).toEqual([]); expect(f.state.cleanupDone).toBe(1);
});

test('monotonic expiration applies when wall time is frozen; expired work opens no transaction', async () => {
  const source: any = { withTenant: jest.fn() }, budget = createMetricsDatabaseBudget(source, start, () => start);
  await jest.advanceTimersByTimeAsync(10000);
  await expect(budget.prisma.withTenant('synthetic-tenant', tx => tx.outreachRecord.count())).rejects.toMatchObject({ status: 503 });
  expect(source.withTenant).not.toHaveBeenCalled();
});
