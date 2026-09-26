import { Prisma } from '@prisma/client';
import { isRetryableTransactionError } from './prisma.service.js';

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
