import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

/** Tables the focused fixture owns and builds. The 0500 migration extends six of
 * them, and the rest exist for the RLS/role boundary these tests exercise. */
const FIXTURE_TABLES = [
  'tenants',
  'users',
  'tenant_memberships',
  'clients',
  'memory_items',
  'memory_candidate',
  'clio_memory',
  'context_embeddings',
  'memory_edges',
  'client_memory_access',
  'memory_access_grant',
  'audit_logs',
] as const;

/** Schema comes from Prisma; the tested forward migration supplies ownership
 * FKs, policy, bindings and transitions. Vector math is outside this fixture. */
export async function ownerRetentionDatabase(
  url: string,
  beforeMigration?: (db: Client) => Promise<void>,
  additionalTables: readonly string[] = [],
) {
  // Office erasure reuses this canonical fixture on its separate task-owned
  // server; neither branch accepts a clone/live host or arbitrary credentials.
  // The memory_owner port may be overridden only by an explicit loopback test
  // port (MEMORY_OWNER_TEST_PORT) when the canonical 55486 server is held by
  // another session; the user, host and database-prefix still pin the target.
  const memoryOwnerPort = process.env.MEMORY_OWNER_TEST_PORT ?? '55486';
  if (!/^[0-9]{2,5}$/.test(memoryOwnerPort))
    throw Error('MEMORY_OWNER_TEST_PORT must be a numeric loopback port');
  const admitted = new RegExp(
    `^postgresql://(?:wave6_fixture_admin@127\\.0\\.0\\.1:${memoryOwnerPort}/memory_owner_[a-z0-9_]+|office_fixture_admin@127\\.0\\.0\\.1:55487/office_drafts_[a-z0-9_]+)$`,
  );
  if (!admitted.test(url)) throw Error('Only the task-owned memory_owner database is admitted');
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    const role = await admin.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='capiro_app'",
    );
    if (role.rows.length !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls)
      throw Error('Ordinary role required');
    const exists = await admin.query("SELECT to_regclass('public.memory_items') present");
    if (!exists.rows[0].present) {
      await admin.query('BEGIN');
      await admin.query('CREATE EXTENSION IF NOT EXISTS citext');
      const sql = execFileSync(
        process.execPath,
        [
          join(__dirname, '../../node_modules/prisma/build/index.js'),
          'migrate',
          'diff',
          '--from-empty',
          '--to-schema-datamodel',
          join(__dirname, '../../prisma/schema.prisma'),
          '--script',
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
      const tables = new Set([...additionalTables, ...FIXTURE_TABLES]);
      const models = Prisma.dmmf.datamodel.models.filter((m) => tables.has(m.dbName ?? m.name));
      const enumNames = new Set(
        models.flatMap((m) => m.fields.filter((f) => f.kind === 'enum').map((f) => f.type)),
      );
      const enums = new Set(
        Prisma.dmmf.datamodel.enums
          .filter((e) => enumNames.has(e.name))
          .map((e) => e.dbName ?? e.name),
      );
      const statements = sql
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter((s) => {
          const table = s.match(/CREATE TABLE "([^"]+)"/);
          if (table) return tables.has(table[1]!);
          const enumeration = s.match(/CREATE TYPE "([^"]+)"/);
          if (enumeration) return enums.has(enumeration[1]!);
          const foreign = s.match(
            /ALTER TABLE "([^"]+)" ADD CONSTRAINT [\s\S]+REFERENCES "([^"]+)"/,
          );
          if (foreign)
            return (
              tables.has(foreign[1]!) && tables.has(foreign[2]!) && !s.includes('retention_subject')
            );
          const index = s.match(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([^"]+)"/);
          return !!index && tables.has(index[1]!) && !s.includes('retention_subject');
        })
        .map((s) =>
          s
            .replace(/^\s*"retention_subject_id" UUID,?\s*$/gm, '')
            .replace(/\bvector(?:\(\d+\))?/g, 'text'),
        );
      if (statements.filter((s) => /CREATE TABLE /.test(s)).length !== tables.size)
        throw Error('Incomplete fixture schema');
      for (const statement of statements) await admin.query(statement);
      await admin.query(`CREATE DOMAIN vector AS text;
        CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
        $$SELECT nullif(current_setting('app.current_tenant',true),'')::uuid$$;
        -- Same body as the applied 20260501000000 live helper: an unset GUC
        -- yields NULL, not false. NULL is not true for every authorization use.
        CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS
        $$SELECT current_setting('app.bypass_rls',true)='on'$$;`);
      for (const table of tables) {
        await admin.query(`ALTER TABLE "${table}" ALTER COLUMN id SET DEFAULT gen_random_uuid();
          ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
          ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
        const tenantColumn = table === 'tenants' ? 'id' : 'tenant_id';
        if (table !== 'users')
          await admin.query(`CREATE POLICY scope ON "${table}"
          USING(rls_bypass() OR "${tenantColumn}"=current_tenant_id())
          WITH CHECK(rls_bypass() OR "${tenantColumn}"=current_tenant_id())`);
        else
          await admin.query(
            'CREATE POLICY scope ON users USING(rls_bypass()) WITH CHECK(rls_bypass())',
          );
      }
      await admin.query(
        'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO capiro_app',
      );
      await admin.query('COMMIT');
    }
    const ready = await admin.query(
      "SELECT to_regclass('public.memory_retention_subjects') present",
    );
    if (!ready.rows[0].present) {
      if (beforeMigration) await beforeMigration(admin);
      // The forward migration is applied as a non-superuser, non-BYPASSRLS role
      // that owns the fixture tables, matching the RDS migration owner (which has
      // no SET privilege on app.bypass_rls). Applying it as the bootstrap
      // superuser hid a real CREATE FUNCTION ... SET app.bypass_rls privilege
      // failure, so the migration now has to survive the real role.
      const migrationRole = 'wave6_fixture_migration';
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${migrationRole}')
          THEN CREATE ROLE ${migrationRole} NOLOGIN NOSUPERUSER NOCREATEDB
            NOCREATEROLE NOINHERIT NOBYPASSRLS;
        END IF; END $$`);
      // A reused role must still be unprivileged for this parameter; otherwise a
      // stale privileged role would silently defeat the regression this applies.
      const capability = await admin.query(
        `SELECT r.rolsuper, r.rolbypassrls,
           has_parameter_privilege(r.oid, 'app.bypass_rls', 'SET') AS may_set
         FROM pg_roles r WHERE r.rolname=$1`,
        [migrationRole],
      );
      const flags = capability.rows[0];
      if (!flags || flags.rolsuper || flags.rolbypassrls || flags.may_set)
        throw Error('Fixture migration role must be NOSUPERUSER/NOBYPASSRLS without SET on app.bypass_rls');
      const ownedTables = [...FIXTURE_TABLES, ...additionalTables];
      for (const table of ownedTables)
        await admin.query(`ALTER TABLE public.${JSON.stringify(table)} OWNER TO ${migrationRole}`);
      await admin.query(`GRANT CREATE ON SCHEMA public TO ${migrationRole}`);
      await admin.query(`SET ROLE ${migrationRole}`);
      try {
        await admin.query(
          readFileSync(
            join(
              __dirname,
              '../../prisma/migrations/20281029050000_memory_owner_retention/migration.sql',
            ),
            'utf8',
          ),
        );
        await admin.query('RESET ROLE');
      } catch (error) {
        // The migration's own BEGIN is aborted here; RESET ROLE would then fail
        // with 25P02 and replace the real migration error. Roll back first.
        await admin.query('ROLLBACK');
        await admin.query('RESET ROLE');
        throw error;
      }
    }
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  } finally {
    await admin.end();
  }
  const db = new PrismaClient({ datasources: { db: { url } } });
  const scoped = <T>(tenantId: string | null, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        if (tenantId)
          await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true)`;
        else await tx.$executeRaw`SELECT set_config('app.bypass_rls','on',true)`;
        return fn(tx);
      },
      { timeout: 10000 },
    );
  return { db, scoped, migrationRole: 'wave6_fixture_migration' };
}

export async function ownerRetentionCase(
  store: Awaited<ReturnType<typeof ownerRetentionDatabase>>,
) {
  const tenantId = randomUUID(),
    userId = randomUUID(),
    clientId = randomUUID();
  await store.db.tenant.create({
    data: { id: tenantId, slug: 'owner-' + tenantId, name: 'Synthetic owner', status: 'active' },
  });
  await store.db.user.create({
    data: { id: userId, clerkUserId: 'owner-' + userId, email: userId + '@example.invalid' },
  });
  await store.db.tenantMembership.create({
    data: { tenantId, userId, status: 'active', role: 'user_admin' },
  });
  await store.db.client.create({
    data: { id: clientId, tenantId, name: 'Synthetic client', status: 'active' },
  });
  const create = (scope: 'user_private' | 'client' | 'firm', key = randomUUID()) =>
    store.scoped(tenantId, (tx) =>
      tx.clioMemory.create({
        data: {
          tenantId,
          scope,
          ownerUserId: scope === 'user_private' ? userId : null,
          clientId: scope === 'client' ? clientId : null,
          key,
          value: 'Synthetic content',
          source: 'settings_memory_editor',
        },
      }),
    );
  return { tenantId, userId, clientId, create };
}
