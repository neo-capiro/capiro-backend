import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { PrismaClient, type Prisma } from '@prisma/client';
import { Client } from 'pg';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Disposable projection fixture: real owner column/enum definitions and generated
 * Core queries, executed as an ordinary role. No production DDL is changed. */
export async function targetContextDatabase(url: string) {
  if (
    !/^postgresql:\/\/wave6_fixture_admin@127\.0\.0\.1:55486\/target_context_[a-z0-9_]+$/.test(url)
  )
    throw Error('Only the disposable target_context database is admitted');
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    const role = await admin.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='capiro_app'",
    );
    if (role.rows.length !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls)
      throw Error('Ordinary test role required');
    const ready = await admin.query("SELECT to_regclass('public.target_context_fixture') present");
    if (!ready.rows[0].present) {
      const tables = new Set([
        'tenants',
        'users',
        'tenant_memberships',
        'clients',
        'client_memory_access',
        'client_targets',
        'client_objectives',
        'client_objective_resource_links',
        'sp_strategy',
        'sp_node',
      ]);
      const statements = ['api', 'api-strategy'].flatMap((app) =>
        execFileSync(
          process.execPath,
          [
            join(__dirname, '../../node_modules/prisma/build/index.js'),
            'migrate',
            'diff',
            '--from-empty',
            '--to-schema-datamodel',
            join(__dirname, `../../../${app}/prisma/schema.prisma`),
            '--script',
          ],
          { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        )
          .split(/;\s*(?:\n|$)/)
          .map((s) => s.trim()),
      );
      const definitions = statements.filter((s) =>
        tables.has(s.match(/CREATE TABLE "([^"]+)"/)?.[1] ?? ''),
      );
      if (definitions.length !== tables.size) throw Error('Incomplete owner schema');
      const enums = statements.filter((s) => {
        const name = s.match(/CREATE TYPE "([^"]+)"/)?.[1];
        return name && definitions.some((table) => table.includes(`"${name}"`));
      });
      await admin.query('BEGIN');
      await admin.query('CREATE EXTENSION IF NOT EXISTS citext');
      for (const statement of [...enums, ...definitions]) await admin.query(statement);
      await admin.query(`CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
        $$SELECT nullif(current_setting('app.current_tenant',true),'')::uuid$$`);
      for (const table of tables) {
        const predicate =
          table === 'users'
            ? 'true'
            : `${table === 'tenants' ? 'id' : 'tenant_id'}=current_tenant_id()`;
        await admin.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
          ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;
          CREATE POLICY fixture_scope ON "${table}" USING (${predicate}) WITH CHECK (${predicate})`);
      }
      // SHARE locks require UPDATE privileges, but the tested projection is read-only.
      await admin.query(`GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA public TO capiro_app;
        CREATE TABLE target_context_fixture (owner text PRIMARY KEY);
        INSERT INTO target_context_fixture VALUES ('client-target-context')`);
      await admin.query('COMMIT');
    }
    // This legacy projection is intentionally absent from the generated model;
    // the canonical access helper still locks it. Apply its actual owner DDL.
    const legacy = await admin.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='clients' AND column_name='account_owner_user_id'",
    );
    if (!legacy.rows.length)
      await admin.query(
        readFileSync(
          join(
            __dirname,
            '../../prisma/migrations/20260816235000_add_client_account_owner/migration.sql',
          ),
          'utf8',
        ),
      );
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  } finally {
    await admin.end();
  }
  const db = new PrismaClient({ datasources: { db: { url } } });
  const scoped = {
    withTenantUser: <T>(
      tenantId: string,
      userId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ) =>
      db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
          await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true)`;
          await tx.$executeRaw`SELECT set_config('app.current_user',${userId},true)`;
          return fn(tx);
        },
        { timeout: 10000 },
      ),
  } as PrismaService;
  return { db, scoped };
}
