import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import type { PrismaService } from '../../prisma/prisma.service.js';

export async function officeDatabase(url: string) {
  if (!/^postgresql:\/\/office_fixture_admin@127\.0\.0\.1:55487\/office_drafts_[a-z0-9_]+$/.test(url))
    throw Error('Only the task-owned Office fixture is admitted');
  const admin = new Client({ connectionString: url }); await admin.connect();
  try {
    const role = await admin.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='capiro_app'");
    if (role.rows.length !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls) throw Error('Ordinary role required');
    const present = await admin.query("SELECT to_regclass('public.meri_office_drafts') present");
    if (!present.rows[0].present) {
      await admin.query('CREATE EXTENSION IF NOT EXISTS citext');
      const sql = execFileSync(process.execPath, [join(__dirname, '../../../node_modules/prisma/build/index.js'),
        'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(__dirname, '../../../prisma/schema.prisma'),
        '--script'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const tables = new Set(['tenants', 'users', 'tenant_memberships', 'clients', 'client_memory_access',
        'clio_conversations', 'clio_conversation_bootstrap_receipts']);
      const names = new Set(Prisma.dmmf.datamodel.models.filter(m => tables.has(m.dbName ?? m.name))
        .flatMap(m => m.fields.filter(f => f.kind === 'enum').map(f => f.type)));
      const enums = new Set(Prisma.dmmf.datamodel.enums.filter(e => names.has(e.name)).map(e => e.dbName ?? e.name));
      const statements = sql.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(s => {
        const table = s.match(/CREATE TABLE "([^"]+)"/); if (table) return tables.has(table[1]!);
        const enumeration = s.match(/CREATE TYPE "([^"]+)"/); if (enumeration) return enums.has(enumeration[1]!);
        const index = s.match(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([^"]+)"/); return !!index && tables.has(index[1]!);
      });
      if (statements.filter(s => /CREATE TABLE /.test(s)).length !== tables.size) throw Error('Incomplete fixture');
      for (const s of statements) await admin.query(s);
      await admin.query(`CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
        $$SELECT nullif(current_setting('app.current_tenant',true),'')::uuid$$;
        CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
        GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO capiro_app;`);
      await admin.query(readFileSync(join(__dirname, '../../../prisma/migrations/20281029020000_office_draft_owner/migration.sql'), 'utf8'));
    }
  } finally { await admin.end(); }
  const db = new PrismaClient({ datasources: { db: { url } } });
  const withScope = async <T>(tenantId: string, userId: string | null, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      if (userId) await tx.$executeRaw`SELECT set_config('app.current_user', ${userId}, true)`;
      return fn(tx);
    }, { timeout: 15000 });
  const scoped = {
    withTenant: <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) => withScope(tenantId, null, fn),
    withTenantUser: <T>(tenantId: string, userId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) => withScope(tenantId, userId, fn),
  } as PrismaService;
  return { db, scoped };
}
