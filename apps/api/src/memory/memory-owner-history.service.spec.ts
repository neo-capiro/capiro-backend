import { describe, expect, it, jest, afterEach } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  MemoryOwnerHistoryService,
  assertLineage,
  historyEntry,
} from './memory-owner-history.service.js';
import type { HistoryRow } from './memory-owner-history.queries.js';
jest.mock('./conversation-serving/transaction.js', () => ({
  withMemoryConversationRetention: (
    prisma: PrismaService,
    tenant: string,
    user: string,
    run: never,
  ) => prisma.withTenantUser(tenant, user, run),
}));
const id = '11111111-1111-4111-8111-111111111111';
const row: HistoryRow = {
  id,
  predecessor: null,
  revision: '2026-10-31T12:00:00.123456Z',
  createdAt: '2026-10-30T12:00:00.000001Z',
  title: 'Synthetic memory',
  sections: [{ body: 'Retained content' }],
  current: true,
  eligible: true,
  sourceType: null,
  cycle: false,
};
const ctx = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
  role: 'standard_user',
} as TenantContext;
const oldTenants = process.env.MEMORY_GOVERNANCE_TENANTS;
const old = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
afterEach(() => {
  if (oldTenants === undefined) delete process.env.MEMORY_GOVERNANCE_TENANTS;
  else process.env.MEMORY_GOVERNANCE_TENANTS = oldTenants;
  if (old === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  else process.env.MEMORY_GOVERNANCE_LIFECYCLE = old;
});
function service(results: unknown[]) {
  process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
  process.env.MEMORY_GOVERNANCE_TENANTS = 'all';
  const queries: unknown[] = [];
  const prisma = {
    withTenantUser: async (
      tenant: string,
      user: string,
      run: (tx: unknown) => Promise<unknown>,
    ) => {
      expect([tenant, user]).toEqual([ctx.tenantId, ctx.userId]);
      return run({
        $queryRaw: async (sql: unknown) => {
          queries.push(sql);
          return results.shift();
        },
      });
    },
  } as unknown as PrismaService;
  return { read: new MemoryOwnerHistoryService(prisma), queries };
}
describe('owner history', () => {
  function chain(size: number): HistoryRow[] {
    const ids = Array.from(
      { length: size },
      (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
    );
    return ids.map((id, i) => ({
      ...row,
      id,
      predecessor: ids[i + 1] ?? null,
      current: i === 0,
      cycle: false,
    }));
  }
  it.each([999, 1000])('accepts a complete equal-timestamp chain of %i nodes', (size) => {
    expect(() => assertLineage(chain(size))).not.toThrow();
  });
  it.each([0, 500, 999])(
    'rejects an exact-cap cycle returning to node %i without a SQL cycle flag',
    (index) => {
      const rows = chain(1000);
      rows[999]!.predecessor = rows[index]!.id;
      expect(() => assertLineage(rows)).toThrow();
      expect(() => assertLineage([...rows].reverse())).toThrow();
    },
  );
  it('rejects truncation at the cap and an over-cap complete chain', () => {
    const rows = chain(1001);
    expect(() => assertLineage(rows.slice(0, 1000))).toThrow();
    expect(() => assertLineage(rows)).toThrow();
  });
  it('returns retained canonical content and exact timestamps', async () => {
    const { read } = service([[row], [row], [row]]);
    const page = await read.list(ctx, id);
    expect(page.entries[0]?.content).toEqual({
      availability: 'available',
      text: 'Retained content',
    });
    expect(page.anchor.revision).toBe(row.revision);
  });
  it('refuses an inaccessible anchor before reading lineage', async () => {
    const { read, queries } = service([[]]);
    await expect(read.list(ctx, id)).rejects.toMatchObject({ status: 404 });
    expect(queries).toHaveLength(1);
  });
  it('filters hidden versions before filling the page', async () => {
    const hidden = {
      ...row,
      id: '44444444-4444-4444-8444-444444444444',
      eligible: false,
      current: false,
    };
    const { read } = service([[row], [hidden, row], [row]]);
    expect((await read.list(ctx, id, { limit: 1 })).entries.map((entry) => entry.id)).toEqual([id]);
  });
  it('refuses changes during the read', async () => {
    const { read } = service([[row], [row], [{ ...row, revision: '2026-10-31T12:00:00.123457Z' }]]);
    await expect(read.list(ctx, id)).rejects.toMatchObject({ status: 409 });
  });
  it('does not treat truncated or cyclic lineage as complete', () => {
    for (const rows of [
      [],
      [{ ...row, cycle: true }],
      [row, row],
      [{ ...row, predecessor: 'missing' }],
      Array.from({ length: 1001 }, () => row),
    ])
      expect(() => assertLineage(rows)).toThrow();
  });
  it('reports malformed and oversized canonical content without reconstruction', () => {
    expect(historyEntry({ ...row, sections: null }).content).toEqual({
      availability: 'unavailable',
      reason: 'malformed',
    });
    expect(historyEntry({ ...row, sections: [{ body: 'x'.repeat(600000) }] }).content).toEqual({
      availability: 'unavailable',
      reason: 'size_limit',
    });
    expect(historyEntry({ ...row, current: false }).status).toBe('superseded');
  });
});
