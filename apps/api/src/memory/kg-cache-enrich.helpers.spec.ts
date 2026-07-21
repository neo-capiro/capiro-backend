import {
  aggSuffix,
  cacheEdgeKey,
  cacheEdgesToFkRelations,
  enrichFromKgCache,
  keepCacheEdge,
  type KgWalkEdgeRow,
} from './kg-cache-enrich.helpers.js';

const edge = (over: Partial<KgWalkEdgeRow> = {}): KgWalkEdgeRow => ({
  depth: 1,
  src_kind: 'client',
  src_id: '11111111-1111-1111-1111-111111111111',
  dst_kind: 'lda_client',
  dst_id: '189497',
  edge_type: 'client_mapped_to_lda',
  confidence: 0.95,
  source: 'manual_confirmed',
  origin: 'tenant',
  observed_at: null,
  agg_weight: null,
  agg_count: null,
  ...over,
});

describe('aggSuffix', () => {
  it('formats dollar aggregates with counts (FEC money-flow edges)', () => {
    expect(aggSuffix(14_500_000, 630)).toBe(' ($14,500,000 over 630)');
    expect(aggSuffix('2500000.75', null)).toBe(' ($2,500,001)');
  });
  it('formats filing counts when there is no dollar weight (LDA edges)', () => {
    expect(aggSuffix(null, 12)).toBe(' (12 filings)');
  });
  it('is empty for plain relationship edges', () => {
    expect(aggSuffix(null, null)).toBe('');
    expect(aggSuffix(null, 1)).toBe('');
    expect(aggSuffix(0, null)).toBe('');
  });
});

describe('keepCacheEdge', () => {
  it('drops unconfirmed auto-matches (candidate pool, not resolved state)', () => {
    expect(keepCacheEdge(edge({ source: 'auto_matched' }))).toBe(false);
    expect(keepCacheEdge(edge({ source: 'manual_confirmed' }))).toBe(true);
  });
  it('drops meeting/mail overlay duplicates (System A already carries them)', () => {
    expect(keepCacheEdge(edge({ edge_type: 'meeting_with_client' }))).toBe(false);
    expect(keepCacheEdge(edge({ edge_type: 'mail_thread_with_client' }))).toBe(false);
    expect(keepCacheEdge(edge({ edge_type: 'employer_contributed_to_committee' }))).toBe(true);
  });
});

describe('cacheEdgesToFkRelations', () => {
  it('maps to System-A node ids with resolved labels and agg-annotated relations', () => {
    const labels = new Map([
      ['client:11111111-1111-1111-1111-111111111111', 'CloudWest LLC'],
      ['lda_client:189497', 'CloudWest Federal'],
    ]);
    const rel = cacheEdgesToFkRelations([edge()], labels)[0]!;
    expect(rel).toEqual({
      srcType: 'client',
      srcSlug: '11111111-1111-1111-1111-111111111111',
      srcLabel: 'CloudWest LLC',
      dstType: 'lda_client',
      dstSlug: '189497',
      dstLabel: 'CloudWest Federal',
      relation: 'client_mapped_to_lda',
    });
  });
  it('falls back to the raw id when no label resolves, and annotates aggregates', () => {
    const rel = cacheEdgesToFkRelations(
      [
        edge({
          src_kind: 'employer',
          src_id: 'ACME CORP',
          dst_kind: 'fec_committee',
          dst_id: 'C00123456',
          edge_type: 'employer_contributed_to_committee',
          agg_weight: 250_000,
          agg_count: 41,
        }),
      ],
      new Map(),
    )[0]!;
    expect(rel.srcLabel).toBe('ACME CORP');
    expect(rel.dstLabel).toBe('C00123456');
    expect(rel.relation).toBe('employer_contributed_to_committee ($250,000 over 41)');
  });
});

describe('enrichFromKgCache', () => {
  const CLIENT_A = '11111111-1111-1111-1111-111111111111';
  const CLIENT_B = '22222222-2222-2222-2222-222222222222';
  const WALLED = '33333333-3333-3333-3333-333333333333';

  const fakeTx = (rowsPerCall: KgWalkEdgeRow[][]) => {
    const calls: unknown[][] = [];
    let i = 0;
    return {
      calls,
      $queryRaw: (async (...args: unknown[]) => {
        calls.push(args);
        const out = rowsPerCall[Math.min(i, rowsPerCall.length - 1)];
        i += 1;
        return out;
      }) as unknown,
    } as never;
  };

  it('never seeds a walk from a denied client (defensive re-filter)', async () => {
    const tx = fakeTx([[]]);
    const res = await enrichFromKgCache(tx, {
      tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      deniedClientIds: [WALLED],
      clients: [
        { id: CLIENT_A, name: 'A' },
        { id: WALLED, name: 'Walled' },
      ],
    });
    expect(res.clientsTotal).toBe(1); // the walled client is not a seed at all
    expect(res.clientsWalked).toBe(1);
    expect((tx as { calls: unknown[][] }).calls.length).toBe(1);
  });

  it('dedups edges reachable from multiple clients and drops noise/auto-matches', async () => {
    const shared = edge({ src_id: CLIENT_A });
    const tx = fakeTx([
      [shared, edge({ source: 'auto_matched', dst_id: 'x' })],
      [shared, edge({ edge_type: 'meeting_with_client', dst_id: 'y' })],
    ]);
    const res = await enrichFromKgCache(tx, {
      tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      deniedClientIds: [],
      clients: [
        { id: CLIENT_A, name: 'A' },
        { id: CLIENT_B, name: 'B' },
      ],
    });
    expect(res.relations).toHaveLength(1);
    expect(res.truncated).toBe(false);
    // The seed client's own name labels its node.
    expect(res.relations[0]!.srcLabel).toBe('A');
  });

  it('stops at the edge ceiling and reports truncation honestly', async () => {
    const many = Array.from({ length: 10 }, (_, k) => edge({ dst_id: `d${k}` }));
    const tx = fakeTx([many, many]);
    const res = await enrichFromKgCache(tx, {
      tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      deniedClientIds: [],
      clients: [
        { id: CLIENT_A, name: 'A' },
        { id: CLIENT_B, name: 'B' },
      ],
      edgeCeiling: 5,
    });
    expect(res.relations).toHaveLength(5);
    expect(res.truncated).toBe(true);
    expect(res.clientsWalked).toBe(1); // ceiling hit before the second walk
  });

  it('stops at the wall-clock deadline (pool protection) and reports truncation', async () => {
    let t = 0;
    const tx = fakeTx([[edge()]]);
    const res = await enrichFromKgCache(tx, {
      tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      deniedClientIds: [],
      clients: [
        { id: CLIENT_A, name: 'A' },
        { id: CLIENT_B, name: 'B' },
      ],
      deadlineMs: 100,
      now: () => {
        t += 400; // every clock read jumps past the deadline
        return t;
      },
    });
    expect(res.clientsWalked).toBeLessThan(2);
    expect(res.truncated).toBe(true);
  });
});
