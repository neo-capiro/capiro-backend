import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * REGRESSION GUARD for the cross-tenant leak class (2026-07-16).
 *
 * Tenant isolation is enforced by routing tenant-scoped queries through
 * PrismaService.withTenant/withTenantUser (which inject where.tenantId) or, for
 * deliberate cross-tenant work, withSystem (which sets the app.bypass_rls GUC).
 * This test fails the build if any NEW bare access to a tenant-scoped model
 * appears, so the in-query enforcement can't quietly erode.
 *
 * A bare `this.prisma.<tenantModel>.<op>()` is wrong in BOTH directions, and which
 * way it fails depends on whether that table has an RLS policy:
 *
 *  - No policy on the table → the query returns EVERY tenant's rows (the original
 *    2026-07-16 leak class).
 *  - Policy on the table → it returns ZERO rows with no error. Until 2026-07-20
 *    capiro_app inherited rds_superuser via capiro_master and was RLS-exempt, so
 *    this could not happen; the role hardening that day (REVOKE capiro_master FROM
 *    capiro_app) made capiro_app a plain, NON-BYPASSRLS role. A bare read of an
 *    RLS-FORCED table is now a silent empty result, indistinguishable from an
 *    empty table.
 *
 * That second mode is why `// tenant-scope-exempt: <reason>` is NOT a substitute
 * for withSystem on a cross-tenant read: the annotation silences this guard but
 * does nothing about the policy, so the read fails closed and any caller that
 * treats [] as "nobody matched" silently stops doing its job. Phase C hit exactly
 * this — three annotated PE-watch alert fan-outs would have gone permanently
 * silent the moment program_element_watch gained its policy. Use the annotation
 * only for a cross-tenant read of a table with NO RLS policy; otherwise wrap it in
 * withSystem.
 */

// tenant-scoped model client accessors, derived from the schema (same source of
// truth as PrismaService.tenantScopedModels — auto-covers new models).
function tenantScopedAccessors(): Set<string> {
  const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const out = new Set<string>();
  for (const m of schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const name = m[1];
    const body = m[2];
    if (!name || !body) continue;
    if (/\n\s*tenantId\s/.test(body)) out.add(name[0]!.toLowerCase() + name.slice(1));
  }
  return out;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === 'generated' || e === '.git') continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...tsFiles(p));
    else if (e.endsWith('.ts') && !e.endsWith('.spec.ts') && e !== 'prisma.service.ts') out.push(p);
  }
  return out;
}

describe('tenant-scope guard: no bare tenant-scoped Prisma access', () => {
  it('every tenant-scoped model read/write goes through withTenant/withSystem (or is explicitly exempt)', () => {
    const accessors = tenantScopedAccessors();
    expect(accessors.size).toBeGreaterThan(50); // sanity: schema parsed
    const ops =
      'findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy|update|updateMany|delete|deleteMany|upsert';
    const re = new RegExp(`this\\.prisma\\.(${[...accessors].join('|')})\\.(${ops})\\b`);

    const appsRoot = join(__dirname, '../../../'); // apps/api/src/prisma -> apps
    const violations: string[] = [];
    for (const dir of readdirSync(appsRoot)) {
      const src = join(appsRoot, dir, 'src');
      let files: string[];
      try {
        files = tsFiles(src);
      } catch {
        continue; // app has no src dir
      }
      for (const f of files) {
        const lines = readFileSync(f, 'utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === undefined || !re.test(line)) continue;
          // allow an inline exemption on the preceding line or within the call (-1 .. +3)
          const windowText = lines.slice(Math.max(0, i - 1), i + 4).join('\n');
          if (/tenant-scope-exempt:/.test(windowText)) continue;
          violations.push(`${f.replace(appsRoot, 'apps/')}:${i + 1}  ${line.trim()}`);
        }
      }
    }

    if (violations.length) {
      throw new Error(
        `Bare tenant-scoped Prisma access detected. If the table has no RLS policy this ` +
          `leaks every tenant's rows; if it has one this silently returns ZERO rows ` +
          `(capiro_app is NOT BYPASSRLS since the 2026-07-20 role hardening).\n` +
          `Route through this.prisma.withTenant/withTenantUser, or this.prisma.withSystem ` +
          `for a deliberate cross-tenant read. "// tenant-scope-exempt: <reason>" only ` +
          `silences this guard — it does NOT bypass RLS, so it is unsafe for a table that ` +
          `has a policy:\n\n` +
          violations.join('\n'),
      );
    }
  });
});
