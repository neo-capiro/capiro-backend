import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  recordLegiscanCapacityHold,
  releaseLegiscanCapacityHold,
  withLegiscanApiAllowed,
} from './legiscan-provider-capacity.js';
describe('authoritative LegiScan capacity hold on disposable PostgreSQL', () => {
  let admin: PrismaClient, db: PrismaClient;
  const schema = 'bill_capacity_' + randomUUID().replaceAll('-', '');
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
    await db.$executeRawUnsafe(
      `CREATE TABLE federal_evidence_checkpoint(source text PRIMARY KEY,cursor_jsonb jsonb,status text CHECK(status IN ('idle','running','failed','completed')),last_error text,updated_at timestamptz)`,
    );
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.$disconnect();
    }
  });
  it('persists only reported usage, refuses a second owner, and releases only an exact current-key hold', async () => {
    const month = new Date().toISOString().slice(0, 7),
      key = 'synthetic-native-capacity';
    await recordLegiscanCapacityHold(db, key, { month, reportedUsed: 10095, reportedLimit: 10000 });
    const run = jest.fn();
    await expect(withLegiscanApiAllowed(db, key, run)).rejects.toThrow('MONTHLY_CAPACITY_HOLD');
    expect(run).not.toHaveBeenCalled();
    expect(
      await db.$queryRawUnsafe(
        "SELECT status,cursor_jsonb->>'reportedUsed' AS used,cursor_jsonb->>'reportedLimit' AS limit FROM federal_evidence_checkpoint",
      ),
    ).toEqual([{ status: 'failed', used: '10095', limit: '10000' }]);
    await expect(releaseLegiscanCapacityHold(db, 'synthetic-wrong-key')).rejects.toThrow(
      'RELEASE_FAILED',
    );
    await releaseLegiscanCapacityHold(db, key);
    expect(
      await db.$queryRawUnsafe(
        "SELECT status,cursor_jsonb->>'exhausted' AS exhausted FROM federal_evidence_checkpoint",
      ),
    ).toEqual([{ status: 'idle', exhausted: 'false' }]);
    // Already-running workers retain their local latch until restarted.
    await expect(withLegiscanApiAllowed(db, key, run)).rejects.toThrow('MONTHLY_CAPACITY_HOLD');
  });
});
