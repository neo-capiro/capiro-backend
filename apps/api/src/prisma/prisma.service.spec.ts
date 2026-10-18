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
