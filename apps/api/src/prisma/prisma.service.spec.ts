import { Prisma } from '@prisma/client';
import { isRetryableTransactionError, PrismaService } from './prisma.service.js';

describe('isRetryableTransactionError', () => {
  it('retries the Prisma write-conflict/deadlock code (P2034)', () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
      { code: 'P2034', clientVersion: '5.22.0' },
    );
    expect(isRetryableTransactionError(err)).toBe(true);
  });

  it('retries a raw deadlock error surfaced mid interactive-transaction (the production form)', () => {
    // Shape observed in prod: a generic error whose message carries the raw SQLSTATE.
    const err = new Error(
      'ConnectorError(ConnectorError { kind: QueryError(PostgresError { code: "40P01", ' +
        'message: "deadlock detected", severity: "ERROR" }) })',
    );
    expect(isRetryableTransactionError(err)).toBe(true);
  });

  it('retries serialization failures (40001 / could not serialize access)', () => {
    expect(isRetryableTransactionError(new Error('could not serialize access due to concurrent update'))).toBe(
      true,
    );
    expect(isRetryableTransactionError(new Error('SQLSTATE 40001 serialization failure'))).toBe(true);
  });

  it('does NOT retry an unrelated error that merely embeds the digits in row data', () => {
    expect(isRetryableTransactionError(new Error('Unique constraint failed on external id 1400012'))).toBe(
      false,
    );
    expect(isRetryableTransactionError(new Error('boom'))).toBe(false);
    expect(isRetryableTransactionError(null)).toBe(false);
  });

  it('does NOT retry a non-transient Prisma error (e.g. P2002 unique violation)', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });
    expect(isRetryableTransactionError(err)).toBe(false);
  });
});

describe('PrismaService.withSystem transaction option boundary', () => {
  function host() {
    const tx = { $executeRaw: jest.fn(async () => 1) };
    const transaction = jest.fn(async (fn: (value: typeof tx) => unknown, _options?: unknown) => fn(tx));
    const owner = { scopedClient: jest.fn(() => ({ $transaction: transaction })) } as unknown as PrismaService;
    return { tx, transaction, owner };
  }

  it('preserves the existing unspecified-option default and system scope callback', async () => {
    const { owner, tx, transaction } = host();
    const callback = jest.fn(async (value) => ({ same: value === tx }));
    await expect(PrismaService.prototype.withSystem.call(owner, callback)).resolves.toEqual({ same: true });
    expect(transaction.mock.calls[0]?.[1]).toBeUndefined();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect((tx.$executeRaw.mock.calls as unknown as unknown[][])[0]?.[0]).toEqual(
      ["SELECT set_config('app.bypass_rls', 'on', true)"],
    );
  });

  it('preserves timeout-only options without introducing an isolation default', async () => {
    const { owner, transaction } = host();
    await PrismaService.prototype.withSystem.call(owner, async () => 'ok', { timeoutMs: 1234 });
    expect(transaction.mock.calls[0]?.[1]).toEqual({ timeout: 1234 });
  });

  it('sets requested Serializable isolation at transaction creation with or without timeout', async () => {
    const { owner, transaction } = host();
    await PrismaService.prototype.withSystem.call(owner, async () => 'ok', { isolationLevel: 'Serializable' });
    await PrismaService.prototype.withSystem.call(owner, async () => 'ok', { isolationLevel: 'Serializable', timeoutMs: 1234 });
    expect(transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'Serializable' });
    expect(transaction.mock.calls[1]?.[1]).toEqual({ isolationLevel: 'Serializable', timeout: 1234 });
  });

  it('propagates callback failures without retrying or publishing a result', async () => {
    const { owner, transaction } = host();
    const failure = new Error('unknown commit or infrastructure failure');
    await expect(PrismaService.prototype.withSystem.call(owner, async () => { throw failure; },
      { isolationLevel: 'Serializable' })).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe('PrismaService tenant context admission', () => {
  function host() {
    const events: unknown[] = [];
    const tx = { $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      events.push({ sql: strings.join('?'), values });
      return 1;
    }) };
    const transaction = jest.fn(async (fn: (value: typeof tx) => unknown, _options?: unknown) => fn(tx));
    const scopedClient = jest.fn(() => ({ $transaction: transaction }));
    const owner = { scopedClient } as unknown as PrismaService;
    const callback = jest.fn(async (value) => { events.push('callback'); return value === tx; });
    return { events, tx, transaction, scopedClient, owner, callback };
  }

  it.each([
    ['tenant', ''],
    ['user', 'requested-user'],
  ])('establishes %s authority before handing out the transaction', async (kind, actor) => {
    const { owner, events, callback, scopedClient } = host();
    if (kind === 'tenant') await PrismaService.prototype.withTenant.call(owner, 'requested-tenant', callback);
    else await PrismaService.prototype.withTenantUser.call(owner, 'requested-tenant', actor, callback);
    expect(scopedClient).toHaveBeenCalledWith({ tenantId: 'requested-tenant' });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      sql: expect.stringContaining("set_config('app.bypass_rls', 'off', true)"),
      values: ['requested-tenant', actor],
    });
    const sql = (events[0] as {sql: string}).sql;
    expect(sql).toContain("set_config('app.current_tenant', ?, true)");
    expect(sql).toContain("set_config('app.current_user', ?, true)");
    expect(sql).toContain("set_config('row_security', 'on', true)");
    expect(events[1]).toBe('callback');
  });

  it.each(['tenant', 'user'])('does not invoke the %s callback if context setup fails', async kind => {
    const { owner, tx, callback } = host();
    const error = new Error('context refused');
    tx.$executeRaw.mockRejectedValueOnce(error);
    const request = kind === 'tenant'
      ? PrismaService.prototype.withTenant.call(owner, 'A', callback)
      : PrismaService.prototype.withTenantUser.call(owner, 'A', 'U', callback);
    await expect(request).rejects.toBe(error);
    expect(callback).not.toHaveBeenCalled();
  });

  it('preserves read-only ordering and transaction timeout/isolation options', async () => {
    const { owner, events, callback, transaction } = host();
    await PrismaService.prototype.withTenant.call(owner, 'A', callback,
      { readOnly: true, timeoutMs: 1234, isolationLevel: 'RepeatableRead' });
    expect(events[0]).toEqual({ sql: 'SET TRANSACTION READ ONLY', values: [] });
    expect(events[2]).toBe('callback');
    expect(transaction.mock.calls[0]?.[1]).toEqual({ timeout: 1234, isolationLevel: 'RepeatableRead' });
  });
});
