import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
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
  let db: any;
  let ledger: SingleMailLedger;
  let prisma: any;
  beforeAll(async () => {
    const url = process.env.SINGLE_MAIL_PG_URL;
    if (url) {
      const target = new URL(url);
      if (
        target.protocol !== 'postgresql:' ||
        target.hostname !== '127.0.0.1' ||
        target.port !== '55441' ||
        target.pathname !== '/wave2_mail_ledger' ||
        target.search
      )
        throw new Error('Only the allocated loopback Mail ledger PostgreSQL fixture is allowed');
      const pool = new Pool({
        connectionString: url,
        max: 4,
        connectionTimeoutMillis: 4000,
        statement_timeout: 6000,
        options: '-c search_path=mail_ledger_fixture',
      });
      try {
        const version = await pool.query(
          "SELECT current_setting('server_version_num')::int AS version",
        );
        if (version.rows[0].version < 160000 || version.rows[0].version >= 170000)
          throw new Error('Mail ledger fixture requires PostgreSQL 16');
        await pool.query(
          'CREATE SCHEMA mail_ledger_fixture; CREATE ROLE mail_ledger_fixture_app NOLOGIN',
        );
      } catch (error) {
        await pool.end();
        throw error;
      }
      const adapter = (connection: any) => ({
        query: async (text: string, values?: unknown[]) => {
          const result = await connection.query(text, values);
          return { rows: result.rows, affectedRows: result.rowCount };
        },
      });
      db = {
        ...adapter(pool),
        exec: (text: string) => pool.query(text),
        transaction: async (run: any) => {
          const connection = await pool.connect();
          try {
            await connection.query('BEGIN');
            const result = await run(adapter(connection));
            await connection.query('COMMIT');
            return result;
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          } finally {
            connection.release();
          }
        },
        close: async () => {
          try {
            await pool.query(
              'DROP SCHEMA mail_ledger_fixture CASCADE; DROP ROLE mail_ledger_fixture_app',
            );
          } finally {
            await pool.end();
          }
        },
      };
    } else db = new PGlite();
    await db.exec(
      'CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE integration_connections(id uuid PRIMARY KEY); CREATE TABLE clients(id uuid PRIMARY KEY);',
    );
    await db.exec(
      readFileSync(resolve(__dirname, '../../../../docs/a1/mail/single-mail-intents.sql'), 'utf8'),
    );
    if (url)
      await db.exec(
        'GRANT USAGE ON SCHEMA mail_ledger_fixture TO mail_ledger_fixture_app; GRANT SELECT,INSERT,UPDATE ON single_mail_intents TO mail_ledger_fixture_app',
      );
    prisma = {
      withTenant: async (tenantId: string, run: any) =>
        db.transaction(async (transaction: any) => {
          await transaction.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
          if (url) await transaction.query('SET LOCAL ROLE mail_ledger_fixture_app');
          return run({
            $queryRaw: async (sql: any) => (await transaction.query(sql.text, sql.values)).rows,
            $executeRaw: async (sql: any) =>
              (await transaction.query(sql.text, sql.values)).affectedRows,
          });
        }),
    };
    ledger = new SingleMailLedger(prisma as never);
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE single_mail_intents,tenants,users,integration_connections CASCADE');
    await db.query('INSERT INTO tenants VALUES ($1)', [tenant]);
    await db.query('INSERT INTO users VALUES ($1)', [actor]);
    await db.query('INSERT INTO integration_connections VALUES ($1)', [connection]);
  });
  afterAll(async () => db?.close());

  const request = {
    requestKey: key,
    requestHash: 'a'.repeat(64),
    connectionId: connection,
    clientId: null,
    snapshot: { to: ['fixture@example.test'] },
  };
  test('definite authorization refusal settles pending durably and same-key replay never claims', async () => {
    const { intent } = await ledger.begin(ctx, request);
    await expect(
      ledger.claim(ctx, intent, async () => {
        throw new Error('refused before claim');
      }),
    ).rejects.toThrow('refused before claim');
    expect(await ledger.rejectPending(ctx, intent)).toBe(true);
    ledger = new SingleMailLedger(prisma);
    const replay = await ledger.begin(ctx, request);
    expect(replay.created).toBe(false);
    expect(ledger.view(replay.intent)).toMatchObject({
      requestKey: key,
      state: 'failed',
      retryable: false,
    });
    expect(await ledger.claim(ctx, replay.intent, async () => {})).toBe(false);
    expect((await ledger.read(ctx, key))?.state).toBe('failed');
  });
  test('rejection and dispatch claim compete for one pending transition', async () => {
    const { intent } = await ledger.begin(ctx, request);
    const [rejected, claimed] = await Promise.all([
      ledger.rejectPending(ctx, intent),
      ledger.claim(ctx, intent, async () => {}),
    ]);
    expect(Number(rejected) + Number(claimed)).toBe(1);
    expect((await ledger.read(ctx, key))?.state).toBe(rejected ? 'failed' : 'sending');
  });
  test.each(['sending', 'unknown', 'accepted'] as const)(
    '%s can never become a pre-dispatch rejection',
    async (state) => {
      const { intent } = await ledger.begin(ctx, request);
      expect(await ledger.claim(ctx, intent, async () => {})).toBe(true);
      if (state !== 'sending') await ledger.outcome(ctx, intent, state, { source: 'synthetic' });
      expect(await ledger.rejectPending(ctx, intent)).toBe(false);
      expect((await ledger.read(ctx, key))?.state).toBe(state);
    },
  );
  test.each(['userId', 'tenantId'] as const)(
    'a foreign %s cannot reject an owned pending intent',
    async (field) => {
      const { intent } = await ledger.begin(ctx, request);
      expect(
        await ledger.rejectPending(
          { ...ctx, [field]: '55555555-5555-4555-8555-555555555555' },
          intent,
        ),
      ).toBe(false);
      expect((await ledger.read(ctx, key))?.state).toBe('pending');
    },
  );
  test('a rejected settlement transaction rolls back without publishing failed state', async () => {
    const { intent } = await ledger.begin(ctx, request);
    const broken = new SingleMailLedger({
      withTenant: async (tenantId: string, run: any) =>
        prisma.withTenant(tenantId, async (tx: any) => {
          await run(tx);
          throw new Error('settlement transaction failed');
        }),
    } as never);
    await expect(broken.rejectPending(ctx, intent)).rejects.toThrow(
      'settlement transaction failed',
    );
    expect((await ledger.read(ctx, key))?.state).toBe('pending');
  });

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
