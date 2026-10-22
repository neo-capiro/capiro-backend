import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SingleMailLedger } from './single-mail-ledger.js';
import type { TenantContext } from '@capiro/shared';

const tenant = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const connection = '33333333-3333-4333-8333-333333333333';
const key = '44444444-4444-4444-8444-444444444444';
const ctx = { tenantId: tenant, userId: actor } as TenantContext;

describe('single-mail PostgreSQL ledger', () => {
  let db: PGlite;
  let ledger: SingleMailLedger;
  let prisma: any;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(
      'CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE integration_connections(id uuid PRIMARY KEY); CREATE TABLE clients(id uuid PRIMARY KEY);',
    );
    await db.query('INSERT INTO tenants VALUES ($1)', [tenant]);
    await db.query('INSERT INTO users VALUES ($1)', [actor]);
    await db.query('INSERT INTO integration_connections VALUES ($1)', [connection]);
    await db.exec(
      readFileSync(resolve(__dirname, '../../../../docs/a1/mail/single-mail-intents.sql'), 'utf8'),
    );
    prisma = {
      withTenant: async (_: string, run: any) =>
        db.transaction(async (transaction) =>
          run({
            $queryRaw: async (sql: any) => (await transaction.query(sql.text, sql.values)).rows,
            $executeRaw: async (sql: any) =>
              (await transaction.query(sql.text, sql.values)).affectedRows,
          }),
        ),
    };
    ledger = new SingleMailLedger(prisma as never);
  });
  afterAll(async () => db?.close());

  test('concurrent duplicates have one durable claim and unknown remains fenced after re-opening the ledger', async () => {
    const input = {
      requestKey: key,
      requestHash: 'a'.repeat(64),
      connectionId: connection,
      clientId: null,
      snapshot: { bcc: ['private@example.test'] },
    };
    const attempts = await Promise.all([ledger.begin(ctx, input), ledger.begin(ctx, input)]);
    expect(attempts.filter((a) => a.created)).toHaveLength(1);
    expect(attempts[0].intent.id).toBe(attempts[1].intent.id);
    const winners = await Promise.all(
      attempts.map(({ intent }) => ledger.claim(ctx, intent, async () => {})),
    );
    expect(winners.filter(Boolean)).toHaveLength(1);
    await ledger.outcome(ctx, attempts[0].intent, 'unknown', { providerDraftId: 'draft' });
    ledger = new SingleMailLedger(prisma);
    const replay = await ledger.begin(ctx, input);
    expect(replay.created).toBe(false);
    expect(replay.intent.state).toBe('unknown');
    expect(await ledger.claim(ctx, replay.intent, async () => {})).toBe(false);
    await expect(ledger.begin(ctx, { ...input, requestHash: 'b'.repeat(64) })).rejects.toThrow(
      'different content',
    );
    expect(
      await ledger.read({ ...ctx, userId: '55555555-5555-4555-8555-555555555555' }, key),
    ).toBeNull();
    expect(
      await ledger.read({ ...ctx, tenantId: '66666666-6666-4666-8666-666666666666' }, key),
    ).toBeNull();
    await db.query('DELETE FROM users WHERE id=$1', [actor]);
    await db.query('DELETE FROM integration_connections WHERE id=$1', [connection]);
    expect((await ledger.read(ctx, key))?.state).toBe('unknown');
    await db.query('DELETE FROM tenants WHERE id=$1', [tenant]);
    expect(await ledger.read(ctx, key)).toBeNull();
  });
});
