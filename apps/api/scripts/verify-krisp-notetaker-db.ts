import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Disposable embedded PostgreSQL only. Never reads application database credentials.
async function main() {
  const db = new PGlite();
  const tenant = '00000000-0000-4000-8000-000000000001';
  const c2 = '00000000-0000-4000-8000-000000000002';
  const other = '00000000-0000-4000-8000-000000000003';
  const user = '00000000-0000-4000-8000-000000000004';
  const colleague = '00000000-0000-4000-8000-000000000005';
  const server = '00000000-0000-4000-8000-000000000006';
  try {
    await db.exec(`
      CREATE ROLE capiro_app NOLOGIN;
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('app.current_tenant',true),'')::uuid $$;
      CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT coalesce(current_setting('app.bypass_rls',true),'')='on' $$;
      CREATE TABLE tenants (id uuid PRIMARY KEY, slug text, settings_jsonb jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE meetings (id uuid PRIMARY KEY);
      CREATE TABLE clio_mcp_servers (id uuid PRIMARY KEY);
      INSERT INTO tenants VALUES ('${tenant}','capiro-internal','{"keep":1}'),('${c2}','c2-strategies','{"clioFeatureFlags":null}'),('${other}','other-firm','{}');
      INSERT INTO users VALUES ('${user}'),('${colleague}');
      INSERT INTO clio_mcp_servers VALUES ('${server}');
    `);
    await db.exec(
      await readFile(
        new URL(
          '../prisma/migrations/20261005160000_krisp_notetaker/migration.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const flags = await db.query<{ slug: string; enabled: boolean | null; keep: number | null }>(
      `SELECT slug, (settings_jsonb->'clioFeatureFlags'->>'notetaker.krisp.enabled')::boolean enabled, (settings_jsonb->>'keep')::int keep FROM tenants ORDER BY slug`,
    );
    assert.equal(flags.rows.filter((row) => row.enabled).length, 2);
    assert.equal(flags.rows.find((row) => row.slug === 'other-firm')?.enabled, null);
    assert.equal(flags.rows.find((row) => row.slug === 'capiro-internal')?.keep, 1);
    await db.exec(
      `SET ROLE capiro_app; SET app.current_tenant = '${tenant}'; SET "app.current_user" = '${user}';`,
    );
    await db.query(
      `INSERT INTO krisp_notetaker_preferences (tenant_id,user_id,server_id,enabled_at) VALUES ($1,$2,$3,now())`,
      [tenant, user, server],
    );
    await db.query(
      `INSERT INTO krisp_meeting_imports (tenant_id,user_id,document_id,title,starts_at) VALUES ($1,$2,$3,'Meeting',now())`,
      [tenant, user, 'a'.repeat(32)],
    );
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO krisp_meeting_imports (tenant_id,user_id,document_id,title,starts_at) VALUES ($1,$2,$3,'Duplicate',now())`,
          [tenant, user, 'a'.repeat(32)],
        ),
      /unique/,
    );
    await db.exec(`SET "app.current_user" = '${colleague}';`);
    assert.equal((await db.query('SELECT * FROM krisp_meeting_imports')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM krisp_notetaker_preferences')).rows.length, 0);
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO krisp_meeting_imports (tenant_id,user_id,document_id,title,starts_at) VALUES ($1,$2,$3,'Wrong user',now())`,
          [tenant, user, 'b'.repeat(32)],
        ),
      /row-level security/,
    );
    await db.exec(`SET app.current_tenant = '${other}'; SET "app.current_user" = '${user}';`);
    assert.equal((await db.query('SELECT * FROM krisp_meeting_imports')).rows.length, 0);
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO krisp_meeting_imports (tenant_id,user_id,document_id,title,starts_at) VALUES ($1,$2,$3,'Wrong tenant',now())`,
          [tenant, user, 'c'.repeat(32)],
        ),
      /row-level security/,
    );
    await db.exec(
      `RESET ROLE; SET app.bypass_rls = 'on'; DELETE FROM clio_mcp_servers WHERE id='${server}';`,
    );
    assert.equal((await db.query('SELECT * FROM krisp_notetaker_preferences')).rows.length, 0);
    assert.equal(
      (await db.query('SELECT * FROM krisp_meeting_imports')).rows.length,
      1,
      'Reconnect preserves import deduplication history',
    );
    console.log(
      'PASS: pilot flag scope, settings preservation, per-user/tenant RLS, duplicate prevention, and connection deletion.',
    );
  } finally {
    await db.close();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
