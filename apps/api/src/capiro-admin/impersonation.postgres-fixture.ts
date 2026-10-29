import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { reviewDatabase } from '../clients/client-profile-fill-review.postgres-fixture.js';

export async function impersonationDatabase(url: string) {
  if (
    url !==
    'postgresql://wave6_fixture_admin@127.0.0.1:55486/target_context_enrichment_impersonation_20261029_v1'
  )
    throw Error('Only the dedicated disposable impersonation database is admitted');
  const store = await reviewDatabase(url);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    const ready = await admin.query("SELECT to_regclass('public.impersonation_sessions') present");
    if (!ready.rows[0].present) {
      await admin.query('BEGIN');
      await admin.query(
        "CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('app.bypass_rls',true),'off')='on'$$",
      );
      await admin.query(
        readFileSync(
          join(
            __dirname,
            '../../prisma/migrations/20260502010000_impersonation_sessions/migration.sql',
          ),
          'utf8',
        ),
      );
      for (const table of ['users', 'tenants', 'tenant_memberships', 'audit_logs']) {
        await admin.query(
          `CREATE POLICY fixture_system ON ${table} USING (rls_bypass()) WITH CHECK (rls_bypass())`,
        );
        await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO capiro_app`);
      }
      await admin.query('COMMIT');
    }
  } catch (error) {
    await admin.query('ROLLBACK');
    await store.db.$disconnect();
    throw error;
  } finally {
    await admin.end();
  }
  return {
    db: store.db,
    system: {
      withSystem: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
        store.db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
            await tx.$executeRaw`SELECT set_config('app.bypass_rls','on',true)`;
            return fn(tx);
          },
          { timeout: 10000 },
        ),
    } as PrismaService,
  };
}
