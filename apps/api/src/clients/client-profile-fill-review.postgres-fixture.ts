import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { researchStartDatabase } from './client-profile-fill-start.postgres-fixture.js';

export async function reviewDatabase(url: string) {
  const store = await researchStartDatabase(url);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    const ready = await admin.query(
      "SELECT to_regclass('public.enrichment_review_fixture') present",
    );
    if (!ready.rows[0].present) {
      const tables = new Set([
        'client_people',
        'client_facilities',
        'client_capabilities',
        'client_capability_fit_recommendations',
        'client_intel_mapping',
        'audit_logs',
        'outcome_event',
      ]);
      const statements = execFileSync(
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
      )
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim());
      const definitions = statements.filter((s) =>
        tables.has(s.match(/CREATE TABLE "([^"]+)"/)?.[1] ?? ''),
      );
      if (definitions.length !== tables.size) throw Error('Incomplete review owner schema');
      await admin.query('BEGIN');
      for (const statement of statements) {
        const name = statement.match(/CREATE TYPE "([^"]+)"/)?.[1];
        if (
          name &&
          definitions.some((d) => d.includes(`"${name}"`)) &&
          !(await admin.query('SELECT 1 FROM pg_type WHERE typname=$1', [name])).rowCount
        )
          await admin.query(statement);
      }
      for (const statement of definitions) await admin.query(statement);
      for (const statement of statements.filter(
        (s) => /CREATE (UNIQUE )?INDEX/.test(s) && tables.has(s.match(/ ON "([^"]+)"/)?.[1] ?? ''),
      ))
        await admin.query(statement);
      // Preserve actual foreign keys whose referenced owners are present in this fixture.
      const owners = new Set([...tables, 'clients', 'tenants', 'users']);
      for (const statement of statements.filter(
        (s) =>
          /ADD CONSTRAINT.*FOREIGN KEY/s.test(s) &&
          tables.has(s.match(/ALTER TABLE "([^"]+)"/)?.[1] ?? '') &&
          owners.has(s.match(/REFERENCES "([^"]+)"/)?.[1] ?? ''),
      ))
        await admin.query(statement);
      const read = (name: string) =>
        readFileSync(join(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8');
      const create = async (name: string, table: string) => {
        const ddl = read(name).match(
          new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\n\\);'),
        )?.[0];
        if (!ddl) throw Error('Missing owner definition: ' + table);
        await admin.query(ddl);
        tables.add(table);
      };
      await create('20261015010000_client_profile_fill_with_meri', 'client_profile_fill_finding');
      await create('20271231030000_client_profile_fill_completion', 'client_advocacy_record');
      await create('20271231040000_client_advocacy_matter', 'client_advocacy_matter');
      await create('20271231040000_client_advocacy_matter', 'client_advocacy_matter_link');
      await admin.query(
        read('20271231040000_client_advocacy_matter').match(
          /ALTER TABLE client_advocacy_record[\s\S]*?;/,
        )![0],
      );
      await admin.query(read('20271231050000_advocacy_matter_correction_ux'));
      await admin.query(read('20271231060000_advocacy_matter_direct_evidence_links'));
      await admin.query(read('20280101020000_outcome_event_regulatory_correlation'));
      for (const table of tables)
        await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY fixture_scope ON ${table} USING (tenant_id=current_tenant_id()) WITH CHECK (tenant_id=current_tenant_id());
        GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO capiro_app`);
      await admin.query(
        "CREATE TABLE enrichment_review_fixture (owner text PRIMARY KEY); INSERT INTO enrichment_review_fixture VALUES ('canonical-review-writers')",
      );
      await admin.query('COMMIT');
    }
    // The retained fixture may predate direct evidence links; apply their owner DDL once.
    const links = await admin.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='client_advocacy_matter_link' AND column_name='relationship_type'",
    );
    if (!links.rowCount)
      await admin.query(
        readFileSync(
          join(
            __dirname,
            '../../prisma/migrations/20271231060000_advocacy_matter_direct_evidence_links/migration.sql',
          ),
          'utf8',
        ),
      );
  } catch (error) {
    await admin.query('ROLLBACK');
    await store.db.$disconnect();
    throw error;
  } finally {
    await admin.end();
  }
  return store;
}
