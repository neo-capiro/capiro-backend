import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 1 (1C) upgraded this from 3a (query-level discipline only) to 3b:
 * private (visibility='user') memory_items rows are now ALSO enforced at the
 * database boundary by an owner-aware RLS policy keyed on current_user_id()
 * (see migration 20260712030000_memory_items_private_scope_rls). The
 * application-level owner filter asserted below is kept as defense-in-depth,
 * per the blueprint's own "database boundary, with application checks as
 * defense in depth" language — this file no longer being the ONLY protection
 * is the point of 1C, not a reason to delete these assertions.
 *
 * The actual database-boundary proof (a query with app.current_user unset or
 * wrong returns 0 rows for someone else's private item) cannot run here —
 * this suite is a pure filesystem scan with no DB connection, matching this
 * repo's CI, which has no live RLS-capable Postgres. That proof is a clone
 * rehearsal (Aurora copy-on-write, same playbook as the clio_memory RLS
 * rollout) run by hand before the 1C migration ships to prod; see the Phase 1
 * deployment plan §1C.3 and §7.
 *
 * These static guards fail CI if a future query forgets the owner filter:
 *   1. Any semantic read that JOINs context_embeddings to memory_items over
 *      source_type='memory_item' MUST also constrain owner_user_id.
 *   2. The known memory_items read/write paths keep their visibility/owner
 *      guard, and use withTenantUser (not plain withTenant) so the RLS GUC
 *      is actually set.
 *   3. The 1C migration's owner-aware RLS policy text is present verbatim —
 *      catches an accidental revert of the policy itself, not just the app code.
 *
 * Pure filesystem scan — no DB, no app bootstrap.
 */
const SRC_ROOT = join(__dirname, '..'); // apps/api/src
const MIGRATIONS_ROOT = join(__dirname, '..', '..', 'prisma', 'migrations');

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTsFiles(p));
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts'))
      out.push(p);
  }
  return out;
}

describe('Phase 3 (3a) — memory private rows are fail-closed', () => {
  const files = walkTsFiles(SRC_ROOT);

  it('every context_embeddings↔memory_items read over source_type=memory_item filters owner_user_id', () => {
    const offenders: string[] = [];
    const re = /source_type\s*=\s*'memory_item'/g;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const window = text.slice(Math.max(0, m.index - 800), Math.min(text.length, m.index + 800));
        // Only reads that JOIN memory_items can return private item rows. A
        // system DELETE by source_id (removeClioMemory) is not a leak vector.
        if (!/JOIN\s+memory_items/i.test(window)) continue;
        if (!/owner_user_id/.test(window)) offenders.push(`${f} @${m.index}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('memory_items read paths keep their visibility/owner guard (regression lock)', () => {
    const store = readFileSync(join(SRC_ROOT, 'memory', 'memory-store.service.ts'), 'utf8');
    const guards = store.match(/visibility = 'tenant' OR owner_user_id =/g) ?? [];
    // listForCurrentTenant, getByTypeSlug, loadGraphInputs.
    expect(guards.length).toBeGreaterThanOrEqual(3);

    // G1: the per-surface voice loaders (meri.service loadUserVoiceContext,
    // engagement loadUserVoiceBlock, alert-memo/district-brief loadSteering)
    // were replaced by the ONE ContextCompilerService — the owner-aware SQL
    // now lives there, and the surfaces must route through compile() instead
    // of hand-rolling memory_items queries.
    const compiler = readFileSync(join(SRC_ROOT, 'context', 'context-compiler.service.ts'), 'utf8');
    expect(compiler).toMatch(/owner_user_id = \$\{req\.userId \?\? null\}::uuid/);

    const meri = readFileSync(join(SRC_ROOT, 'meri', 'meri.service.ts'), 'utf8');
    // loadUserVoiceContext routes through the compiler…
    expect(meri).toMatch(/loadUserVoiceContext[\s\S]{0,700}contextCompiler\.compile\(/);
    // …and hand-rolled user-voice SQL must NOT reappear in this file.
    expect(meri).not.toMatch(/FROM memory_items[\s\S]{0,200}'user-voice'/);
    // semanticMemorySearch: user_private clio_memory rows are scoped to the owner.
    expect(meri).toMatch(/scope = 'user_private' AND owner_user_id = \$3::uuid/);

    const engagement = readFileSync(join(SRC_ROOT, 'engagement', 'engagement.service.ts'), 'utf8');
    expect(engagement).toMatch(/loadUserVoiceBlock[\s\S]{0,900}contextCompiler\.compile\(/);
    expect(engagement).not.toMatch(/FROM memory_items[\s\S]{0,200}'user-voice'/);
  });

  // ── Phase 1 (1C): every memory_items call site sets the RLS GUC ───────────
  it('every known memory_items call site uses withTenantUser, not plain withTenant', () => {
    const store = readFileSync(join(SRC_ROOT, 'memory', 'memory-store.service.ts'), 'utf8');
    // listForCurrentTenant, getByTypeSlug, loadGraphInputs, updateSectionsForCurrentTenant.
    expect((store.match(/withTenantUser\(/g) ?? []).length).toBeGreaterThanOrEqual(4);

    const meriTools = readFileSync(join(SRC_ROOT, 'meri', 'meri-tools.service.ts'), 'utf8');
    expect(meriTools).toMatch(/loadGraphForCtx[\s\S]{0,80}withTenantUser\(/);

    // G1: the compiler is now THE memory_items steering read path — it must
    // ride withTenantUser whenever a user is known (both GUCs; the 1C policy
    // hides private rows otherwise).
    const compiler = readFileSync(join(SRC_ROOT, 'context', 'context-compiler.service.ts'), 'utf8');
    expect(compiler).toMatch(/withTenantUser\(req\.tenantId, req\.userId,/);
  });

  it('the 1C migration carries the owner-aware memory_items RLS policy verbatim', () => {
    const dirs = readdirSync(MIGRATIONS_ROOT).filter((d) =>
      d.includes('memory_items_private_scope_rls'),
    );
    expect(dirs.length).toBe(1);
    const dir = dirs[0];
    if (!dir) throw new Error('unreachable: length check above');
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, 'migration.sql'), 'utf8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION current_user_id()');
    expect(sql).toContain("visibility = 'tenant' OR owner_user_id = current_user_id()");
    expect(sql).toMatch(/DROP POLICY "memory_items_isolation"/);
    expect(sql).toContain('ALTER TABLE "context_embeddings" ADD COLUMN "owner_user_id"');
  });
});
