import { FeedService, encodeCursor, DEFAULT_STATUSES } from '../src/feed/feed.service.js';

// Crypto stub that never decrypts (feed decrypt-on-read is a no-op).
const NO_CRYPTO = { configured: false, decrypt: () => '' } as any;
// Action-state stub: no memos/talking-points/report flags on any alert.
// (FeedService grew the ActionItemService dep with the alert-actions feature;
// this spec predated it and constructed FeedService without it.)
const NO_ACTIONS = { summaryForAlerts: async () => new Map() } as any;
// SourceData stub: no client-name resolution (P11 global roll-up dep). Per-client
// tests never hit it (clientId short-circuits name resolution).
const NO_SOURCE_DATA = { getClientNames: async () => new Map() } as any;

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
const mkRow = (i: number, score: number, clientId = 'c1') => ({
  id: `id${i}`,
  clientId,
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
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', 'c1', {});
    const w = getArgs().where;
    expect(w.tenantId).toBe('t1');
    expect(w.clientId).toBe('c1');
    expect(w.status).toEqual({ in: DEFAULT_STATUSES });
  });

  it('computes hasMore + nextCursor from the extra row', async () => {
    const { prisma } = mockPrisma(Array.from({ length: 26 }, (_, i) => mkRow(i, 0.5)));
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', 'c1', { limit: 25 });
    expect(r.items).toHaveLength(25);
    expect(r.hasMore).toBe(true);
    expect(r.nextCursor).toBeTruthy();
  });

  it('has no next page when rows ≤ limit', async () => {
    const { prisma } = mockPrisma(Array.from({ length: 10 }, (_, i) => mkRow(i, 0.5)));
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', 'c1', { limit: 25 });
    expect(r.hasMore).toBe(false);
    expect(r.nextCursor).toBeNull();
  });

  it('builds a 2-part keyset for date order', async () => {
    const cursor = encodeCursor('date', { score: 0.5, createdAt: new Date('2026-06-24T00:00:00Z'), id: 'idX' });
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', 'c1', { order: 'date', cursor });
    const a = getArgs();
    expect(a.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(a.where.OR).toHaveLength(2);
  });

  it('builds a 3-part keyset for score order', async () => {
    const cursor = encodeCursor('score', { score: 0.7, createdAt: new Date('2026-06-24T00:00:00Z'), id: 'idX' });
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', 'c1', { order: 'score', cursor });
    const a = getArgs();
    expect(a.orderBy).toEqual([{ score: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
    expect(a.where.OR).toHaveLength(3);
  });

  it('clamps limit to 100', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', 'c1', { limit: 9999 });
    expect(getArgs().take).toBe(101);
  });

  it('applies sourceType/severity/date filters and maps counts', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)], [{ sourceType: 'bill', _count: 12 }, { sourceType: 'combined', _count: 3 }]);
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', 'c1', {
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

describe('FeedService.getFeed tenant-wide roll-up (P11)', () => {
  it('drops the clientId predicate when clientId is null (still tenant-scoped)', async () => {
    const { prisma, getArgs } = mockPrisma(
      [mkRow(1, 0.5, 'cA'), mkRow(2, 0.4, 'cB')],
      [{ sourceType: 'bill', _count: 2 }],
    );
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', null, {});
    const w = getArgs().where;
    expect(w.tenantId).toBe('t1');
    expect(w.clientId).toBeUndefined();
    expect(w.status).toEqual({ in: DEFAULT_STATUSES });
  });

  it('keeps the keyset predicate + ordering across clients (no OFFSET)', async () => {
    const cursor = encodeCursor('date', {
      score: 0.5,
      createdAt: new Date('2026-06-24T00:00:00Z'),
      id: 'idX',
    });
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5, 'cA')]);
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', null, {
      order: 'date',
      cursor,
    });
    const a = getArgs();
    expect(a.where.clientId).toBeUndefined();
    expect(a.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(a.where.OR).toHaveLength(2);
    expect(a.skip).toBeUndefined(); // keyset, never OFFSET
  });

  it('labels each alert with its clientId + resolved clientName', async () => {
    const { prisma } = mockPrisma([mkRow(1, 0.5, 'cA'), mkRow(2, 0.4, 'cB')]);
    const sourceData = {
      getClientNames: async (_t: string, ids: string[]) => {
        expect(ids).toEqual(['cA', 'cB']);
        return new Map([
          ['cA', 'Acme Defense'],
          ['cB', 'Beacon AI'],
        ]);
      },
    } as any;
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, sourceData).getFeed('t1', null, {});
    expect((r.items[0] as any).clientId).toBe('cA');
    expect((r.items[0] as any).clientName).toBe('Acme Defense');
    expect((r.items[1] as any).clientName).toBe('Beacon AI');
  });

  it('does not resolve names for the per-client view (clientName null)', async () => {
    const { prisma } = mockPrisma([mkRow(1, 0.5, 'c1')]);
    const sourceData = {
      getClientNames: async () => {
        throw new Error('should not be called for a per-client feed');
      },
    } as any;
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, sourceData).getFeed('t1', 'c1', {});
    expect((r.items[0] as any).clientName).toBeNull();
  });
});

describe('FeedService decrypt-on-read', () => {
  const encRow = () => ({
    id: 'a1',
    sourceType: 'hearing',
    kind: 'hearing_mention',
    severity: 'notable',
    materiality: 'medium',
    score: 0.6,
    clientImpact: 'monitor',
    urgency: 'med',
    title: 't',
    whyItMatters: null,
    recommendedAction: null,
    status: 'new',
    createdAt: new Date('2026-06-24T00:00:00Z'),
    evidence: {
      hearing: {
        mentions: [
          { segmentId: 'seg1', quoteSource: 'encrypted', quote: null },
          { segmentId: 'seg2', quoteSource: 'textPlain', quote: 'already here' },
        ],
      },
    },
  });
  function prismaWithSeg(seg: any) {
    return {
      intelAlert: { findMany: async () => [encRow()], groupBy: async () => [] },
      transcriptSegment: { findMany: async () => (seg ? [seg] : []) },
    } as any;
  }

  it('fills encrypted quotes via HearingCryptoService, leaves textPlain intact', async () => {
    const crypto = { configured: true, decrypt: () => 'DECRYPTED' } as any;
    const prisma = prismaWithSeg({ id: 'seg1', textCiphertext: 'ct', iv: 'iv', authTag: 'tag' });
    const r = await new FeedService(prisma, crypto, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', 'c1', {});
    const mentions = (r.items[0] as any).evidence.hearing.mentions;
    expect(mentions[0].quote).toBe('DECRYPTED');
    expect(mentions[1].quote).toBe('already here');
  });

  it('fails closed: decrypt error leaves quote null, never leaks ciphertext', async () => {
    const crypto = {
      configured: true,
      decrypt: () => {
        throw new Error('bad key');
      },
    } as any;
    const prisma = prismaWithSeg({ id: 'seg1', textCiphertext: 'ct', iv: 'iv', authTag: 'tag' });
    const r = await new FeedService(prisma, crypto, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', 'c1', {});
    expect((r.items[0] as any).evidence.hearing.mentions[0].quote).toBeNull();
  });

  it('is a no-op when no key is configured', async () => {
    const prisma = prismaWithSeg({ id: 'seg1', textCiphertext: 'ct', iv: 'iv', authTag: 'tag' });
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA).getFeed('t1', 'c1', {});
    expect((r.items[0] as any).evidence.hearing.mentions[0].quote).toBeNull();
  });
});
