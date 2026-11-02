import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { MAIL_THREAD_LIST_BUDGET_MS, readMailThreadList } from './mail-thread-list.js';

const tenant = '10000000-0000-4000-8000-000000000001', actor = '20000000-0000-4000-8000-000000000001';
const client = '30000000-0000-4000-8000-000000000001';
const ctx = { tenantId: tenant, userId: actor } as TenantContext;
const asOf = '2026-10-01T12:00:00.000Z';
const row = (n: number) => ({ id: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  tenantId: tenant, clientId: client, connectionId: 'box', subject: 'Synthetic thread', snippet: 'Preview',
  createdAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-20'), lastMessageAt: new Date('2026-09-19'),
  cursorUpdatedAt: '2026-09-20T00:00:00.000123Z', cursorLastMessageAt: '2026-09-19T00:00:00.000456Z',
  participants: [], messages: [], connectionEmail: 'owner@example.test' });
function harness() {
  const tx = { $executeRaw: jest.fn(async () => 1), $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
    $queryRaw: jest.fn(async (_query: Prisma.Sql) => [row(3), row(2), row(1)]),
    tenantMembership: { findFirst: jest.fn(async () => ({ id: 'member' })) },
    client: { findFirst: jest.fn(async () => ({ id: client })) },
    integrationConnection: { findMany: jest.fn(async () => [{ id: 'box', accountEmail: 'owner@example.test',
      provider: 'google_workspace', status: 'connected', syncState: {}, lastSyncAt: null }]) } };
  const prisma = { withTenant: jest.fn(async (_id: string, read: (tx: unknown) => unknown) => read(tx)) };
  const profile = jest.fn(async () => ['person@example.test']);
  const read = (input = {}, scope = ctx) => readMailThreadList(prisma as any, scope, { asOf, limit: 2, ...input }, profile);
  return { tx, prisma, profile, read };
}

describe('bounded live mail thread list', () => {
  it('limits the authorized thread selection before reading bounded message previews', async () => {
    const h = harness(); const result = await h.read({ clientId: client, recipientEmails: [' Person@EXAMPLE.TEST '] });
    const query = h.tx.$queryRaw.mock.calls[0]![0];
    expect(query.sql).toContain('WITH selected AS MATERIALIZED');
    expect(query.sql.indexOf('LIMIT ?')).toBeLessThan(query.sql.indexOf('LEFT JOIN LATERAL'));
    expect(query.sql).toContain('t.tenant_id=?::uuid AND c.created_by_user_id=?::uuid');
    expect(query.sql).toContain('ma.connection_id=t.connection_id');
    expect(query.sql).toContain('ma.removed_at IS NULL');
    expect(query.sql).toContain('m.removed_at IS NULL');
    expect(query.sql).toContain('LIMIT 3'); expect(query.sql).toContain('left(p.body_text,400)');
    expect(query.values).toContain(3); expect(query.values).toContain(tenant); expect(query.values).toContain(actor);
    expect(query.values).toContainEqual(['person@example.test']);
    expect(h.profile).toHaveBeenCalledWith(h.tx, client);
    expect(result.items).toHaveLength(2); expect(result.hasMore).toBe(true); expect(result.nextCursor).toEqual(expect.any(String));
    expect(result.mailboxes[0]!.coverage.backfillComplete).toBe(false);
  });
  it('continues the same filters and asOf using the activity/date/UUID tuple without OFFSET', async () => {
    const h = harness(); const first = await h.read();
    h.tx.$queryRaw.mockResolvedValueOnce([row(1)]);
    const last = await h.read({ cursor: first.nextCursor });
    const query = h.tx.$queryRaw.mock.calls[1]![0];
    expect(query.sql).toContain('(t.updated_at,t.id) <');
    expect(query.sql).not.toContain('OFFSET'); expect(query.values).toContain(row(2).id);
    expect(query.values).toContain('2026-09-20T00:00:00.000123Z');
    expect(query.values).toContain('2026-09-19T00:00:00.000456Z');
    expect(last).toMatchObject({ asOf, hasMore: false, nextCursor: null, items: [{ id: row(1).id }] });
  });
  it.each([{ limit: 0 }, { limit: 51 }, { folder: 'trash' }, { withinDays: 0 },
    { clientId: 'invalid' }, { recipientEmails: ['x'.repeat(321)] }, { cursor: 'invalid' }])('rejects invalid filter/page before SQL: %j', async input => {
    const h = harness(); await expect(h.read(input)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
  });
  it('binds cursors to actor, client, recipient, query, folder, date and limit', async () => {
    const h = harness(); const first = await h.read();
    for (const filter of [{ clientId: client }, { recipientEmails: ['new@example.test'] }, { query: 'different' },
      { folder: 'inbox' }, { withinDays: 14 }, { limit: 1 }, { asOf: '2026-09-01' }]) {
      await expect(h.read({ cursor: first.nextCursor, ...filter })).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(h.read({ cursor: first.nextCursor }, { ...ctx, userId: client })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('keeps literal wildcard search and the shared folder/date predicates parameterized', async () => {
    const h = harness(); await h.read({ query: 'quote %_', folder: 'sent', withinDays: 14 });
    const query = h.tx.$queryRaw.mock.calls[0]![0];
    expect(query.sql).toContain("IN ('sent', 'sentitems')");
    expect(query.sql).toContain('COALESCE(m.received_at, m.sent_at) >=');
    expect(query.values).toContain('%quote \\%\\_%');
    expect(query.values).toContainEqual(new Date('2026-09-17T12:00:00Z'));
    expect(query.sql).not.toContain('quote');
  });
  it('rechecks membership and the selected client wall before reading any thread IDs', async () => {
    const h = harness(); h.tx.$queryRawUnsafe.mockResolvedValueOnce([{ allowed: false }]);
    await expect(h.read({ clientId: client })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.$queryRaw).not.toHaveBeenCalled(); expect(h.profile).not.toHaveBeenCalled();
    h.tx.tenantMembership.findFirst.mockResolvedValueOnce(null as any);
    await expect(h.read()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('reports bounded coverage inventory instead of claiming all connected accounts were checked', async () => {
    const h = harness(); const box = (await h.tx.integrationConnection.findMany())[0]!;
    h.tx.integrationConnection.findMany.mockResolvedValue(Array.from({ length: 51 }, (_, i) => ({ ...box, id: String(i) })));
    const result = await h.read(); expect(result.coverageTruncated).toBe(true); expect(result.mailboxes).toHaveLength(50);
    expect(h.tx.integrationConnection.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 51,
      where: { tenantId: tenant, createdByUserId: actor, provider: { in: ['microsoft_365', 'google_workspace'] } } }));
  });

  it('applies the default 10 s statement budget and lets a derived reader pass a smaller one', async () => {
    const h = harness();
    await h.read({ clientId: client });
    const budgets = (h.tx.$executeRaw.mock.calls as unknown as unknown[][])
      .filter((call) => (call[0] as string[]).join('').includes('statement_timeout')).map((call) => call[1]);
    expect(budgets).toEqual([`${MAIL_THREAD_LIST_BUDGET_MS}ms`]);
    expect((h.prisma.withTenant.mock.calls[0] as unknown[])[2]).toMatchObject({ readOnly: true, timeoutMs: MAIL_THREAD_LIST_BUDGET_MS + 2_000 });

    const derived = harness();
    await readMailThreadList(derived.prisma as any, ctx, { asOf, limit: 2, clientId: client }, derived.profile, { budgetMs: 5_000 });
    const derivedBudgets = (derived.tx.$executeRaw.mock.calls as unknown as unknown[][])
      .filter((call) => (call[0] as string[]).join('').includes('statement_timeout')).map((call) => call[1]);
    expect(derivedBudgets).toEqual(['5000ms']);
    expect((derived.prisma.withTenant.mock.calls[0] as unknown[])[2]).toMatchObject({ timeoutMs: 7_000 });
    await expect(readMailThreadList(derived.prisma as any, ctx, { asOf, limit: 2 }, derived.profile, { budgetMs: 20_000 })).rejects.toThrow(RangeError);
  });
});
