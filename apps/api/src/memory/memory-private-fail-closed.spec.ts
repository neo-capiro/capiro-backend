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
    //
    // Window widened 700 → 1400 (closeout §6): the server-derived ethical-wall
    // resolution now sits between the signature and the compile call, which put
    // the two 1,000 chars apart. This is a proximity heuristic for "the compile
    // happens inside this method", not a formatting rule — the guard it encodes
    // (no hand-rolled user-voice SQL) is asserted directly on the next line.
    expect(meri).toMatch(/loadUserVoiceContext[\s\S]{0,1400}contextCompiler\.compile\(/);
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
    // loadGraphForCtx must open its graph tx via withTenantUser (both GUCs), not
    // plain withTenant. Window widened for the Track B kgSource resolution line
    // that now sits between the method head and the withTenantUser( call; the
    // guard still fails if the tx opener regresses to withTenant(.
    expect(meriTools).toMatch(/loadGraphForCtx[\s\S]{0,260}withTenantUser\(/);

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

  // ── clio_memory app-level isolation (A5.5, audited 2026-07-14) ────────────
  //
  // Unlike memory_items, clio_memory has NO owner/client-level RLS — only
  // tenant-level (clio_memory_isolation). The scope='user_private'/'client'
  // predicates below are the ONLY thing standing between one user/client and
  // another's private clio_memory rows within the same tenant. Every known
  // read site was individually audited and found correctly scoped; these
  // static guards fail CI if a future refactor silently drops one.
  it('every clio_memory Prisma-filter read scopes user_private rows by ownerUserId', () => {
    const meri = readFileSync(join(SRC_ROOT, 'meri', 'meri.service.ts'), 'utf8');
    // clioRecall, listRecentLearnedMemories, listMemories.
    const filterGuards = meri.match(/\{\s*scope:\s*'user_private',\s*ownerUserId:/g) ?? [];
    expect(filterGuards.length).toBeGreaterThanOrEqual(3);
    // forgetMemory, updateMemory: post-fetch app-level owner check. Phase 0
    // (memory-mutation-auth.ts) replaced the old inline
    // `row.scope === 'user_private' && row.ownerUserId !== ctx.userId` check
    // in both methods with a shared evaluateMemoryMutation() call, which
    // subsumes it (private-memory non-owner is still unauthorized — proven in
    // memory-mutation-auth.spec.ts — plus it now also gates shared-scope
    // mutation by role and legal hold, which the old inline check never did).
    // This guard follows the refactor: it still fails CI if a future change
    // drops the scope/ownerUserId handoff into the shared policy function.
    const postFetchGuards =
      meri.match(
        /evaluateMemoryMutation\(\s*ctx,\s*\{\s*scope:\s*row\.scope,\s*ownerUserId:\s*row\.ownerUserId,\s*clientId:\s*row\.clientId,/g,
      ) ?? [];
    expect(postFetchGuards.length).toBeGreaterThanOrEqual(2);

    const candidate = readFileSync(join(SRC_ROOT, 'memory', 'memory-candidate.service.ts'), 'utf8');
    // commitToClioMemory's find-or-create dedupe/write is keyed to the
    // record's OWN scope/owner/client — never a bare tenant-wide lookup.
    const ownWriteGuards = candidate.match(/ownerUserId:\s*record\.ownerUserId/g) ?? [];
    expect(ownWriteGuards.length).toBeGreaterThanOrEqual(3);
  });

  it('the raw-SQL semantic search scopes BOTH user_private and client rows explicitly', () => {
    const meri = readFileSync(join(SRC_ROOT, 'meri', 'meri.service.ts'), 'utf8');
    expect(meri).toMatch(/scope = 'user_private' AND owner_user_id = \$3::uuid/);
    expect(meri).toMatch(/scope = 'client' AND client_id = \$5::uuid/);
  });
});
