import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function apiRoot(): string {
  const cwd = process.cwd();
  return cwd.replace(/\\/g, '/').endsWith('/apps/api') ? cwd : resolve(cwd, 'apps/api');
}

function apiFile(path: string): string {
  return readFileSync(resolve(apiRoot(), path), 'utf8');
}

function migrationSql(): string {
  const root = resolve(apiRoot(), 'prisma/migrations');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === 'migration.sql') files.push(path);
    }
  };
  walk(root);
  return files.map((path) => readFileSync(path, 'utf8')).join('\n');
}

describe('Phase C PE-watch expand/contract safety', () => {
  test('schema keeps legacy and tenant-aware keys during the expand/code-switch release', () => {
    const schema = apiFile('prisma/schema.prisma');
    expect(schema).toContain(
      '@@unique([userId, peCode], map: "program_element_watch_user_pe_code_key")',
    );
    expect(schema).toContain(
      '@@unique([tenantId, userId, peCode], map: "program_element_watch_tenant_user_pe_code_key")',
    );
  });

  test('key expansion aborts duplicates and only adds the tenant-aware index', () => {
    const sql = apiFile(
      'prisma/migrations/20260728230000_add_tenant_scoped_pe_watch_key/migration.sql',
    );
    expect(sql).toMatch(/GROUP BY "tenant_id", "user_id", "pe_code"/);
    expect(sql).toMatch(/HAVING COUNT\(\*\) > 1/);
    expect(sql).toContain('program_element_watch_tenant_user_pe_code_key');
    expect(sql).toMatch(/CREATE UNIQUE INDEX/);
    expect(sql).not.toMatch(/DROP (INDEX|CONSTRAINT)/i);
    expect(sql).not.toMatch(/ROW LEVEL SECURITY|CREATE POLICY/i);
  });

  test('separate RLS correction is fail-closed and installs the canonical tenant policy', () => {
    const sql = apiFile(
      'prisma/migrations/20260728230100_enable_program_element_watch_rls/migration.sql',
    );
    expect(sql).toMatch(/FROM pg_policies/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/ALTER TABLE "program_element_watch" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE "program_element_watch" FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(
      /CREATE POLICY "program_element_watch_isolation" ON "program_element_watch"/,
    );
    expect(sql).toContain('rls_bypass() OR tenant_id = current_tenant_id()');
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY|DROP POLICY/i);
  });

  test('all application watch paths use explicit tenant predicates and never move tenant_id', () => {
    const source = apiFile('src/program-element/program-element-read.service.ts');
    expect(source).toContain('pw.tenant_id = ${tenantId}::uuid');
    expect(source).toContain('WHERE tenant_id = ${ctx.tenantId}::uuid');
    expect(source).toContain('where: { tenantId: ctx.tenantId, peCode: { in: peCodes } }');
    expect(source).toContain('ON CONFLICT (tenant_id, user_id, pe_code)');
    expect(source).not.toContain('DO UPDATE SET tenant_id = EXCLUDED.tenant_id');
    expect(source).toMatch(
      /DELETE FROM program_element_watch[\s\S]*WHERE tenant_id = \$\{ctx\.tenantId\}::uuid[\s\S]*AND user_id = \$\{ctx\.userId\}::uuid[\s\S]*AND pe_code = \$\{peCode\}/,
    );
  });

  test('the migration set enables and forces RLS for the watch table', () => {
    const sql = migrationSql();
    expect(sql).toMatch(/ALTER TABLE\s+"?program_element_watch"?\s+ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/ALTER TABLE\s+"?program_element_watch"?\s+FORCE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/CREATE POLICY[\s\S]{0,800}program_element_watch/i);
  });
});
