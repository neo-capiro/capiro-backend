import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * REGRESSION GUARD for the cross-tenant leak class (mirrors apps/api's
 * tenant-scope-guard.spec.ts).
 *
 * The runtime `capiro_app` role BYPASSES Postgres RLS, so isolation for the
 * sp_* tables is enforced ONLY by PrismaService.withTenant / withTenantUser /
 * withSystem (the DMMF-derived query hook injects `where.tenantId`). A bare
 * `this.prisma.<model>.<op>(...)` outside those wrappers would silently return
 * (or write) EVERY tenant's rows.
 *
 * This static test greps this service's src for such bare access to a
 * tenant-scoped model. Add an inline `// tenant-scope-exempt: <reason>` (within
 * the -1..+3 line window) for a deliberate cross-tenant system read (prefer
 * withSystem). Scoped to apps/api-strategy/src only — the api-strategy Prisma
 * client is app-local (custom output), distinct from apps/api's client.
 */

// Tenant-scoped model client accessors, derived from THIS service's schema
// (same source of truth as PrismaService.tenantScopedModels). Global tables
// with no `tenantId` field (sp_reference_entry) are correctly excluded.
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
    // Sanity: the schema parsed and the tenant-scoped models were found.
    // (api-strategy has 7 tenant-scoped models at Phase 1; sp_reference_entry
    // is global and correctly absent.)
    expect(accessors.size).toBeGreaterThan(5);
    expect(accessors.has('spReferenceEntry')).toBe(false); // global — must NOT be scoped

    const ops =
      'findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy|update|updateMany|delete|deleteMany|upsert';
    const re = new RegExp(`this\\.prisma\\.(${[...accessors].join('|')})\\.(${ops})\\b`);

    const srcRoot = join(__dirname, '..'); // apps/api-strategy/src/prisma -> apps/api-strategy/src
    const violations: string[] = [];
    for (const f of tsFiles(srcRoot)) {
      const lines = readFileSync(f, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined || !re.test(line)) continue;
        const windowText = lines.slice(Math.max(0, i - 1), i + 4).join('\n');
        if (/tenant-scope-exempt:/.test(windowText)) continue;
        violations.push(`${f}:${i + 1}  ${line.trim()}`);
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
