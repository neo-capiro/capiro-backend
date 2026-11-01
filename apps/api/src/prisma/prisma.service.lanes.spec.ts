import { Prisma, type PrismaClient } from '@prisma/client';
import { DbLanes, isDatabaseBusyError, laneTransactionOptions, PrismaService } from './prisma.service.js';
import { DB_LANE_DEFAULTS, runInDbLane, type DbLaneSettings } from './db-lane.js';

/**
 * Lane routing inside the transaction helpers, exercised the same way the
 * existing withSystem boundary test does: the prototype methods run against a
 * bare owner whose `scopedClient` records which pool it was handed. The real
 * Prisma clients are never constructed; a factory hands `DbLanes` inert
 * stand-ins and records the derived connection URLs.
 */
describe('PrismaService database lanes', () => {
  const settings: DbLaneSettings = {
    authority: { connectionLimit: 3, poolTimeoutSeconds: 2, statementTimeoutMs: 2_000 },
    background: { connectionLimit: 4, poolTimeoutSeconds: 10, statementTimeoutMs: null },
  };
  const BASE_URL = 'postgresql://u:p@db.internal:5432/core?schema=public&sslmode=require&connection_limit=10';
  const AUTHORITY_URL = 'postgresql://u:p@db.internal:5432/core?schema=public&sslmode=require&connection_limit=3&pool_timeout=2';
  const BACKGROUND_URL = 'postgresql://u:p@db.internal:5432/core?schema=public&sslmode=require&connection_limit=4&pool_timeout=10';

  const tenantContextSql = "SELECT set_config('app.bypass_rls', 'off', true), set_config('app.current_tenant', ?, true), set_config('app.current_user', ?, true), set_config('row_security', 'on', true)";

  function host(laneSettings: DbLaneSettings | null = settings) {
    const tx = { $executeRaw: jest.fn(async () => 1) };
    const requestTransaction = jest.fn(async (fn: (value: typeof tx) => unknown, _options?: unknown) => fn(tx));
    const laneTransaction = jest.fn(async (fn: (value: typeof tx) => unknown, _options?: unknown) => fn(tx));
    const created: string[] = [];
    const factory = (options: Prisma.PrismaClientOptions) => {
      const url = (options as { datasources?: { db?: { url?: string } } }).datasources?.db?.url ?? '';
      created.push(url);
      return { laneClient: true, url } as unknown as PrismaClient;
    };
    const lanes = laneSettings ? new DbLanes(laneSettings, BASE_URL, undefined, factory) : undefined;
    const scopedClient = jest.fn((_scope: unknown, base?: unknown) => ({
      $transaction: base ? laneTransaction : requestTransaction,
    }));
    // withTenantRetry delegates to withTenant on the same instance.
    const owner = { scopedClient, lanes, withTenant: PrismaService.prototype.withTenant } as unknown as PrismaService;
    const sql = () => (tx.$executeRaw.mock.calls as unknown as unknown[][]).map((call) => (call[0] as string[]).join('?').replace(/\s+/g, ' ').trim());
    const boundValues = () => (tx.$executeRaw.mock.calls as unknown as unknown[][]).map((call) => call[1]);
    return { owner, tx, requestTransaction, laneTransaction, scopedClient, created, sql, boundValues };
  }

  it('keeps the request lane exactly as before when no lane is set', async () => {
    const { owner, requestTransaction, laneTransaction, scopedClient, sql, created } = host();
    await expect(PrismaService.prototype.withTenant.call(owner, 'tenant-a', async () => 'ok')).resolves.toBe('ok');
    expect(scopedClient).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
    expect(scopedClient.mock.calls[0]).toHaveLength(1);
    expect(requestTransaction).toHaveBeenCalledTimes(1);
    expect(requestTransaction.mock.calls[0]?.[1]).toBeUndefined();
    expect(laneTransaction).not.toHaveBeenCalled();
    expect(sql()).toEqual([tenantContextSql]);
    expect(created).toEqual([]);
  });

  it('opens authority-lane transactions on the authority client with a statement timeout before the tenant GUC', async () => {
    const { owner, requestTransaction, laneTransaction, scopedClient, sql, boundValues, created } = host();
    const result = await runInDbLane('authority', () =>
      PrismaService.prototype.withTenant.call(owner, 'tenant-a', async () => 'ok', { readOnly: true }));
    expect(result).toBe('ok');
    expect(created).toEqual([AUTHORITY_URL]);
    expect(scopedClient.mock.calls[0]?.[0]).toEqual({ tenantId: 'tenant-a' });
    expect(scopedClient.mock.calls[0]?.[1]).toMatchObject({ laneClient: true, url: AUTHORITY_URL });
    expect(requestTransaction).not.toHaveBeenCalled();
    expect(laneTransaction).toHaveBeenCalledTimes(1);
    expect(laneTransaction.mock.calls[0]?.[1]).toEqual({ timeout: 3_000, maxWait: 2_000 });
    expect(sql()).toEqual([
      'SET TRANSACTION READ ONLY',
      "SELECT set_config('statement_timeout', ?, true)",
      tenantContextSql,
    ]);
    expect(boundValues()[1]).toBe('2000ms');
  });

  it('applies the lane to withSystem and withTenantUser too, reusing one lane client', async () => {
    const { owner, laneTransaction, created, sql, boundValues } = host();
    await runInDbLane('authority', async () => {
      await PrismaService.prototype.withSystem.call(owner, async () => 'ok', { isolationLevel: 'RepeatableRead', readOnly: true });
      await PrismaService.prototype.withTenantUser.call(owner, 'tenant-a', 'user-a', async () => 'ok');
    });
    expect(created).toEqual([AUTHORITY_URL]);
    expect(laneTransaction).toHaveBeenCalledTimes(2);
    expect(laneTransaction.mock.calls[0]?.[1]).toEqual({ timeout: 3_000, isolationLevel: 'RepeatableRead', maxWait: 2_000 });
    expect(laneTransaction.mock.calls[1]?.[1]).toEqual({ timeout: 3_000, maxWait: 2_000 });
    expect(sql()).toEqual([
      'SET TRANSACTION READ ONLY',
      "SELECT set_config('statement_timeout', ?, true)",
      "SELECT set_config('app.bypass_rls', 'on', true)",
      "SELECT set_config('statement_timeout', ?, true)",
      tenantContextSql,
    ]);
    expect(boundValues().filter((value) => value === '2000ms')).toHaveLength(2);
  });

  it('lets an explicit caller timeout override the lane default', async () => {
    const { owner, laneTransaction } = host();
    await runInDbLane('authority', () =>
      PrismaService.prototype.withTenant.call(owner, 'tenant-a', async () => 'ok', { timeoutMs: 4_500 }));
    expect(laneTransaction.mock.calls[0]?.[1]).toEqual({ timeout: 4_500, maxWait: 2_000 });
  });

  it('opens background-lane transactions on the background client without a statement timeout', async () => {
    const { owner, laneTransaction, created, sql } = host();
    await runInDbLane('background', () =>
      PrismaService.prototype.withTenant.call(owner, 'tenant-a', async () => 'ok'));
    expect(created).toEqual([BACKGROUND_URL]);
    expect(laneTransaction.mock.calls[0]?.[1]).toEqual({ maxWait: 10_000 });
    expect(sql()).toEqual([tenantContextSql]);
  });

  it('routes withTenantRetry through the current lane', async () => {
    const { owner, laneTransaction, requestTransaction } = host();
    await runInDbLane('background', () =>
      PrismaService.prototype.withTenantRetry.call(owner, 'tenant-a', async () => 'ok'));
    expect(laneTransaction).toHaveBeenCalledTimes(1);
    expect(requestTransaction).not.toHaveBeenCalled();
  });

  it('uses the request pool when no lane owner is available', async () => {
    const none = host(null);
    await runInDbLane('authority', () => PrismaService.prototype.withSystem.call(none.owner, async () => 'ok'));
    expect(none.requestTransaction).toHaveBeenCalledTimes(1);
    expect(none.requestTransaction.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('derives lane clients from the base options without a conflicting datasourceUrl', () => {
    const seen: unknown[] = [];
    const lanes = new DbLanes(DB_LANE_DEFAULTS, BASE_URL, { datasourceUrl: BASE_URL, log: ['warn'] } as Prisma.PrismaClientOptions,
      (options) => { seen.push(options); return {} as PrismaClient; });
    lanes.client('authority');
    lanes.client('authority');
    expect(seen).toEqual([{ log: ['warn'], datasources: { db: { url: AUTHORITY_URL } } }]);
    expect(lanes.describe()).toContain('statement_timeout=2000ms');
  });

  it('laneTransactionOptions keeps request-lane semantics unchanged', () => {
    const request = { lane: 'request' as const, client: undefined, statementTimeoutMs: null, poolTimeoutSeconds: null };
    expect(laneTransactionOptions(request, undefined)).toBeUndefined();
    expect(laneTransactionOptions(request, { readOnly: true })).toBeUndefined();
    expect(laneTransactionOptions(request, { timeoutMs: 1 })).toEqual({ timeout: 1 });
    expect(laneTransactionOptions(request, { isolationLevel: 'Serializable' })).toEqual({ isolationLevel: 'Serializable' });
  });

  it.each(['request', 'authority', 'background'] as const)('preserves the shared deadline on the %s lane', async lane => {
    const { owner, requestTransaction, laneTransaction, sql } = host();
    await runInDbLane(lane, () => PrismaService.prototype.withTenant.call(owner, 'tenant-a', async () => 'ok', {
      timeoutMs: 500, deadline: { at: Date.now() + 500 }, readOnly: true,
    }));
    const selected = lane === 'request' ? requestTransaction : laneTransaction;
    const options = selected.mock.calls[0]?.[1] as { timeout: number; maxWait: number };
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.maxWait).toBeGreaterThan(0);
    expect(options.timeout + options.maxWait).toBeLessThanOrEqual(500);
    expect(sql()[0]).toBe('SET TRANSACTION READ ONLY');
    expect(sql()[1]).toContain("set_config('statement_timeout'");
    expect(sql()[1]).toContain("set_config('lock_timeout'");
    expect(sql().at(-1)).toBe(tenantContextSql);
    const clamp = sql().filter(query => query.includes('LEAST('));
    expect(clamp).toHaveLength(lane === 'authority' ? 1 : 0);
    if (lane === 'authority') expect(clamp[0]).toContain("SELECT setting::int FROM pg_settings WHERE name = 'statement_timeout'");
  });

  it('does not acquire any lane transaction after the absolute deadline expires', async () => {
    const { owner, requestTransaction, laneTransaction } = host();
    await expect(runInDbLane('authority', () => PrismaService.prototype.withTenant.call(owner, 'tenant-a', async () => 'unexpected', {
      deadline: { at: Date.now() - 1 },
    }))).rejects.toMatchObject({ code: 'PRISMA_TRANSACTION_DEADLINE_EXCEEDED' });
    expect(requestTransaction).not.toHaveBeenCalled();
    expect(laneTransaction).not.toHaveBeenCalled();
  });

  it('retains neutral user/bypass authority and the exact requested user on lane clients', async () => {
    const { owner, tx } = host();
    await runInDbLane('authority', () => PrismaService.prototype.withTenantUser.call(owner, 'tenant-a', 'user-a', async () => 'ok'));
    const contextCall = tx.$executeRaw.mock.calls.at(-1) as unknown as unknown[];
    expect((contextCall[0] as string[]).join('?').replace(/\s+/g, ' ').trim()).toBe(tenantContextSql);
    expect(contextCall.slice(1)).toEqual(['tenant-a', 'user-a']);
  });
});

describe('isDatabaseBusyError', () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('failed', { code, clientVersion: '5.22.0', meta });

  it('recognises statement timeouts and pool exhaustion', () => {
    expect(isDatabaseBusyError(known('P2010', { code: '57014' }))).toBe(true);
    expect(isDatabaseBusyError(known('P2024'))).toBe(true);
    expect(isDatabaseBusyError(known('P2028'))).toBe(true);
    expect(isDatabaseBusyError(new Error('ERROR: canceling statement due to statement timeout'))).toBe(true);
  });

  it('does not treat other failures as busy', () => {
    expect(isDatabaseBusyError(known('P2010', { code: '22P02' }))).toBe(false);
    expect(isDatabaseBusyError(known('P2002'))).toBe(false);
    expect(isDatabaseBusyError(new Error('external id 57014x'))).toBe(false);
    expect(isDatabaseBusyError(null)).toBe(false);
  });
});
