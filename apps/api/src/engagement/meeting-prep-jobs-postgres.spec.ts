import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

// Explicitly opt-in disposable database ONLY. Never fall back to DATABASE_URL.
const databaseUrl = process.env.MEETING_PREP_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('meeting prep jobs PostgreSQL migration, isolation and fencing', () => {
  const schemaName = 'meeting_prep_qa_' + randomUUID().replaceAll('-', '');
  const roleName = 'prep_scope_' + randomUUID().replaceAll('-', '');
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const meeting = randomUUID();
  const oldPrep = randomUUID();
  let db: Client;
  async function connection() {
    const value = new Client({ connectionString: databaseUrl });
    await value.connect();
    await value.query(`SET search_path TO "${schemaName}"`);
    return value;
  }
  async function job(tenant = tenantA, user = userA) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO meeting_prep_jobs(id,tenant_id,user_id,meeting_id,request_key,request_hash,input,deadline_at)
      VALUES($1::uuid,$2,$3,$4,$1::text,$5,'{"encrypted_fixture":true}',now()+interval '30 minutes')`,
      [id, tenant, user, meeting, '0'.repeat(64)],
    );
    return id;
  }
  beforeAll(async () => {
    db = await connection();
    await db.query(`CREATE SCHEMA "${schemaName}"`);
    // Small parent fixtures allow the real feature migration to run without
    // provisioning unrelated application domains/extensions in this test DB.
    await db.query(`CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE clients(id uuid PRIMARY KEY); CREATE TABLE meetings(id uuid PRIMARY KEY);
      CREATE TABLE meeting_preps(id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'generated');
      CREATE ROLE "${roleName}" NOLOGIN NOSUPERUSER NOBYPASSRLS;`);
    await db.query(
      readFileSync(
        join(process.cwd(), 'prisma/migrations/20260912000100_meeting_prep_jobs/migration.sql'),
        'utf8',
      ),
    );
    await db.query(
      `GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"; GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_prep_jobs, meeting_prep_monday_mappings TO "${roleName}"`,
    );
    await db.query('INSERT INTO tenants VALUES($1),($2)', [tenantA, tenantB]);
    await db.query('INSERT INTO users VALUES($1),($2)', [userA, userB]);
    await db.query('INSERT INTO meetings VALUES($1)', [meeting]);
  });
  beforeEach(async () => {
    await db.query('TRUNCATE meeting_prep_jobs, meeting_prep_monday_mappings, meeting_preps');
    await db.query('INSERT INTO meeting_preps(id) VALUES($1)', [oldPrep]);
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.query(
        `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE; DROP ROLE IF EXISTS "${roleName}"`,
      );
    } finally {
      await db.end();
    }
  });

  test('two workers racing for one queued row produce exactly one lease owner', async () => {
    const id = await job();
    const a = await connection();
    const b = await connection();
    try {
      const claim = (client: Client, token: string) =>
        client.query(
          `UPDATE meeting_prep_jobs SET status='running',lease_token=$2,lease_until=now()+interval '90 seconds',attempts=attempts+1 WHERE id=$1 AND status='queued' AND lease_token IS NULL RETURNING id`,
          [id, token],
        );
      const claimed = await Promise.all([claim(a, randomUUID()), claim(b, randomUUID())]);
      expect(claimed.reduce((count, result) => count + (result.rowCount ?? 0), 0)).toBe(1);
      expect(
        (await db.query('SELECT attempts FROM meeting_prep_jobs WHERE id=$1', [id])).rows[0]
          .attempts,
      ).toBe(1);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test('a stale worker cannot publish after a replacement lease is claimed', async () => {
    const id = await job();
    const expired = randomUUID();
    const replacement = randomUUID();
    const newPrep = randomUUID();
    await db.query(
      `UPDATE meeting_prep_jobs SET status='running',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1`,
      [id, expired],
    );
    const reclaimed = await db.query(
      `UPDATE meeting_prep_jobs SET lease_token=$2,lease_until=now()+interval '90 seconds' WHERE id=$1 AND status='running' AND lease_token=$3 AND lease_until<now()`,
      [id, replacement, expired],
    );
    expect(reclaimed.rowCount).toBe(1);
    const worker = await connection();
    try {
      await worker.query('BEGIN');
      await worker.query("UPDATE meeting_preps SET status='stale' WHERE id=$1", [oldPrep]);
      await worker.query('INSERT INTO meeting_preps(id) VALUES($1)', [newPrep]);
      const committed = await worker.query(
        `UPDATE meeting_prep_jobs SET status='completed',prep_id=$3 WHERE id=$1 AND tenant_id=$4 AND user_id=$5 AND status='running' AND lease_token=$2 AND lease_until>now() AND deadline_at>now()`,
        [id, expired, newPrep, tenantA, userA],
      );
      expect(committed.rowCount).toBe(0);
      await worker.query('ROLLBACK');
      expect(
        (await db.query('SELECT status FROM meeting_preps WHERE id=$1', [oldPrep])).rows[0].status,
      ).toBe('generated');
      expect((await db.query('SELECT id FROM meeting_preps WHERE id=$1', [newPrep])).rowCount).toBe(
        0,
      );
    } finally {
      await worker.end();
    }
  });

  test('cancellation fences a late completion without deleting the last briefing', async () => {
    const id = await job();
    const token = randomUUID();
    await db.query(
      `UPDATE meeting_prep_jobs SET status='running',lease_token=$2,lease_until=now()+interval '90 seconds' WHERE id=$1`,
      [id, token],
    );
    await db.query(
      `UPDATE meeting_prep_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND status IN ('queued','running')`,
      [id, tenantA, userA],
    );
    const late = await db.query(
      `UPDATE meeting_prep_jobs SET status='completed',prep_id=$3 WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>now() AND deadline_at>now()`,
      [id, token, oldPrep],
    );
    expect(late.rowCount).toBe(0);
    expect(
      (await db.query('SELECT status FROM meeting_preps WHERE id=$1', [oldPrep])).rows[0].status,
    ).toBe('generated');
  });

  test('RLS isolates both tenant and actor, including another actor in the same tenant', async () => {
    const allowed = await job();
    await job(tenantA, userB);
    await job(tenantB, userA);
    const reader = await connection();
    try {
      await reader.query('BEGIN');
      await reader.query(`SET LOCAL ROLE "${roleName}"`);
      await reader.query(
        "SELECT set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true)",
        [tenantA, userA],
      );
      const rows = await reader.query('SELECT id FROM meeting_prep_jobs');
      expect(rows.rows.map((row) => row.id)).toEqual([allowed]);
      expect(
        (
          await reader.query("UPDATE meeting_prep_jobs SET status='cancelled' WHERE user_id=$1", [
            userB,
          ])
        ).rowCount,
      ).toBe(0);
      await reader.query('ROLLBACK');
    } finally {
      await reader.end();
    }
  });
});
