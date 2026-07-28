import { WatchlistMatchPromoterService } from '../src/linking/watchlist-match-promoter.service.js';

type MatchRow = {
  clientId: string;
  segmentId: string;
  termId: string;
  termType: string;
  termValue: string;
  score: number;
  startMs: number;
};
const M = (
  clientId: string,
  termType: string,
  termValue: string,
  score: number,
  segmentId: string,
  startMs: number,
): MatchRow => ({
  clientId,
  segmentId,
  termId: 't',
  termType,
  termValue,
  score,
  startMs,
});

interface MockOpts {
  locked?: boolean;
  matches?: MatchRow[];
  session?: unknown;
  segments?: unknown[];
  existing?: { dedupeKey: string; id: string; status: string } | null;
}
function mockPrisma(opts: MockOpts) {
  const created: any[] = [];
  const updated: any[] = [];
  const tenantScopes: string[] = [];
  const tx = {
    $queryRawUnsafe: async () => [{ locked: opts.locked ?? true }],
    watchlistMatch: { findMany: async () => opts.matches ?? [] },
    liveHearingSession: { findUnique: async () => opts.session ?? null },
    transcriptSegment: { findMany: async () => opts.segments ?? [] },
    intelAlert: {
      findUnique: async ({ where }: any) =>
        opts.existing && opts.existing.dedupeKey === where.dedupeKey ? opts.existing : null,
      create: async ({ data }: any) => {
        created.push(data);
        return { id: 'new' };
      },
      update: async ({ where, data }: any) => {
        updated.push({ where, data });
        return {};
      },
    },
  };
  // promoteMatches moved from a bare $transaction to withTenant when FORCE RLS
  // was enabled. Keep the test on the real security boundary instead of mocking
  // the obsolete implementation shape (which left this suite red and excluded
  // from the required LegiWatch gate).
  const prisma = {
    withTenant: async (tenantId: string, fn: (t: typeof tx) => Promise<unknown>) => {
      tenantScopes.push(tenantId);
      return fn(tx);
    },
  } as any;
  return { prisma, created, updated, tenantScopes };
}

describe('WatchlistMatchPromoterService.promoteMatches', () => {
  const session = {
    title: 'HASC Markup',
    committeeId: 'hsas00',
    startedAt: null,
    endedAt: new Date('2026-06-24T16:00:00Z'),
  };

  it('skips (no writes) when the advisory lock is not acquired', async () => {
    const { prisma, created, tenantScopes } = mockPrisma({ locked: false });
    const r = await new WatchlistMatchPromoterService(prisma).promoteMatches('t1', 's1');
    expect(r).toEqual({ alerts: 0, skipped: true });
    expect(created).toHaveLength(0);
    expect(tenantScopes).toEqual(['t1']);
  });

  it('emits ONE alert per client (not per term) with risk→notable, plain→info', async () => {
    const matches = [
      M('cA', 'risk', 'moratorium', 0.9, 'seg1', 1000),
      M('cA', 'synonym', 'data center', 0.7, 'seg2', 2000),
      M('cB', 'synonym', 'permitting', 0.6, 'seg3', 3000),
    ];
    const segments = [
      { id: 'seg1', resolvedSpeakerName: 'Rep. Rogers', textPlain: null, issueTags: ['defense'] },
      { id: 'seg2', resolvedSpeakerName: null, textPlain: 'public line', issueTags: [] },
      { id: 'seg3', resolvedSpeakerName: 'Sen. X', textPlain: 'permitting talk', issueTags: ['energy'] },
    ];
    const { prisma, created, tenantScopes } = mockPrisma({ matches, session, segments });
    const r = await new WatchlistMatchPromoterService(prisma).promoteMatches('t1', 's1');
    expect(r.alerts).toBe(2);
    expect(tenantScopes).toEqual(['t1']);
    const a = created.find((c) => c.clientId === 'cA');
    const b = created.find((c) => c.clientId === 'cB');
    expect(a.severity).toBe('notable');
    expect(a.kind).toBe('risk_phrase');
    expect(a.dedupeKey).toBe('hearing:cA:s1');
    expect(a.sourceType).toBe('hearing');
    expect(a.score).toBeCloseTo(1.0, 9); // 0.9 + 0.1 risk boost, capped
    expect(a.evidence.hearing.occurredAt).toBe('2026-06-24T16:00:00.000Z');
    expect(a.evidence.hearing.mentions[0].term).toBe('moratorium'); // ranked by score
    expect(a.evidence.hearing.mentions[0].quoteSource).toBe('encrypted');
    expect(a.evidence.hearing.mentions[1].quoteSource).toBe('textPlain');
    expect(b.severity).toBe('info');
    expect(b.kind).toBe('hearing_mention');
  });

  it('caps evidence mentions at top-K=5 but counts all matches', async () => {
    const matches = Array.from({ length: 8 }, (_, i) =>
      M('cA', 'synonym', `term${i}`, 0.5 - i * 0.01, `seg${i}`, i * 100),
    );
    const segments = matches.map((m) => ({
      id: m.segmentId,
      resolvedSpeakerName: null,
      textPlain: 't',
      issueTags: [],
    }));
    const { prisma, created } = mockPrisma({ matches, session, segments });
    await new WatchlistMatchPromoterService(prisma).promoteMatches('t1', 's1');
    expect(created[0].evidence.hearing.mentions).toHaveLength(5);
    expect(created[0].evidence.link.matchCount).toBe(8);
  });

  it('is idempotent: refreshes a status=new alert, never resurrects a dismissed one', async () => {
    const matches = [M('cA', 'synonym', 'x', 0.6, 'seg1', 0)];
    const segments = [{ id: 'seg1', resolvedSpeakerName: null, textPlain: 't', issueTags: [] }];
    const fresh = mockPrisma({
      matches,
      session,
      segments,
      existing: { dedupeKey: 'hearing:cA:s1', id: 'e1', status: 'new' },
    });
    const r1 = await new WatchlistMatchPromoterService(fresh.prisma).promoteMatches('t1', 's1');
    expect(fresh.created).toHaveLength(0);
    expect(fresh.updated).toHaveLength(1);
    expect(r1.alerts).toBe(1);

    const dismissed = mockPrisma({
      matches,
      session,
      segments,
      existing: { dedupeKey: 'hearing:cA:s1', id: 'e1', status: 'dismissed' },
    });
    const r2 = await new WatchlistMatchPromoterService(dismissed.prisma).promoteMatches('t1', 's1');
    expect(dismissed.created).toHaveLength(0);
    expect(dismissed.updated).toHaveLength(0);
    expect(r2.alerts).toBe(0);
  });
});
