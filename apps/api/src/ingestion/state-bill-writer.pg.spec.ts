import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { withStateBillWriter } from './state-bill-writer.js';

describe('shared state writer lease on disposable PostgreSQL', () => {
  jest.setTimeout(30000);
  let admin: PrismaClient, db: PrismaClient;
  const schema = 'bill_writer_' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    const value = process.env.BILL_STATE_WRITER_TEST_DATABASE_URL;
    if (!value) throw Error('BILL_STATE_WRITER_TEST_DATABASE_URL_REQUIRED');
    const url = new URL(value);
    if (
      process.env.CAPIRO_DISPOSABLE_PG !== '1' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/bill_text_test'
    )
      throw Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
    admin = new PrismaClient({ datasources: { db: { url: value } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('schema', schema);
    db = new PrismaClient({ datasources: { db: { url: url.href } } });
    await db.$executeRawUnsafe(`CREATE TABLE federal_evidence_checkpoint(source text PRIMARY KEY,status text,
      lease_token uuid,lease_until timestamptz,updated_at timestamptz DEFAULT clock_timestamp())`);
    await db.$executeRawUnsafe('CREATE TABLE marker(value integer)');
    await db.$executeRawUnsafe('INSERT INTO marker VALUES(0)');
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.$disconnect();
    }
  });
  it('admits one job and refuses a competing job across distinct logical sources', async () => {
    await withStateBillWriter(db, ['FL'], async (writer) => {
      const loser = jest.fn();
      await expect(withStateBillWriter(db, ['FL'], loser)).rejects.toThrow(
        'STATE_WRITER_ALREADY_RUNNING',
      );
      expect(loser).not.toHaveBeenCalled();
      await writer.$executeRawUnsafe('UPDATE marker SET value=1');
    });
    expect(await db.$queryRawUnsafe('SELECT value FROM marker')).toEqual([{ value: 1 }]);
  });
  it('fences an expired process after successor ownership, without releasing the successor token', async () => {
    await withStateBillWriter(db, ['FL'], async (stale) => {
      await db.$executeRawUnsafe(
        "UPDATE federal_evidence_checkpoint SET lease_until=clock_timestamp()-interval '1 second' WHERE source='state-bills:FL'",
      );
      await withStateBillWriter(db, ['FL'], async (current) => {
        await expect(stale.$executeRawUnsafe('UPDATE marker SET value=99')).rejects.toThrow(
          'STATE_WRITER_LEASE_LOST',
        );
        await current.$executeRawUnsafe('UPDATE marker SET value=2');
      });
    });
    expect(await db.$queryRawUnsafe('SELECT value FROM marker')).toEqual([{ value: 2 }]);
  });
  it('keeps canonical nested writes in the fenced transaction and rolls back failures', async () => {
    await withStateBillWriter(db, ['FL'], async (writer) => {
      await expect(
        writer.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('UPDATE marker SET value=99');
          throw Error('synthetic rollback');
        }),
      ).rejects.toThrow('synthetic rollback');
    });
    expect(await db.$queryRawUnsafe('SELECT value FROM marker')).toEqual([{ value: 2 }]);
  });
});
