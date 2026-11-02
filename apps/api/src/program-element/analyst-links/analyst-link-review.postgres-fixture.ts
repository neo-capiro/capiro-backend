import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { impersonationDatabase } from '../../capiro-admin/impersonation.postgres-fixture.js';

/** Canonical global source tables plus the existing ordinary-role HQ fixture. */
export async function analystLinkDatabase(url: string) {
  const store = await impersonationDatabase(url);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const tables = new Set([
    'program',
    'program_element',
    'source_document',
    'committee_report_provision',
    'provision_pe_link',
    'sam_opportunity',
    'sam_opportunity_match',
  ]);
  try {
    if (
      !(await admin.query("SELECT to_regclass('public.analyst_links_fixture') present")).rows[0]
        .present
    ) {
      const api = join(__dirname, '../../..');
      const statements = execFileSync(
        process.execPath,
        [
          join(api, 'node_modules/prisma/build/index.js'),
          'migrate',
          'diff',
          '--from-empty',
          '--to-schema-datamodel',
          join(api, 'prisma/schema.prisma'),
          '--script',
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      )
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim());
      const definitions = statements.filter((s) =>
        tables.has(s.match(/CREATE TABLE "([^"]+)"/)?.[1] ?? ''),
      );
      if (definitions.length !== tables.size)
        throw Error('Incomplete canonical analyst source schema');
      await admin.query('BEGIN');
      for (const statement of definitions) await admin.query(statement);
      for (const statement of statements.filter(
        (s) =>
          (/CREATE (UNIQUE )?INDEX/.test(s) && tables.has(s.match(/ ON "([^"]+)"/)?.[1] ?? '')) ||
          (/ADD CONSTRAINT.*FOREIGN KEY/s.test(s) &&
            tables.has(s.match(/ALTER TABLE "([^"]+)"/)?.[1] ?? '') &&
            tables.has(s.match(/REFERENCES "([^"]+)"/)?.[1] ?? '')),
      ))
        await admin.query(statement);
      for (const migration of [
        '20260607210000_add_committee_report_provision',
        '20260607220000_add_sam_opportunity',
      ]) {
        const sql = readFileSync(
          join(api, 'prisma/migrations', migration, 'migration.sql'),
          'utf8',
        );
        const unique = sql.match(
          /CREATE UNIQUE INDEX "(?:provision_pe_link|sam_opportunity_match)[^;]+;/,
        );
        if (!unique) throw Error('Missing canonical null-safe match identity');
        await admin.query(unique[0]);
      }
      for (const table of tables)
        await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO capiro_app`);
      await admin.query('CREATE TABLE analyst_links_fixture (owner text PRIMARY KEY)');
      await admin.query('COMMIT');
    }
  } catch (error) {
    await admin.query('ROLLBACK');
    await store.db.$disconnect();
    throw error;
  } finally {
    await admin.end();
  }
  return store;
}
