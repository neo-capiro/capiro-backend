import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { AdminBroadcastsService } from '../../src/admin-broadcasts/admin-broadcasts.service.js';
import { ClientFileBatchService } from '../../src/clients/client-file-batch.service.js';
import { installObjectiveSchema } from './associations-schema.js';

export const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const tenant = id(1),
  actor = id(2),
  client = id(3),
  first = id(4),
  second = id(5),
  broadcast = id(6),
  foreign = id(7),
  outsider = id(8);
export const ctx = {
  tenantId: tenant,
  userId: actor,
  clerkUserId: 'a2-synthetic-actor',
  role: 'standard_user' as const,
  tenantSlug: 'a2-synthetic',
};
const migration = (name: string) =>
  readFileSync(resolve(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8');
export const batchMigration = () => migration('20281023040000_client_file_batch_move');

function guardedUrl() {
  if (process.env.A2_PG_FIXTURE !== '1' || !process.env.A2_PG_URL)
    throw new Error(
      'Explicit A2_PG_FIXTURE=1 and A2_PG_URL are required; no DATABASE_URL fallback.',
    );
  const url = new URL(process.env.A2_PG_URL);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !/^\/wave2_a2_[a-z0-9_]+$/.test(url.pathname) ||
    url.search
  )
    throw new Error(
      'Only a named disposable wave2_a2_* database on loopback with no URL options is allowed.',
    );
  return url;
}

/** Actual PrismaService, current owner helpers and service methods; no service/model mocks. */
export async function fixture(kind: 'broadcasts' | 'files' | 'admissions' | 'associations' | 'mail') {
  const url = guardedUrl(),
    schema = `a2_${kind}`;
  const admin = new Pool({
    connectionString: url.href,
    max: 8,
    application_name: 'a2-fixture-admin',
    statement_timeout: 6000,
    idle_in_transaction_session_timeout: 10000,
    connectionTimeoutMillis: 4000,
  });
  let connectedPrisma: PrismaService | undefined;
  try {
    const guard = await admin.query(
      `SELECT current_database() AS db,current_user AS actor,current_setting('server_version_num')::int AS version,r.rolsuper FROM pg_roles r WHERE r.rolname=current_user`,
    );
    if (
      guard.rows[0]?.db !== url.pathname.slice(1) ||
      guard.rows[0].version < 160000 ||
      guard.rows[0].version >= 170000 ||
      !guard.rows[0].rolsuper
    ) {
      await admin.end();
      throw new Error('Fixture requires PostgreSQL16 and isolated bootstrap superuser.');
    }
    const unrelated = await admin.query(
      `SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema','a2_broadcasts','a2_files','a2_admissions','a2_associations','a2_mail') LIMIT 1`,
    );
    if (unrelated.rowCount) {
      await admin.end();
      throw new Error(
        'Fixture database contains unrelated tables; use a new empty disposable database.',
      );
    }
    const exists = await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
    if (exists.rowCount) {
      await admin.end();
      throw new Error('Fixture schema already exists; use a fresh disposable database.');
    }
    const role = await admin.query(
      `SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls FROM pg_roles WHERE rolname='capiro_app'`,
    );
    if (role.rowCount && Object.values(role.rows[0]).some(Boolean)) {
      await admin.end();
      throw new Error('Existing capiro_app role is not the minimal fixture role.');
    }
    const memberships = await admin.query(
      `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='capiro_app'`,
    );
    if (memberships.rowCount) {
      await admin.end();
      throw new Error('Fixture app role must have no inherited memberships.');
    }
    if (!role.rowCount)
      await admin.query(
        `CREATE ROLE capiro_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD 'a2_fixture_only'`,
      );
    await admin.query(`CREATE SCHEMA ${schema}; GRANT USAGE ON SCHEMA ${schema} TO capiro_app`);
    // Pool connections get an exact schema after the pre-mutation guards.
    const owner = await admin.connect();
    try {
      await owner.query(`SET search_path TO ${schema},public`);
      await owner.query(readFileSync(resolve(__dirname, 'prerequisites.sql'), 'utf8'));
      await owner.query(migration('20260914120000_admin_broadcasts'));
      await owner.query(batchMigration());
      await owner.query(batchMigration()); // This new migration is explicitly repeatable.
      if (kind === 'admissions') {
        await owner.query(readFileSync(resolve(__dirname, 'capacity-prerequisites.sql'), 'utf8'));
        await owner.query(migration('20281023050000_prospect_conversion_receipts'));
        await owner.query(migration('20281023050000_prospect_conversion_receipts'));
      }
      if (kind === 'associations') await installObjectiveSchema(owner, schema);
      if (kind === 'mail') await owner.query(readFileSync(resolve(__dirname, 'mail-prerequisites.sql'), 'utf8'));
    } finally {
      owner.release();
    }
    const appUrl = new URL(url.href);
    appUrl.username = 'capiro_app';
    appUrl.password = 'a2_fixture_only';
    appUrl.searchParams.set('schema', schema);
    appUrl.searchParams.set('connection_limit', '6');
    appUrl.searchParams.set('application_name', `a2-${kind}`);
    const prisma = new PrismaService({ datasources: { db: { url: appUrl.href } } });
    connectedPrisma = prisma;
    await prisma.$connect();
    const applicationRole = await prisma.$queryRawUnsafe<
      Array<{ role: string; super: boolean; bypass: boolean }>
    >(
      `SELECT current_user AS role,rolsuper AS super,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`,
    );
    if (
      applicationRole[0]?.role !== 'capiro_app' ||
      applicationRole[0].super ||
      applicationRole[0].bypass
    )
      throw new Error('Application connection bypasses the fixture authority boundary.');
    const sql = async (text: string, values: unknown[] = []) => {
      const db = await admin.connect();
      try {
        await db.query(`SET search_path TO ${schema},public`);
        return await db.query(text, values);
      } finally {
        db.release();
      }
    };
    const lock = async (text: string, values: unknown[] = []) => {
      const db = await admin.connect();
      await db.query(`SET search_path TO ${schema},public`);
      await db.query('BEGIN');
      await db.query(text, values);
      return db;
    };
    const reset = async () => {
      await sql('TRUNCATE tenants,users CASCADE');
      await sql('INSERT INTO tenants(id) VALUES($1),($2)', [tenant, foreign]);
      await sql('INSERT INTO users(id,clerk_user_id) VALUES($1,$2),($3,$4)', [
        actor,
        ctx.clerkUserId,
        outsider,
        'a2-synthetic-other',
      ]);
      await sql(
        `INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'standard_user','active'),($1,$3,'standard_user','active')`,
        [tenant, actor, outsider],
      );
      await sql('INSERT INTO clients(id,tenant_id) VALUES($1,$2)', [client, tenant]);
      await sql(
        'INSERT INTO engagement_attachments(id,tenant_id,client_id) VALUES($1,$3,$4),($2,$3,$4)',
        [first, second, tenant, client],
      );
      await sql(
        `INSERT INTO admin_broadcasts(id,tenant_id,title,body,audience) VALUES($1,$2,'Synthetic notice','Synthetic body','selected_users')`,
        [broadcast, tenant],
      );
      await sql(
        'INSERT INTO admin_broadcast_recipients(broadcast_id,tenant_id,user_id) VALUES($1,$2,$3)',
        [broadcast, tenant, actor],
      );
    };
    const waitForLock = async (fragment: string, count = 1) => {
      const deadline = Date.now() + 3500;
      while (Date.now() < deadline) {
        const waiting = await admin.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='capiro_app' AND wait_event_type='Lock' AND query LIKE $1`,
          [`%${fragment}%`],
        );
        if ((waiting.rowCount ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Expected actual PostgreSQL lock wait was not observed.');
    };
    return {
      prisma,
      sql,
      lock,
      reset,
      waitForLock,
      broadcasts: new AdminBroadcastsService(prisma),
      files: new ClientFileBatchService(prisma),
      close: async () => {
        await prisma.$disconnect();
        await admin.end();
      },
    };
  } catch (error) {
    await connectedPrisma?.$disconnect().catch(() => {});
    await admin.end().catch(() => {});
    throw error;
  }
}
export async function release(lock: PoolClient, commit = true) {
  try {
    await lock.query(commit ? 'COMMIT' : 'ROLLBACK');
  } finally {
    lock.release();
  }
}
export const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
export const command = (request = 20) => ({
  schemaVersion: 1,
  requestId: id(request),
  clientId: client,
  folder: 'Reviewed',
  files: [
    { id: first, expectedRevision: 0 },
    { id: second, expectedRevision: 0 },
  ],
});
