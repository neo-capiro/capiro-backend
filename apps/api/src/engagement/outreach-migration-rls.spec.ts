import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * STATIC guard for the outreach tenant tables' row-level security.
 *
 * No database runs in this checkout, so nothing here proves the SQL executes. It
 * pins the properties that are easy to ship wrong and invisible afterwards: a
 * tenant table without ENABLE + FORCE ROW LEVEL SECURITY and the canonical
 * `rls_bypass() OR tenant_id = current_tenant_id()` policy (USING for reads, WITH
 * CHECK for writes) has no database backstop behind the in-query predicate that
 * PrismaService.withTenant() injects.
 *
 * outreach_ai_template shipped without any policy in 20260521011251 and gained
 * the canonical one in 20281102120000; outreach_records has carried it since its
 * creating migration. Both are pinned here so neither can regress.
 */

const MIGRATIONS = join(__dirname, '../../prisma/migrations');

const TABLES: ReadonlyArray<{ table: string; migration: string }> = [
  { table: 'outreach_records', migration: '20260505203000_engagement_outreach_records' },
  { table: 'outreach_ai_template', migration: '20281102120000_outreach_ai_template_rls' },
];

/** Migration SQL with comments stripped — the prose quotes the DDL it describes. */
function code(dir: string): string {
  return readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n\r]*/g, '');
}

describe('outreach tenant tables carry the canonical row-level security policy', () => {
  for (const { table, migration } of TABLES) {
    test(`${table}: ENABLE + FORCE ROW LEVEL SECURITY and "${table}_isolation"`, () => {
      const text = code(migration);
      expect(text).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      // FORCE binds the table owner too; without it the migration role reads
      // every tenant's rows on vanilla PostgreSQL.
      expect(text).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(text).toContain(`CREATE POLICY "${table}_isolation" ON "${table}"`);
      const policy = text.slice(text.indexOf(`CREATE POLICY "${table}_isolation"`));
      const body = policy.slice(0, policy.indexOf(';') + 1);
      expect(body).toMatch(/USING \(rls_bypass\(\) OR tenant_id = current_tenant_id\(\)\)/);
      expect(body).toMatch(/WITH CHECK \(rls_bypass\(\) OR tenant_id = current_tenant_id\(\)\)/);
    });
  }

  test('no later migration disables, un-forces or drops either policy', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d));
    for (const { table } of TABLES) {
      for (const dir of dirs) {
        const text = code(dir);
        expect(text).not.toMatch(new RegExp(`ALTER TABLE "?${table}"? (DISABLE|NO FORCE) ROW LEVEL SECURITY`));
        expect(text).not.toMatch(new RegExp(`DROP POLICY (IF EXISTS )?"?${table}_isolation"?`));
      }
    }
  });
});
