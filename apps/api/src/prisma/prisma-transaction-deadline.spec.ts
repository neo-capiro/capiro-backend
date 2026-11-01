import { PrismaService } from './prisma.service.js';
import { PrismaTransactionDeadlineError } from './prisma-transaction-deadline.js';

const START = Date.parse('2026-10-31T12:00:00Z');
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const deadline = (ms: number) => ({ at: START + ms, now: Date.now });

// Real PrismaService entry points and deadline owner; only the engine's pool,
// statement effects and commit/rollback settlement are modeled. No SQL/pool
// qualification claim follows from these deterministic timers.
function fixture(settings: {
  acquire?: number; setup?: number; context?: number; query?: number; cleanup?: Promise<void>;
  ignoreAcquisitionBound?: boolean;
  ignoreExecutionBound?: boolean;
} = {}) {
  const events: Array<{ sql: string; values: unknown[]; at: number }> = [];
  let transactionOptions: { maxWait?: number; timeout?: number; isolationLevel?: string } | undefined;
  let acquiredAt = 0;
  let callbacks = 0;
  let settled = false;
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      events.push({ sql, values, at: Date.now() - START });
      const duration = sql.includes('statement_timeout') ? settings.setup ?? 0
        : sql.includes('app.') ? settings.context ?? 0 : settings.query ?? 0;
      const left = (transactionOptions?.timeout ?? 5000) - (Date.now() - acquiredAt);
      if (duration >= left && !settings.ignoreExecutionBound) {
        await delay(left);
        throw Object.assign(new Error('modeled native transaction timeout'), { code: 'P2028' });
      }
      if (duration) await delay(duration);
      return 1;
    }),
  };
  const transaction = jest.fn(async (run: (value: typeof tx) => Promise<unknown>, options?: typeof transactionOptions) => {
    transactionOptions = options;
    const acquire = settings.acquire ?? 0, maxWait = options?.maxWait ?? 2000;
    if (acquire >= maxWait && !settings.ignoreAcquisitionBound) {
      await delay(maxWait);
      settled = true;
      throw Object.assign(new Error('modeled acquisition timeout'), { code: 'P2028' });
    }
    if (acquire) await delay(acquire);
    acquiredAt = Date.now();
    try { return await run(tx); }
    finally { await settings.cleanup; settled = true; }
  });
  const owner = { scopedClient: jest.fn(() => ({ $transaction: transaction })) } as unknown as PrismaService;
  const work = jest.fn(async () => { callbacks++; return 'complete'; });
  return { owner, events, transaction, work, tx,
    state: () => ({ options: transactionOptions, callbacks, settled }) };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(START); });
afterEach(() => { expect(jest.getTimerCount()).toBe(0); jest.restoreAllMocks(); jest.useRealTimers(); });

it('reserves acquisition inside the last100ms instead of permitting another2000ms', async () => {
  const f = fixture({ acquire: 75 });
  const result = PrismaService.prototype.withTenant.call(f.owner, 'A', f.work,
    { timeoutMs: 100, deadline: deadline(100) }).catch(error => error);
  expect(f.state().options).toEqual({ maxWait: 50, timeout: 50 });
  await jest.advanceTimersByTimeAsync(50);
  expect(await result).toMatchObject({ code: 'P2028' });
  expect(f.events).toEqual([]);
  expect(f.work).not.toHaveBeenCalled();
});

it.each(['setup', 'context'] as const)('bounds slow %s under the engine allowance remaining after acquisition', async kind => {
  const f = fixture({ acquire: 25, [kind]: 60 });
  const result = PrismaService.prototype.withTenant.call(f.owner, 'A', f.work,
    { deadline: deadline(100) }).catch(error => error);
  await jest.advanceTimersByTimeAsync(75);
  expect(await result).toBeInstanceOf(PrismaTransactionDeadlineError);
  expect(f.state()).toMatchObject({ callbacks: 0, settled: true });
  expect(f.events[0]?.values).toEqual(['50ms', '50ms']);
  expect(Date.now() - START).toBe(75);
});

it('includes timeout-settings latency in the context setup engine budget', async () => {
  const f = fixture({ acquire: 25, setup: 10, context: 60 });
  const result = PrismaService.prototype.withTenant.call(f.owner, 'A', f.work,
    { deadline: deadline(100) }).catch(error => error);
  await jest.advanceTimersByTimeAsync(75);
  expect(await result).toBeInstanceOf(PrismaTransactionDeadlineError);
  expect(f.events.map(e => e.at)).toEqual([25, 35]);
  expect(f.work).not.toHaveBeenCalled();
});

it('preserves tenant/user isolation and succeeds after bounded acquisition/setup', async () => {
  const f = fixture({ acquire: 20, setup: 5, context: 5 });
  const result = PrismaService.prototype.withTenantUser.call(f.owner, 'A', 'U', f.work,
    { deadline: deadline(100) });
  await jest.advanceTimersByTimeAsync(30);
  expect(await result).toBe('complete');
  expect(f.events[1]?.sql).toContain("set_config('app.bypass_rls', 'off', true)");
  expect(f.events[1]?.values).toEqual(['A', 'U']);
  expect(f.state()).toMatchObject({ callbacks: 1, settled: true });
});

it('retains explicit system bypass and read-only/isolation ordering with a deadline', async () => {
  const f = fixture();
  await expect(PrismaService.prototype.withSystem.call(f.owner, f.work,
    { deadline: deadline(10000), readOnly: true, isolationLevel: 'Serializable' })).resolves.toBe('complete');
  expect(f.state().options).toEqual({ maxWait: 2000, timeout: 8000, isolationLevel: 'Serializable' });
  expect(f.events.map(e => e.sql)).toEqual([
    'SET TRANSACTION READ ONLY',
    expect.stringContaining('statement_timeout'),
    "SELECT set_config('app.bypass_rls', 'on', true)",
  ]);
});

it('refuses all setup when an engine delivers acquisition after the absolute deadline', async () => {
  const f = fixture({ acquire: 101, ignoreAcquisitionBound: true });
  const supplied = deadline(100);
  const result = PrismaService.prototype.withTenant.call(f.owner, 'A', f.work,
    { deadline: supplied }).catch(error => error);
  // The admission snapshot cannot be extended by mutating the supplied object.
  supplied.at = START + 10000;
  await jest.advanceTimersByTimeAsync(101);
  expect(await result).toBeInstanceOf(PrismaTransactionDeadlineError);
  expect(f.events).toEqual([]);
  expect(f.state().settled).toBe(true);
});

it('keeps domain work inside the same engine allowance after acquisition and setup', async () => {
  const f = fixture({ acquire: 10, setup: 5, context: 5, query: 60 });
  const work = jest.fn(async () => { await f.tx.$executeRaw`SELECT synthetic_work`; return 'complete'; });
  const result = PrismaService.prototype.withTenant.call(f.owner, 'A', work,
    { deadline: deadline(100) }).catch(error => error);
  await jest.advanceTimersByTimeAsync(60);
  expect(await result).toBeInstanceOf(PrismaTransactionDeadlineError);
  expect(work).toHaveBeenCalledTimes(1);
  expect(f.events.map(e => e.at)).toEqual([10, 15, 20]);
  expect(f.state().settled).toBe(true);
});

it.each([0, 1, -1, NaN])('refuses expired/insufficient/invalid admission allowance %s before opening', async ms => {
  const f = fixture();
  await expect(PrismaService.prototype.withTenant.call(f.owner, 'A', f.work,
    { deadline: deadline(ms) })).rejects.toBeInstanceOf(PrismaTransactionDeadlineError);
  expect(f.transaction).not.toHaveBeenCalled();
});

it('does not extend the absolute budget when the wall clock stops advancing', async () => {
  const f = fixture({ acquire: 101, ignoreAcquisitionBound: true });
  const result = PrismaService.prototype.withTenant.call(f.owner, 'A', f.work,
    { deadline: { at: START + 100, now: () => START } }).catch(error => error);
  await jest.advanceTimersByTimeAsync(101);
  expect(await result).toBeInstanceOf(PrismaTransactionDeadlineError);
  expect(f.events).toEqual([]);
});

it.each([true, false])('awaits held cleanup after callback failure=%s and refuses a late result', async fail => {
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ cleanup });
  if (fail) f.work.mockRejectedValueOnce(new Error('modeled database failure'));
  let returned = false;
  const result = PrismaService.prototype.withTenant.call(f.owner, 'A', f.work,
    { deadline: deadline(100) }).then(value => { returned = true; return value; },
      error => { returned = true; return error; });
  try {
    await jest.advanceTimersByTimeAsync(101);
    expect(returned).toBe(false);
    expect(f.state().settled).toBe(false);
    release();
    expect(await result).toBeInstanceOf(PrismaTransactionDeadlineError);
    expect(f.state().settled).toBe(true);
  } finally { release(); await result; }
});

it('preserves a setup failure before deadline and never invokes the callback', async () => {
  const f = fixture();
  const failure = new Error('context setup refused');
  f.tx.$executeRaw.mockRejectedValueOnce(failure);
  await expect(PrismaService.prototype.withTenant.call(f.owner, 'A', f.work,
    { deadline: deadline(100) })).rejects.toBe(failure);
  expect(f.work).not.toHaveBeenCalled();
  expect(f.state().settled).toBe(true);
});

describe('one deadline across tenant retries and backoff', () => {
  function retryFixture(settings: Parameters<typeof fixture>[0] = {}) {
    const f = fixture(settings);
    Object.assign(f.owner, {
      withTenant: PrismaService.prototype.withTenant,
      logger: { warn: jest.fn() },
    });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    return f;
  }

  it.each(['stalled', 'backward-between-attempts'] as const)(
    'does not admit a second callback at105ms under a %s clock', async mode => {
      // Exact reviewer timeline:40ms context,25ms backoff,40ms second context.
      // Even without modeled native cancellation, the original absolute guard
      // must reject before admitting the second callback.
      const f = retryFixture({ context: 40, ignoreExecutionBound: true });
      let wall = START;
      const callbackTimes: number[] = [];
      const supplied = Object.freeze({ at: START + 100, now: () => wall });
      const request = PrismaService.prototype.withTenantRetry.call(f.owner, 'A', async () => {
        callbackTimes.push(performance.now());
        if (callbackTimes.length === 1) {
          if (mode === 'backward-between-attempts') setTimeout(() => { wall = START - 1000; }, 1);
          throw new Error('synthetic deadlock detected');
        }
        return 'late-success';
      }, Object.freeze({ retries: 1, deadline: supplied })).catch(error => error);
      await jest.advanceTimersByTimeAsync(105);
      expect(await request).toBeInstanceOf(PrismaTransactionDeadlineError);
      expect(callbackTimes).toEqual([40]);
      expect(f.transaction.mock.calls[0]?.[1]).toEqual({ maxWait: 50, timeout: 50 });
      if (mode === 'stalled') {
        expect(f.transaction.mock.calls[1]?.[1]).toEqual({ maxWait: 17, timeout: 18 });
      } else {
        expect(f.transaction).toHaveBeenCalledTimes(1);
      }
      expect(supplied.at).toBe(START + 100);
    },
  );

  it('shrinks the second engine allowance to35ms and settles at83ms with cancellation', async () => {
    const f = retryFixture({ context: 40 });
    const callback = jest.fn(async () => { throw new Error('synthetic deadlock detected'); });
    const request = PrismaService.prototype.withTenantRetry.call(f.owner, 'A', callback,
      { retries: 1, deadline: { at: START + 100, now: () => START } }).catch(error => error);
    await jest.advanceTimersByTimeAsync(83);
    expect(await request).toBeInstanceOf(PrismaTransactionDeadlineError);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.transaction.mock.calls.map(call => call[1])).toEqual([
      { maxWait: 50, timeout: 50 }, { maxWait: 17, timeout: 18 },
    ]);
    expect(f.state().settled).toBe(true);
  });

  it('bounds backoff by the original remaining time and opens no expired retry', async () => {
    const f = retryFixture({ context: 10 });
    const request = PrismaService.prototype.withTenantRetry.call(f.owner, 'A', async () => {
      throw new Error('synthetic deadlock detected');
    }, { retries: 1, deadline: { at: START + 30, now: () => START } }).catch(error => error);
    await jest.advanceTimersByTimeAsync(30);
    expect(await request).toBeInstanceOf(PrismaTransactionDeadlineError);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ignores caller deadline replacement during retry while preserving caller objects', async () => {
    const f = retryFixture({ context: 40 });
    const supplied = { at: START + 100, now: () => START };
    const options = { retries: 1, deadline: supplied, timeoutMs: 100 };
    const callback = jest.fn(async () => {
      supplied.at = START + 10000;
      supplied.now = () => START - 1000;
      options.deadline = { at: START + 20000, now: () => START };
      options.timeoutMs = 20000;
      throw new Error('synthetic deadlock detected');
    });
    const request = PrismaService.prototype.withTenantRetry.call(f.owner, 'A', callback, options).catch(error => error);
    await jest.advanceTimersByTimeAsync(83);
    expect(await request).toBeInstanceOf(PrismaTransactionDeadlineError);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.transaction.mock.calls[1]?.[1]).toEqual({ maxWait: 17, timeout: 18 });
    expect(options.deadline.at).toBe(START + 20000);
    expect(supplied.at).toBe(START + 10000);
  });

  it('preserves ordinary retries, backoff and options without a deadline', async () => {
    const f = retryFixture({ context: 40 });
    const callback = jest.fn(async () => 'ok').mockRejectedValueOnce(new Error('synthetic deadlock detected'));
    const request = PrismaService.prototype.withTenantRetry.call(f.owner, 'A', callback,
      { retries: 1, timeoutMs: 500, isolationLevel: 'Serializable' });
    await jest.advanceTimersByTimeAsync(105);
    expect(await request).toBe('ok');
    expect(callback).toHaveBeenCalledTimes(2);
    expect(f.transaction.mock.calls.map(call => call[1])).toEqual([
      { timeout: 500, isolationLevel: 'Serializable' }, { timeout: 500, isolationLevel: 'Serializable' },
    ]);
  });
});
