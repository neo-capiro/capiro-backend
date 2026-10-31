import type { TenantContext } from '@capiro/shared';
import { readClassicOutreachMetrics } from './classic-outreach-metrics.js';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2), clerkUserId: 'synthetic-clerk', role: 'standard_user' } as TenantContext;
const end = Date.parse('2026-10-31T12:00:00Z'), start = end - 30 * 86400000;
const row = (n: number, extra = {}) => ({ id: id(n), tenantId: ctx.tenantId, createdByUserId: ctx.userId,
  clientId: null, meetingId: null, meeting: null, type: 'follow_up', deletedAt: null,
  createdAt: new Date(end - 1000), sentAt: null, updatedAt: new Date(end - 1000), ...extra });
function matches(value: any, where: any): boolean {
  if (where === null || typeof where !== 'object') return value === where;
  if ('in' in where) return where.in.includes(value);
  if ('notIn' in where) return !where.notIn.includes(value);
  if ('not' in where) return !matches(value, where.not);
  if ('gte' in where || 'lt' in where) return Object.prototype.toString.call(value) === '[object Date]' &&
    (where.gte === undefined || value >= where.gte) && (where.lt === undefined || value < where.lt);
  return Object.entries(where).every(([key, part]: [string, any]) => key === 'OR' ?
    part.some((item: any) => matches(value, item)) : key === 'AND' ?
      (Array.isArray(part) ? part : [part]).every((item: any) => matches(value, item)) : matches(value?.[key], part));
}
function fixture(initial: any[] = [row(10)]) {
  const rows = structuredClone(initial), visible = new Set([id(40)]);
  const state = { active: true, at: end, afterCount: () => {} };
  const tx: any = {
    tenantMembership: { findFirst: jest.fn(async ({ where }: any) => state.active &&
      where.tenantId === ctx.tenantId && where.userId === ctx.userId && where.user.clerkUserId === ctx.clerkUserId ?
      { id: id(3), role: 'standard_user' } : null) },
    outreachRecord: {
      findMany: jest.fn(async ({ where, take }: any) => rows.filter(r => matches(r, where))
        .slice(0, take).map(r => ({ id: r.id, clientId: r.clientId, meetingId: r.meetingId,
          meeting: r.meeting, updatedAt: new Date(r.updatedAt) }))),
      count: jest.fn(async ({ where }: any) => {
        const result = rows.filter(r => matches(r, where)).length; state.afterCount(); return result;
      }),
    },
    client: { findFirst: jest.fn(async ({ where }: any) => visible.has(where.id) &&
      where.tenantId === ctx.tenantId ? { id: where.id } : null) },
    $queryRawUnsafe: jest.fn(async (_sql: string, _tenant: string, clientId: string) => [{ allowed: visible.has(clientId) }]),
  };
  const prisma: any = { withTenant: jest.fn(async (tenant: string, callback: any) => {
    expect(tenant).toBe(ctx.tenantId); return callback(tx);
  }) };
  const run = (query: unknown = {}) => readClassicOutreachMetrics(prisma, ctx, query, () => state.at);
  return { rows, visible, state, tx, prisma, run };
}

test('full personal population exceeds a list page, includes client-less rows and excludes other owners/tenants/internal/deleted/denied records', async () => {
  const f = fixture([...Array.from({ length: 70 }, (_, n) => row(n + 100)),
    row(10, { clientId: id(40) }), row(11, { clientId: id(99) }),
    row(12, { createdByUserId: id(9) }), row(13, { tenantId: id(9) }),
    row(14, { type: 'outreach_v3' }), row(15, { deletedAt: new Date(end) }), row(16, { meetingId: id(52) })]);
  await expect(f.run()).resolves.toEqual({ metric: 'personal_classic_outreach_30d', version: 1,
    scope: { kind: 'personal_classic' }, window: { start: new Date(start).toISOString(),
      end: new Date(end).toISOString(), bounds: '[start,end)', basis: 'created_or_sent' },
    observedAt: new Date(end).toISOString(), status: 'complete', complete: true, capped: false, count: 71 });
  expect(f.tx.outreachRecord.count).toHaveBeenCalledTimes(1);
});

test('UTC trailing window includes start, excludes end, and counts created plus sent only once', async () => {
  const f = fixture([row(10, { createdAt: new Date(start) }),
    row(11, { createdAt: new Date(start - 1), sentAt: new Date(start) }),
    row(12, { sentAt: new Date(end - 1) }),
    row(13, { createdAt: new Date(end) }),
    row(14, { createdAt: new Date(start - 1), sentAt: new Date(end) })]);
  await expect(f.run()).resolves.toMatchObject({ count: 3, complete: true });
});

test('selected client is exact and current-readable; no inferred association or General fallthrough', async () => {
  const f = fixture([row(10), row(11, { clientId: id(40) }), row(12, { clientId: id(41) })]);
  await expect(f.run({ clientId: id(40) })).resolves.toMatchObject({ scope: { kind: 'client', clientId: id(40) }, count: 1 });
  await expect(f.run({ clientId: id(99) })).rejects.toThrow('Client not found');
  expect(f.tx.outreachRecord.count).toHaveBeenCalledTimes(1);
});

test('complete empty authority returns zero while 101 candidates withhold a count', async () => {
  await expect(fixture([]).run()).resolves.toMatchObject({ count: 0, complete: true, capped: false });
  const f = fixture(Array.from({ length: 101 }, (_, n) => row(n + 100)));
  await expect(f.run()).resolves.toMatchObject({ count: null, complete: false, capped: true, status: 'incomplete' });
  expect(f.tx.outreachRecord.count).not.toHaveBeenCalled();
});

test('the complete 100-candidate authority boundary remains supported', async () => {
  await expect(fixture(Array.from({ length: 100 }, (_, n) => row(n + 100))).run())
    .resolves.toMatchObject({ count: 100, complete: true, capped: false });
});

test.each(['membership', 'client', 'record'])('post-count %s change withholds the count', async change => {
  const f = fixture([row(10, { clientId: id(40) })]);
  f.state.afterCount = () => {
    if (change === 'membership') f.state.active = false;
    else if (change === 'client') f.visible.clear();
    else f.rows[0].updatedAt = new Date(end);
  };
  await expect(f.run()).rejects.toThrow();
});

test.each([{ clientId: ['a', 'b'] }, { clientId: 'name' }, { clientId: null }, { limit: 50 }, []])(
  'rejects malformed or additional selectors before reading', async query => {
    const f = fixture(); await expect(f.run(query)).rejects.toThrow();
    expect(f.prisma.withTenant).not.toHaveBeenCalled();
  });

test('infrastructure failures, unsafe counts and deadlines are not zero or incomplete', async () => {
  const down = fixture(); down.tx.outreachRecord.count.mockRejectedValue(Error('synthetic outage'));
  await expect(down.run()).rejects.toThrow('synthetic outage');
  const invalid = fixture(); invalid.tx.outreachRecord.count.mockResolvedValue(Number.MAX_SAFE_INTEGER + 1);
  await expect(invalid.run()).rejects.toThrow('unavailable');
  const late = fixture(); late.state.afterCount = () => { late.state.at += 10_000; };
  await expect(late.run()).rejects.toThrow('timed out');
});
