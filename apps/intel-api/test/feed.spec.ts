import { FeedService, encodeCursor, DEFAULT_STATUSES } from '../src/feed/feed.service.js';

function mockPrisma(rows: any[], groups?: any[]) {
  let lastArgs: any = null;
  const prisma = {
    intelAlert: {
      findMany: async (args: any) => {
        lastArgs = args;
        return rows.slice(0, args.take);
      },
      groupBy: async () => groups ?? [],
    },
  } as any;
  return { prisma, getArgs: () => lastArgs };
}
const mkRow = (i: number, score: number) => ({
  id: `id${i}`,
  sourceType: 'bill',
  kind: 'bill',
  severity: 'notable',
  materiality: 'medium',
  score,
  clientImpact: 'monitor',
  urgency: 'med',
  title: `t${i}`,
  whyItMatters: null,
  recommendedAction: null,
  evidence: {},
  status: 'new',
  createdAt: new Date(Date.UTC(2026, 5, 24, 0, 0, i)),
});

describe('encodeCursor', () => {
  it('encodes {t,id} for date order', () => {
    const o = JSON.parse(Buffer.from(encodeCursor('date', { score: 0.5, createdAt: new Date('2026-06-24T18:00:00Z'), id: 'a1' }), 'base64url').toString());
    expect(o).toEqual({ t: '2026-06-24T18:00:00.000Z', id: 'a1' });
  });
  it('encodes {s,t,id} for score order', () => {
    const o = JSON.parse(Buffer.from(encodeCursor('score', { score: 0.82, createdAt: new Date('2026-06-24T18:00:00Z'), id: 'a1' }), 'base64url').toString());
    expect(o.s).toBe(0.82);
    expect(o.id).toBe('a1');
  });
});

describe('FeedService.getFeed', () => {
  it('always filters tenantId + clientId and applies default statuses', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)], [{ sourceType: 'bill', _count: 1 }]);
    await new FeedService(prisma).getFeed('t1', 'c1', {});
    const w = getArgs().where;
    expect(w.tenantId).toBe('t1');
    expect(w.clientId).toBe('c1');
    expect(w.status).toEqual({ in: DEFAULT_STATUSES });
  });

  it('computes hasMore + nextCursor from the extra row', async () => {
    const { prisma } = mockPrisma(Array.from({ length: 26 }, (_, i) => mkRow(i, 0.5)));
    const r = await new FeedService(prisma).getFeed('t1', 'c1', { limit: 25 });
    expect(r.items).toHaveLength(25);
    expect(r.hasMore).toBe(true);
    expect(r.nextCursor).toBeTruthy();
  });

  it('has no next page when rows ≤ limit', async () => {
    const { prisma } = mockPrisma(Array.from({ length: 10 }, (_, i) => mkRow(i, 0.5)));
    const r = await new FeedService(prisma).getFeed('t1', 'c1', { limit: 25 });
    expect(r.hasMore).toBe(false);
    expect(r.nextCursor).toBeNull();
  });

  it('builds a 2-part keyset for date order', async () => {
    const cursor = encodeCursor('date', { score: 0.5, createdAt: new Date('2026-06-24T00:00:00Z'), id: 'idX' });
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    await new FeedService(prisma).getFeed('t1', 'c1', { order: 'date', cursor });
    const a = getArgs();
    expect(a.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(a.where.OR).toHaveLength(2);
  });

  it('builds a 3-part keyset for score order', async () => {
    const cursor = encodeCursor('score', { score: 0.7, createdAt: new Date('2026-06-24T00:00:00Z'), id: 'idX' });
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    await new FeedService(prisma).getFeed('t1', 'c1', { order: 'score', cursor });
    const a = getArgs();
    expect(a.orderBy).toEqual([{ score: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
    expect(a.where.OR).toHaveLength(3);
  });

  it('clamps limit to 100', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    await new FeedService(prisma).getFeed('t1', 'c1', { limit: 9999 });
    expect(getArgs().take).toBe(101);
  });

  it('applies sourceType/severity/date filters and maps counts', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)], [{ sourceType: 'bill', _count: 12 }, { sourceType: 'combined', _count: 3 }]);
    const r = await new FeedService(prisma).getFeed('t1', 'c1', {
      sourceTypes: ['combined'],
      severities: ['critical'],
      since: new Date('2026-06-01'),
      until: new Date('2026-07-01'),
    });
    const w = getArgs().where;
    expect(w.sourceType).toEqual({ in: ['combined'] });
    expect(w.severity).toEqual({ in: ['critical'] });
    expect(w.createdAt.gte).toBeInstanceOf(Date);
    expect(w.createdAt.lt).toBeInstanceOf(Date);
    expect(r.counts).toEqual({ bill: 12, combined: 3 });
  });
});
