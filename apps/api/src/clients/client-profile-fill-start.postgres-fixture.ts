import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { targetContextDatabase } from './client-target-context.postgres-fixture.js';

/** Reuse the canonical actor/client fixture, with the real existing fill table DDL. */
export async function researchStartDatabase(url: string) {
  if (!/^postgresql:\/\/wave6_fixture_admin@127\.0\.0\.1:55486\/target_context_enrichment_[a-z0-9_]+$/.test(url))
    throw Error('Only the disposable enrichment fixture database is admitted');
  const store = await targetContextDatabase(url);
  const [ready] = await store.db.$queryRawUnsafe<Array<{ present: string | null }>>(
    "SELECT to_regclass('public.enrichment_start_fixture')::text AS present",
  );
  if (!ready?.present) await store.db.$transaction(async tx => {
    await tx.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    const read = (name: string) => readFileSync(join(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8');
    const create = (source: string, table: string) => {
      const ddl = source.match(new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\n\\);'))?.[0];
      if (!ddl) throw Error('Missing owner table definition: ' + table);
      return tx.$executeRawUnsafe(ddl);
    };
    await create(read('20261015010000_client_profile_fill_with_meri'), 'client_profile_fill_run');
    const workflow = read('20271231010000_client_profile_fill_agentic_workflow')
      .split('ALTER TABLE client_profile_fill_task ENABLE ROW LEVEL SECURITY;')[0]!;
    for (const statement of workflow.split(';').map(value => value.trim()).filter(Boolean))
      await tx.$executeRawUnsafe(statement);
    await create(read('20271231030000_client_profile_fill_completion'), 'client_profile_fill_extension_task');
    for (const table of ['client_profile_fill_run', 'client_profile_fill_task', 'client_profile_fill_extension_task']) {
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await tx.$executeRawUnsafe(`CREATE POLICY fixture_scope ON ${table}
        USING (tenant_id=current_tenant_id()) WITH CHECK (tenant_id=current_tenant_id())`);
      await tx.$executeRawUnsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO capiro_app`);
    }
    await tx.$executeRawUnsafe('CREATE TABLE enrichment_start_fixture (owner text PRIMARY KEY)');
    await tx.$executeRawUnsafe("INSERT INTO enrichment_start_fixture VALUES ('existing-fill-run-owner')");
  }, { timeout: 30000 });
  return store;
}
