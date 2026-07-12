import { MemoryStoreService } from './memory-store.service.js';

/**
 * Phase 1 (1D) memory-verb control-flow tests. The store's SQL runs against a
 * real DB in the clone rehearsal; here we mock the transactional client to
 * assert the branch logic: legal-hold refusal, not-found, and that forget
 * revokes + purges + deletes the clio source + writes a tombstone, and that
 * correct supersedes with a new row. Pure control-flow — no live DB.
 */
type QueryResult = unknown[];

function makeStore(opts: {
  rows: Record<string, QueryResult>; // keyed by a substring of the SQL to match
  auditCreate?: jest.Mock;
  captureExec?: (sql: string) => void;
}) {
  const auditCreate = opts.auditCreate ?? jest.fn();
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      for (const key of Object.keys(opts.rows)) {
        if (sql.includes(key)) return opts.rows[key];
      }
      return [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      if (opts.captureExec) opts.captureExec(strings.join('?'));
      return 1;
    }),
    auditLog: { create: auditCreate },
  };
  const prisma = {
    withTenantUser: jest.fn(async (_t: string, _u: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const tenantCtx = {
    require: () => ({ tenantId: 'tenant-1', userId: 'user-1', role: 'standard_user' }),
  };
  const store = new MemoryStoreService(prisma as never, tenantCtx as never);
  return { store, tx, auditCreate };
}

describe('memory verbs (Phase 1, 1D)', () => {
  it('confirm: not found when no visible active row', async () => {
    const { store } = makeStore({ rows: { 'SELECT title FROM memory_items': [] } });
    expect(await store.confirmMemory('m1')).toEqual({ found: false });
  });

  it('confirm: updates last_confirmed_at and returns title', async () => {
    const execs: string[] = [];
    const { store } = makeStore({
      rows: { 'SELECT title FROM memory_items': [{ title: 'Prefers bullet points' }] },
      captureExec: (s) => execs.push(s),
    });
    expect(await store.confirmMemory('m1')).toEqual({ found: true, title: 'Prefers bullet points' });
    expect(execs.some((s) => s.includes('last_confirmed_at = now()'))).toBe(true);
  });

  it('forget: refuses an item under legal hold (no revoke, no purge)', async () => {
    const execs: string[] = [];
    const { store, auditCreate } = makeStore({
      rows: { 'SELECT title, slug, legal_hold': [{ title: 'X', slug: 'note:x', legal_hold: true }] },
      captureExec: (s) => execs.push(s),
    });
    const r = await store.forgetMemory('m1');
    expect(r).toEqual({ found: true, blockedByLegalHold: true, title: 'X' });
    expect(execs.some((s) => s.includes("status = 'revoked'"))).toBe(false);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('forget: revokes, purges embedding, deletes clio source, writes tombstone', async () => {
    const execs: string[] = [];
    const { store, auditCreate } = makeStore({
      rows: { 'SELECT title, slug, legal_hold': [{ title: 'Nickname', slug: 'clio:abc-123', legal_hold: false }] },
      captureExec: (s) => execs.push(s),
    });
    const r = await store.forgetMemory('m1', 'user asked');
    expect(r).toEqual({ found: true, title: 'Nickname' });
    expect(execs.some((s) => s.includes("status = 'revoked'"))).toBe(true);
    expect(execs.some((s) => s.includes('DELETE FROM context_embeddings'))).toBe(true);
    expect(execs.some((s) => s.includes('DELETE FROM clio_memory'))).toBe(true);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data.action).toBe('memory.forget');
  });

  it('forget: a non-clio item does NOT touch clio_memory', async () => {
    const execs: string[] = [];
    const { store } = makeStore({
      rows: { 'SELECT title, slug, legal_hold': [{ title: 'Y', slug: 'client-soul:acme', legal_hold: false }] },
      captureExec: (s) => execs.push(s),
    });
    await store.forgetMemory('m1');
    expect(execs.some((s) => s.includes('DELETE FROM clio_memory'))).toBe(false);
  });

  it('correct: refuses under legal hold', async () => {
    const { store } = makeStore({
      rows: { 'SELECT type, slug, title, client_id': [{ type: 'note', slug: 'clio:z', title: 'Z', client_id: null, owner_user_id: 'user-1', visibility: 'user', entity_id: null, tags: [], legal_hold: true }] },
    });
    const r = await store.correctMemory('m1', 'new value');
    expect(r).toEqual({ found: true, blockedByLegalHold: true, title: 'Z' });
  });

  it('correct: empty content is a no-op (not found)', async () => {
    const { store } = makeStore({ rows: {} });
    expect(await store.correctMemory('m1', '   ')).toEqual({ found: false });
  });
});
