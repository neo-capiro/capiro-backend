import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 3 (3a) — private memory is fail-closed by an owner filter.
 *
 * Private (visibility='user') memory does not leak today, but that protection is
 * query-level discipline. These static guards fail CI if a future query forgets
 * the owner filter:
 *   1. Any semantic read that JOINs context_embeddings to memory_items over
 *      source_type='memory_item' MUST also constrain owner_user_id.
 *   2. The known memory_items read paths keep their visibility/owner guard.
 *
 * Pure filesystem scan — no DB, no app bootstrap.
 */
const SRC_ROOT = join(__dirname, '..'); // apps/api/src

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTsFiles(p));
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) out.push(p);
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

    const meri = readFileSync(join(SRC_ROOT, 'meri', 'meri.service.ts'), 'utf8');
    // loadUserVoiceContext: user-voice/profile files are scoped to their owner.
    expect(meri).toMatch(/owner_user_id = \$\{ctx\.userId\}::uuid/);
    // semanticMemorySearch: user_private clio_memory rows are scoped to the owner.
    expect(meri).toMatch(/scope = 'user_private' AND owner_user_id = \$3::uuid/);
  });
});
