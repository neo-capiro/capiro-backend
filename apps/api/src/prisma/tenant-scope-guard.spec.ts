import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * REGRESSION GUARD for the cross-tenant leak class (2026-07-16).
 *
 * The runtime DB role (capiro_app) bypasses Postgres RLS, so tenant isolation is
 * NOT enforced by the database — it is enforced only by routing tenant-scoped
 * queries through PrismaService.withTenant/withTenantUser (which inject
 * where.tenantId) or, for deliberate cross-tenant work, withSystem. A bare
 * `this.prisma.<tenantModel>.<op>()` therefore silently returns EVERY tenant's
 * rows. This test fails the build if any NEW bare access to a tenant-scoped model
 * appears, so the in-query enforcement can't quietly erode.
 *
 * A genuinely-cross-tenant system read may opt out with an inline
 * `// tenant-scope-exempt: <reason>` comment within the call (justification
 * required). Prefer wrapping such reads in `withSystem` instead.
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
        `Bare tenant-scoped Prisma access detected (would leak cross-tenant — capiro_app bypasses RLS).\n` +
          `Route through this.prisma.withTenant/withTenantUser, or add "// tenant-scope-exempt: <reason>" ` +
          `if it is a deliberate cross-tenant system read (prefer withSystem):\n\n` +
          violations.join('\n'),
      );
    }
  });
});
