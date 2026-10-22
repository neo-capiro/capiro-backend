import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

// No DATABASE_URL fallback. The shared helper rejects any non-owned/non-loopback
// target before connecting, and creates a unique disposable schema with db push.
const { nativePostgresReadiness, createDisposableSchema } = require('../../../../scripts/testing/a1-disposable-postgres.cjs') as {
  nativePostgresReadiness(options: { repoRoot: string }): { available: boolean; reason: string };
  createDisposableSchema(options: { repoRoot: string; coreSchemaPath: string }): Promise<{
    url: string;
    schema: string;
    cleanup(): Promise<void>;
  }>;
};
const repoRoot = resolve(__dirname, '../../../..');
const readiness = nativePostgresReadiness({ repoRoot });
const nativeSuite = readiness.available ? describe : describe.skip;
const migration = readFileSync(resolve(repoRoot,
  'apps/api/prisma/migrations/20281022010000_meeting_debrief_approval_metadata/migration.sql'), 'utf8');
const fk = 'meeting_debriefs_approved_by_user_id_fkey';

nativeSuite(`PF-12 forward migration on PostgreSQL 16${readiness.available ? '' : ` [SKIP: ${readiness.reason}]`}`, () => {
  let fixture: Awaited<ReturnType<typeof createDisposableSchema>> | undefined;
  let db: Client | undefined;
  const query = (sql: string, values?: unknown[]) => {
    if (!db) throw new Error('Disposable PostgreSQL fixture is not initialized');
    return db.query(sql, values);
  };

  beforeAll(async () => {
    fixture = await createDisposableSchema({
      repoRoot,
      coreSchemaPath: resolve(repoRoot, 'apps/api/prisma/schema.prisma'),
    });
    db = new Client({ connectionString: fixture.url });
    await db.connect();
    // The generated name is owned by the helper, never supplied by an operator.
    if (!/^a1_[a-z0-9_]+$/.test(fixture.schema)) throw new Error('Unexpected disposable schema name');
    await query(`SET search_path TO "${fixture.schema}", public`);
  }, 180_000);

  beforeEach(async () => { await query('BEGIN'); });
  afterEach(async () => { if (db) await query('ROLLBACK'); });
  afterAll(async () => {
    try { await db?.end(); } finally { await fixture?.cleanup(); }
  });

  async function seed(approvedBy: string | null = null) {
    const tenant = randomUUID();
    const meeting = randomUUID();
    const debrief = randomUUID();
    await query('INSERT INTO tenants(id,slug,name,updated_at) VALUES ($1,$2,$3,now())',
      [tenant, `pf12-${tenant}`, `pf12-${tenant}`]);
    await query(`INSERT INTO meetings(id,tenant_id,subject,starts_at,ends_at,updated_at)
      VALUES ($1,$2,'migration fixture',now(),now(),now())`, [meeting, tenant]);
    await query(`INSERT INTO meeting_debriefs(id,tenant_id,meeting_id,body_ciphertext,iv,auth_tag,status,updated_at)
      VALUES ($1,$2,$3,'preserve-ciphertext','fixture-iv','fixture-tag','approved',now())`, [debrief, tenant, meeting]);
    if (approvedBy) {
      await query(`UPDATE meeting_debriefs SET approved_by_user_id=$2,
        approved_at='2026-10-21T12:34:56.123456Z'::timestamptz WHERE id=$1`, [debrief, approvedBy]);
    }
    return debrief;
  }
  async function user() {
    const id = randomUUID();
    await query('INSERT INTO users(id,clerk_user_id,email,updated_at) VALUES ($1,$2,$3,now())',
      [id, `fixture_${id}`, `${id}@example.invalid`]);
    return id;
  }
  async function rows() {
    return (await query('SELECT to_jsonb(d) AS value FROM meeting_debriefs d ORDER BY id')).rows;
  }
  async function columns() {
    return (await query(`SELECT attname,format_type(atttypid,atttypmod) AS type,
      attnotnull,atthasdef,attidentity,attgenerated FROM pg_attribute
      WHERE attrelid='meeting_debriefs'::regclass AND attname IN ('approved_at','approved_by_user_id')
      AND NOT attisdropped ORDER BY attname`)).rows;
  }
  async function assertRelationship() {
    expect((await query(`SELECT c.contype,c.confupdtype,c.confdeltype,c.confmatchtype,
      c.condeferrable,c.condeferred,c.convalidated,
      c.confrelid='users'::regclass AS references_users,
      c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='meeting_debriefs'::regclass
        AND attname='approved_by_user_id')]::smallint[] AS exact_source,
      c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='users'::regclass
        AND attname='id')]::smallint[] AS exact_target
      FROM pg_constraint c WHERE c.conrelid='meeting_debriefs'::regclass AND c.conname=$1`, [fk])).rows).toEqual([{
      contype: 'f', confupdtype: 'c', confdeltype: 'n', confmatchtype: 's',
      condeferrable: false, condeferred: false, convalidated: true,
      references_users: true, exact_source: true, exact_target: true,
    }]);
  }
  async function expectRejectedWithoutChanges(code: string) {
    const before = { rows: await rows(), columns: await columns(), constraint:
      (await query('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=\'meeting_debriefs\'::regclass AND conname=$1', [fk])).rows };
    await query('SAVEPOINT candidate_migration');
    await expect(query(migration)).rejects.toMatchObject({ code });
    await query('ROLLBACK TO SAVEPOINT candidate_migration');
    expect({ rows: await rows(), columns: await columns(), constraint:
      (await query('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=\'meeting_debriefs\'::regclass AND conname=$1', [fk])).rows }).toEqual(before);
  }

  test('adds absent columns and relationship without fabricating historical approval metadata', async () => {
    // These alterations model the old database inside this disposable transaction.
    await query(`ALTER TABLE meeting_debriefs DROP CONSTRAINT "${fk}", DROP COLUMN approved_at, DROP COLUMN approved_by_user_id`);
    const id = await seed();
    const before = (await rows())[0]?.value;
    await query(migration);
    expect(await columns()).toEqual([
      { attname: 'approved_at', type: 'timestamp(6) with time zone', attnotnull: false, atthasdef: false, attidentity: '', attgenerated: '' },
      { attname: 'approved_by_user_id', type: 'uuid', attnotnull: false, atthasdef: false, attidentity: '', attgenerated: '' },
    ]);
    expect((await rows())[0]?.value).toEqual({ ...before, id, approved_at: null, approved_by_user_id: null });
    await assertRelationship();
  });

  test('repeated application preserves existing values and enforces the exact update/delete relationship', async () => {
    const actor = await user();
    const id = await seed(actor);
    const before = await rows();
    await query(migration);
    await query(migration);
    expect(await rows()).toEqual(before);
    await assertRelationship();
    const nextActor = randomUUID();
    await query('UPDATE users SET id=$2 WHERE id=$1', [actor, nextActor]);
    expect((await query('SELECT approved_by_user_id FROM meeting_debriefs WHERE id=$1', [id])).rows[0])
      .toEqual({ approved_by_user_id: nextActor });
    await query('DELETE FROM users WHERE id=$1', [nextActor]);
    expect((await query('SELECT approved_by_user_id, approved_at IS NOT NULL AS keeps_time FROM meeting_debriefs WHERE id=$1', [id])).rows[0])
      .toEqual({ approved_by_user_id: null, keeps_time: true });
  });

  test('validates a matching preexisting NOT VALID relationship without changing data', async () => {
    const actor = await user();
    await seed(actor);
    await query(`ALTER TABLE meeting_debriefs DROP CONSTRAINT "${fk}"`);
    await query(`ALTER TABLE meeting_debriefs ADD CONSTRAINT "${fk}" FOREIGN KEY (approved_by_user_id)
      REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE NOT VALID`);
    const before = await rows();
    await query(migration);
    await assertRelationship();
    expect(await rows()).toEqual(before);
  });

  test.each([
    ['timestamp precision', 'ALTER TABLE meeting_debriefs ALTER COLUMN approved_at TYPE timestamptz(3)'],
    ['timestamp default', 'ALTER TABLE meeting_debriefs ALTER COLUMN approved_at SET DEFAULT now()'],
    ['timestamp nullability', 'ALTER TABLE meeting_debriefs ALTER COLUMN approved_at SET NOT NULL'],
    ['actor type', `ALTER TABLE meeting_debriefs DROP CONSTRAINT "${fk}";
      ALTER TABLE meeting_debriefs ALTER COLUMN approved_by_user_id TYPE text USING approved_by_user_id::text`],
  ] as const)('refuses mismatched preexisting %s without repairing or erasing it', async (_label, ddl) => {
    await query(ddl);
    await expectRejectedWithoutChanges('55000');
  });

  test('refuses a same-name relationship with a different delete action', async () => {
    await seed(await user());
    await query(`ALTER TABLE meeting_debriefs DROP CONSTRAINT "${fk}"`);
    await query(`ALTER TABLE meeting_debriefs ADD CONSTRAINT "${fk}" FOREIGN KEY (approved_by_user_id)
      REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`);
    await expectRejectedWithoutChanges('55000');
  });

  test('validation refuses an orphan actor without rewriting the approval data', async () => {
    await query(`ALTER TABLE meeting_debriefs DROP CONSTRAINT "${fk}"`);
    await seed(randomUUID());
    await expectRejectedWithoutChanges('23503');
  });
});
