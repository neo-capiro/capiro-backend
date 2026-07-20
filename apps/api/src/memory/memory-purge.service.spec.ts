import { describe, expect, it, jest } from '@jest/globals';
import { MemoryPurgeService } from './memory-purge.service.js';

/**
 * Unit test with a recording transaction mock (no live DB): verifies the
 * safety invariants of the destructive purge — dry-run deletes nothing, execute
 * issues the cross-store deletes, legal-held rows are excluded, every statement
 * is tenant-scoped, and the action is audited.
 */
type Recorded = { executed: string[]; queried: string[]; audits: Array<Record<string, unknown>> };

function makeService(opts?: { held?: Array<{ id: string; slug: string }> }): {
  svc: MemoryPurgeService;
  rec: Recorded;
} {
  const rec: Recorded = { executed: [], queried: [], audits: [] };
  const held = opts?.held ?? [];
  const tx = {
    $queryRaw: (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      rec.queried.push(sql);
      if (/legal_hold = true/.test(sql)) return Promise.resolve(held);
      if (/count\(\*\)/.test(sql)) return Promise.resolve([{ n: 0n }]);
      return Promise.resolve([]);
    },
    $executeRaw: (strings: TemplateStringsArray) => {
      rec.executed.push(strings.join('?'));
      return Promise.resolve(1);
    },
    auditLog: {
      create: (a: { data: Record<string, unknown> }) => {
        rec.audits.push(a.data);
        return Promise.resolve({});
      },
    },
  };
  const prisma = {
    withSystem: (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test injection
  const svc = new MemoryPurgeService(prisma as any);
  return { svc, rec };
}

const T = '11111111-1111-1111-1111-111111111111';
const C = '22222222-2222-2222-2222-222222222222';
const actor = { userId: '33333333-3333-3333-3333-333333333333', role: 'user_admin' };

describe('MemoryPurgeService.purgeClient', () => {
  it('dry-run performs ZERO deletes and audits a dry_run action', async () => {
    const { svc, rec } = makeService();
    const result = await svc.purgeClient(T, C, actor, { dryRun: true, reason: 'offboarding' });
    expect(rec.executed).toHaveLength(0);
    expect(result.dryRun).toBe(true);
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]?.action).toBe('memory.purge_client.dry_run');
  });

  it('defaults to dry-run when dryRun is omitted (never delete by accident)', async () => {
    const { svc, rec } = makeService();
    await svc.purgeClient(T, C, actor, { reason: 'offboarding' });
    expect(rec.executed).toHaveLength(0);
  });

  it('execute issues the cross-store deletes and audits a purge action', async () => {
    const { svc, rec } = makeService();
    const result = await svc.purgeClient(T, C, actor, { dryRun: false, reason: 'offboarding' });
    // context_embeddings, memory_edges, memory_items, clio_memory,
    // memory_candidate, client_memory_access = 6 deletes.
    expect(rec.executed).toHaveLength(6);
    expect(result.dryRun).toBe(false);
    expect(rec.audits[0]?.action).toBe('memory.purge_client');
  });

  it('every delete is tenant-scoped (no cross-tenant reach)', async () => {
    const { svc, rec } = makeService();
    await svc.purgeClient(T, C, actor, { dryRun: false, reason: 'x' });
    for (const sql of rec.executed) {
      expect(sql).toMatch(/tenant_id = /);
    }
  });

  it('memory_items / edges deletes exclude legal_hold rows', async () => {
    const { svc, rec } = makeService();
    await svc.purgeClient(T, C, actor, { dryRun: false, reason: 'x' });
    const itemsDelete = rec.executed.find((s) => /DELETE FROM memory_items/.test(s));
    expect(itemsDelete).toMatch(/legal_hold = false/);
  });

  it('reports heldBack when legal-held items exist', async () => {
    const { svc } = makeService({ held: [{ id: 'a', slug: 'clio:x' }] });
    const result = await svc.purgeClient(T, C, actor, { dryRun: false, reason: 'x' });
    expect(result.heldBack).toBe(1);
  });
});
