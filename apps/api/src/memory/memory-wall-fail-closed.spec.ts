import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ethical walls (master plan Phase 1) — static fail-closed guards.
 *
 * Client-scope memory was a RELEVANCE boundary (G2); it is now an ACCESS
 * boundary: a walled client's memory (clio_memory scope='client',
 * client-linked memory_items, and their embeddings) is recallable only by
 * users holding a client_memory_access grant. Enforcement is layered:
 *
 *   1. APPLICATION (the binding layer today): every memory read surface
 *      applies fetchDeniedClientIds/clientMemoryAllowed from
 *      memory-wall.helpers.ts. This is asserted below per read path.
 *   2. DATABASE (forward-ready): wall-aware RLS policies shipped in
 *      migration 20260719221000_memory_wall_rls. Dev probing on 2026-07-19
 *      proved the live app role (capiro_app) currently defeats RLS via
 *      owner-role membership, so until the role-hardening remediation lands
 *      the policies are a dormant second boundary, NOT the enforcement.
 *      Asserting their text here catches an accidental policy revert anyway.
 *
 * Like memory-private-fail-closed.spec.ts, this is a pure filesystem scan —
 * the repo's CI has no live RLS-capable Postgres. The DB-boundary proof is a
 * clone rehearsal + the post-role-hardening behavioral probe (SET ROLE
 * capiro_app with/without grants), run by hand per repo discipline.
 */
const SRC_ROOT = join(__dirname, '..'); // apps/api/src
const MIGRATIONS_ROOT = join(__dirname, '..', '..', 'prisma', 'migrations');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

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

describe('Ethical walls — every memory read surface applies the wall', () => {
  it('meri.service.ts: all three recall paths gate the client arm via clientMemoryAllowed', () => {
    const text = read(join(SRC_ROOT, 'meri', 'meri.service.ts'));
    // clioRecall keyword fallback + semanticMemorySearch + projectionRecall.
    const gates = text.match(/clientMemoryAllowed\(tx, tenantId, userId, clientId\)/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(3);
    // The recall reads identify the user (withTenantUser), so the wall-aware
    // RLS policy binds them too once role hardening lands.
    expect(text).toContain('const memories = await this.prisma.withTenantUser(tenantId, userId,');
    expect(text).toContain(
      'const results = await this.prisma.withTenantUser(tenantId, userId,',
    );
  });

  it('meri-tools.service.ts: search_memory and the graph loader exclude denied clients', () => {
    const text = read(join(SRC_ROOT, 'meri', 'meri-tools.service.ts'));
    expect(text.match(/fetchDeniedClientIds\(tx, ctx\.tenantId, ctx\.userId\)/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);
    expect(text).toContain("wallExclusionSql(denied, 'mi.client_id')");
    expect(text).toContain("wallExclusionSql(denied, 'client_id')");
    expect(text).toContain('deniedSet.has(r.srcSlug)');
  });

  it('memory-store.service.ts: list/review-due/get/graph-inputs all carry the wall exclusion', () => {
    const text = read(join(SRC_ROOT, 'memory', 'memory-store.service.ts'));
    const exclusions = text.match(/wallExclusionSql\(denied, 'client_id'\)/g) ?? [];
    expect(exclusions.length).toBeGreaterThanOrEqual(4);
    // Wikilink edges rooted at wall-hidden items must not dangle into the graph.
    expect(text).toContain('visibleItemIds.has(e.src_item_id)');
  });

  it('memory-fk-loader.service.ts: client-rooted FK relations and walled meetings are dropped', () => {
    const text = read(join(SRC_ROOT, 'memory', 'memory-fk-loader.service.ts'));
    expect(text).toContain('fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId)');
    expect(text).toContain('deniedMeetingIds');
    expect(text).toContain("r.srcType === 'client' && deniedSet.has(r.srcSlug)");
  });

  it('memory.controller.ts: an explicit walled-client subgraph request 403s (loud, not empty)', () => {
    const text = read(join(SRC_ROOT, 'memory', 'memory.controller.ts'));
    expect(text).toContain('clientMemoryAllowedForCurrentUser(clientId)');
    expect(text).toContain('ForbiddenException');
  });

  it('memory.controller.ts: PUT sections on a walled client 403s (no skeleton-clobber write)', () => {
    const text = read(join(SRC_ROOT, 'memory', 'memory.controller.ts'));
    // The client-scope write path must gate on the wall before upsertSections —
    // otherwise the wall-hidden read makes the write rebuild from skeleton and
    // clobber the real row. Assert the gate sits in the updateSections handler.
    const put = text.slice(text.indexOf('updateSections'));
    expect(put).toContain('clientMemoryAllowedForCurrentUser(clientId)');
  });

  it('context-compiler.service.ts: client steering load is wall-gated (app-layer, not RLS-only)', () => {
    const text = read(join(SRC_ROOT, 'context', 'context-compiler.service.ts'));
    // Client steering must load only when the caller may see the client — the
    // sole enforcement in an env whose capiro_app RLS is not yet hardened.
    expect(text).toContain('clientMemoryAllowed(tx, req.tenantId, req.userId ?? null');
  });

  it('memory-candidate.service.ts: the review queue withholds walled clients from non-granted reviewers', () => {
    const text = read(join(SRC_ROOT, 'memory', 'memory-candidate.service.ts'));
    expect(text).toContain('fetchDeniedClientIds(tx, tenantId, viewerUserId)');
  });

  it('the wall decision logic lives in exactly one module (no forked copies)', () => {
    const offenders = walkTsFiles(SRC_ROOT).filter((f) => {
      if (f.endsWith(`memory-wall.helpers.ts`)) return false;
      const text = read(f);
      // Hand-rolled wall SQL outside the helpers module is a fork of the
      // decision logic that will drift. Matches SQL column references
      // (c.memory_wall / clients.memory_wall / "memory_wall") — NOT the
      // Prisma camelCase field or audit action labels, which are data plumbing.
      return /(?:\bc\.|\bclients\.|")memory_wall/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

describe('Ethical walls — forward-ready RLS policy text is present (migration 20260719221000)', () => {
  const policySql = read(join(MIGRATIONS_ROOT, '20260719221000_memory_wall_rls', 'migration.sql'));

  it('clio_memory policy gates scope=client rows on client_memory_access + current_user_id()', () => {
    expect(policySql).toContain(`scope <> 'client'`);
    expect(policySql).toContain('c.memory_wall');
    expect(policySql).toContain('client_memory_access');
    expect(policySql).toContain('current_user_id()');
  });

  it('memory_items and context_embeddings policies carry the same wall clause', () => {
    // One wall clause per table: clio_memory + memory_items + context_embeddings.
    const clauses = policySql.match(/NOT EXISTS \(\s*SELECT 1 FROM clients c/g) ?? [];
    expect(clauses.length).toBe(3);
    const grants = policySql.match(/EXISTS \(\s*SELECT 1 FROM client_memory_access a/g) ?? [];
    expect(grants.length).toBe(3);
  });

  it('the additive migration backfills context_embeddings.client_id for memory_item rows', () => {
    const additive = read(
      join(MIGRATIONS_ROOT, '20260719220000_client_memory_walls', 'migration.sql'),
    );
    expect(additive).toContain(`ce."client_id" IS NULL`);
    expect(additive).toContain(`mi."client_id" IS NOT NULL`);
    expect(additive).toContain('client_memory_access');
  });
});
