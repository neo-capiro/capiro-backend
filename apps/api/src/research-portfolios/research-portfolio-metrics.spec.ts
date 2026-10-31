import type { TenantContext } from '@capiro/shared';
import { readResearchPortfolioMetrics } from './research-portfolio-metrics.js';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2), clerkUserId: 'synthetic-clerk', role: 'standard_user' } as TenantContext;
const at = Date.parse('2026-10-31T12:00:00Z');
const row = (n: number, extra = {}) => ({ id: id(n), tenantId: ctx.tenantId, lifecycle: 'active',
  grants: [{ id: id(n + 10000), tenantId: ctx.tenantId, principalUserId: ctx.userId, role: 'viewer', updatedAt: new Date(at) }],
  clientLinks: [], ...extra });
const link = (clientId: string) => ({ id: id(50), tenantId: ctx.tenantId, clientId, createdAt: new Date(at) });
function matches(value: any, where: any): boolean {
  if (where === null || typeof where !== 'object') return value === where;
  if ('in' in where) return where.in.includes(value);
  if ('some' in where) return value.some((entry: any) => matches(entry, where.some));
  return Object.entries(where).every(([key, part]) => matches(value?.[key], part));
}
function fixture(initial: any[] = [row(100)]) {
  const rows = structuredClone(initial), visible = new Set([id(40)]);
  const state = { active: true, role: 'standard_user', at, afterCount: () => {} };
  const tx: any = {
    tenantMembership: { findFirst: jest.fn(async ({ where }: any) => state.active &&
      where.tenantId === ctx.tenantId && where.userId === ctx.userId && where.user.clerkUserId === ctx.clerkUserId ?
      { id: id(3), role: state.role, updatedAt: new Date(at) } : null) },
    researchPortfolio: {
      findMany: jest.fn(async ({ where, take, select }: any) => rows.filter(r => matches(r, where))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, take).map(r => structuredClone({ id: r.id,
          grants: r.grants.filter((g: any) => matches(g, select.grants.where)).slice(0, select.grants.take)
            .map((g: any) => ({ id: g.id, role: g.role, updatedAt: g.updatedAt })),
          ...(select.clientLinks ? { clientLinks: r.clientLinks.filter((l: any) => matches(l, select.clientLinks.where))
            .slice(0, select.clientLinks.take).map((l: any) => ({ id: l.id, createdAt: l.createdAt })) } : {}),
        }))),
      count: jest.fn(async ({ where }: any) => {
        const result = rows.filter(r => matches(r, where)).length; state.afterCount(); return result;
      }),
    },
    client: { findFirst: jest.fn(async ({ where }: any) => visible.has(where.id) &&
      where.tenantId === ctx.tenantId ? { id: where.id } : null) },
    $queryRawUnsafe: jest.fn(async (_sql: string, _tenant: string, clientId: string) => [{ allowed: visible.has(clientId) }]),
  };
  const prisma: any = { withTenant: jest.fn(async (tenant: string, run: any) => {
    expect(tenant).toBe(ctx.tenantId); return run(tx);
  }) };
  const run = (query: unknown = {}) => readResearchPortfolioMetrics(prisma, ctx, query, () => state.at);
  return { rows, visible, state, tx, prisma, run };
}

test('counts more than 50 active granted portfolios, including unlinked ones, once per primary identity', async () => {
  const f = fixture([...Array.from({ length: 70 }, (_, n) => row(n + 100)),
    row(200, { lifecycle: 'archived' }), row(201, { tenantId: id(9) }), row(202, { grants: [] }),
    row(203, { grants: [{ ...row(203).grants[0], principalUserId: id(9) }] }),
    row(204, { clientLinks: [link(id(40)), link(id(41))] })]);
  await expect(f.run()).resolves.toEqual({ metric: 'active_research_portfolios', version: 1,
    scope: { kind: 'granted' }, observedAt: new Date(at).toISOString(),
    status: 'complete', complete: true, capped: false, count: 71 });
  expect(f.tx.researchPortfolio.count).toHaveBeenCalledTimes(1);
  expect(f.tx.researchPortfolio.count.mock.calls[0][0]).not.toHaveProperty('take');
});

test.each(['viewer', 'editor', 'owner'])('explicit %s grant is eligible', async role => {
  const f = fixture([row(100, { grants: [{ ...row(100).grants[0], role }] })]);
  await expect(f.run()).resolves.toMatchObject({ count: 1 });
});

test('selected client requires an exact readable saved link', async () => {
  const f = fixture([row(100), row(101, { clientLinks: [link(id(40))] }), row(102, { clientLinks: [link(id(41))] })]);
  await expect(f.run({ clientId: id(40) })).resolves.toMatchObject({ scope: { kind: 'client', clientId: id(40) }, count: 1 });
  await expect(f.run({ clientId: id(99) })).rejects.toThrow('Client not found');
  expect(f.tx.researchPortfolio.count).toHaveBeenCalledTimes(1);
});

test('no grants is complete zero; observation overflow withholds the value without counting a page', async () => {
  await expect(fixture([]).run()).resolves.toMatchObject({ count: 0, complete: true });
  const f = fixture(Array.from({ length: 4097 }, (_, n) => row(n + 100)));
  await expect(f.run()).resolves.toMatchObject({ status: 'incomplete', count: null, complete: false, capped: true });
  expect(f.tx.researchPortfolio.count).not.toHaveBeenCalled();
});

test('4096 complete observations remain supported and a same-count identity replacement is withheld', async () => {
  await expect(fixture(Array.from({ length: 4096 }, (_, n) => row(n + 100))).run())
    .resolves.toMatchObject({ count: 4096, complete: true, capped: false });
  const f = fixture();
  f.state.afterCount = () => { f.rows[0] = row(999); };
  await expect(f.run()).rejects.toThrow('unavailable');
});

test.each(['grant', 'grant-role', 'membership', 'member-role', 'client', 'link', 'lifecycle'])('post-count %s change withholds output', async change => {
  const f = fixture([row(100, { clientLinks: [link(id(40))] })]);
  f.state.afterCount = () => {
    if (change === 'grant') f.rows[0].grants = [];
    else if (change === 'grant-role') f.rows[0].grants[0].role = 'editor';
    else if (change === 'membership') f.state.active = false;
    else if (change === 'member-role') f.state.role = 'user_admin';
    else if (change === 'client') f.visible.clear();
    else if (change === 'link') f.rows[0].clientLinks = [];
    else f.rows[0].lifecycle = 'archived';
  };
  await expect(f.run({ clientId: id(40) })).rejects.toThrow();
});

test.each([{ clientId: ['a', 'b'] }, { clientId: 'name' }, { clientId: null }, { limit: 50 }, []])(
  'rejects invalid selectors without database access', async query => {
    const f = fixture(); await expect(f.run(query)).rejects.toThrow();
    expect(f.prisma.withTenant).not.toHaveBeenCalled();
  });

test('outage, inconsistent aggregate and timeout are never successful zero', async () => {
  const down = fixture(); down.tx.researchPortfolio.count.mockRejectedValue(Error('synthetic outage'));
  await expect(down.run()).rejects.toThrow('synthetic outage');
  const invalid = fixture(); invalid.tx.researchPortfolio.count.mockResolvedValue(0);
  await expect(invalid.run()).rejects.toThrow('unavailable');
  const late = fixture(); late.state.afterCount = () => { late.state.at += 10_000; };
  await expect(late.run()).rejects.toThrow('unavailable');
});
