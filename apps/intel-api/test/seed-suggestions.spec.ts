import { TrackerSeedService } from '../src/tracker/tracker-seed.service.js';

/**
 * P1.1 — watchlist seed-suggestions, ported from apps/api
 * tracker.service.getSeedSuggestions. Pure-unit with mocked prisma + repo:
 * dedup against UNIFIED topics/issue-areas and the legacy sector-default
 * carryover (no watchlist row → the sector-derived area counts as selected).
 */
function svcWith(opts: {
  wl?: { issueAreas: string[] } | null;
  topics?: Array<{ label: string }>;
  client?: { name: string | null; sectorTag: string | null } | null;
  caps?: Array<{ tags: unknown; sector: string | null }>;
}) {
  const tx = {
    watchlist: { findFirst: jest.fn(async () => opts.wl ?? null) },
    watchlistTopic: { findMany: jest.fn(async () => opts.topics ?? []) },
  };
  const prisma = { withTenant: jest.fn(async (_tenantId: string, fn: (db: typeof tx) => Promise<unknown>) => fn(tx)) };
  const repo = {
    getClientProfile: jest.fn(async () => opts.client ?? null),
    getClientCapabilities: jest.fn(async () => opts.caps ?? []),
  };
  return { service: new TrackerSeedService(prisma as never, repo as never), prisma, tx, repo };
}

describe('TrackerSeedService.getSeedSuggestions', () => {
  it('turns capability tags into monitor/med tag rows with empty term arrays', async () => {
    const { service: svc } = svcWith({
      wl: { issueAreas: [] },
      caps: [{ tags: ['hypersonics', 'solid rocket motors'], sector: null }],
    });
    const res = await svc.getSeedSuggestions('t1', 'c1');
    expect(res.tags).toEqual([
      {
        tag: 'hypersonics',
        issueArea: null,
        synonyms: [],
        relatedEntities: [],
        riskTerms: [],
        typedTerms: [],
        position: 'monitor',
        priority: 'med',
      },
      expect.objectContaining({ tag: 'solid rocket motors' }),
    ]);
  });

  it('excludes capability tags already present as unified topic labels (case-insensitive)', async () => {
    const { service: svc } = svcWith({
      wl: { issueAreas: [] },
      topics: [{ label: 'Hypersonics' }],
      caps: [{ tags: ['hypersonics', 'directed energy'], sector: null }],
    });
    const res = await svc.getSeedSuggestions('t1', 'c1');
    expect(res.tags.map((t) => t.tag)).toEqual(['directed energy']);
  });

  it('dedups repeated tags across capabilities and skips non-string/blank entries', async () => {
    const { service: svc } = svcWith({
      wl: { issueAreas: [] },
      caps: [
        { tags: ['radar', ' radar ', 7, ''], sector: null },
        { tags: ['RADAR'], sector: null },
      ],
    });
    const res = await svc.getSeedSuggestions('t1', 'c1');
    expect(res.tags.map((t) => t.tag)).toEqual(['radar']);
  });

  it('suggests sector-derived issue areas not already on the watchlist', async () => {
    const { service: svc } = svcWith({
      wl: { issueAreas: [] },
      client: { name: 'Aperture', sectorTag: 'DEFENSE' },
      caps: [{ tags: [], sector: 'ENERGY' }],
    });
    const res = await svc.getSeedSuggestions('t1', 'c1');
    expect(res.issueAreas).toEqual(['Defense', 'Energy']);
  });

  it('excludes issue areas already selected on the unified watchlist', async () => {
    const { service: svc } = svcWith({
      wl: { issueAreas: ['Defense'] },
      client: { name: 'Aperture', sectorTag: 'DEFENSE' },
      caps: [{ tags: [], sector: 'ENERGY' }],
    });
    const res = await svc.getSeedSuggestions('t1', 'c1');
    expect(res.issueAreas).toEqual(['Energy']);
  });

  it('legacy sector-default carryover: NO watchlist row → the sector area counts as selected', async () => {
    const { service: svc, tx } = svcWith({
      wl: null,
      client: { name: 'Aperture', sectorTag: 'DEFENSE' },
      caps: [{ tags: [], sector: 'ENERGY' }],
    });
    const res = await svc.getSeedSuggestions('t1', 'c1');
    // 'Defense' is default-selected (legacy getWatchlist carryover), so only
    // the capability-derived 'Energy' is suggested.
    expect(res.issueAreas).toEqual(['Energy']);
    expect(tx.watchlistTopic.findMany).not.toHaveBeenCalled();
  });

  it('uses the supplied tenant and client for both transaction reads and source reads', async () => {
    const { service, prisma, tx, repo } = svcWith({ wl: { issueAreas: [] } });
    await service.getSeedSuggestions('tenant-other', 'client-other');
    expect(prisma.withTenant).toHaveBeenCalledTimes(2);
    for (const call of prisma.withTenant.mock.calls) expect(call).toEqual(['tenant-other', expect.any(Function)]);
    expect(tx.watchlist.findFirst).toHaveBeenCalledWith({ where: { id: 'wl:client-other', tenantId: 'tenant-other' }, select: { issueAreas: true } });
    expect(tx.watchlistTopic.findMany).toHaveBeenCalledWith({ where: { watchlistId: 'wl:client-other', tenantId: 'tenant-other' }, select: { label: true } });
    expect(repo.getClientProfile).toHaveBeenCalledWith('tenant-other', 'client-other');
    expect(repo.getClientCapabilities).toHaveBeenCalledWith('tenant-other', 'client-other');
  });

  it('does not turn a failed tenant read into empty suggestions', async () => {
    const { service, prisma, tx } = svcWith({ wl: { issueAreas: [] } });
    const failure = new Error('tenant read unavailable');
    prisma.withTenant.mockRejectedValueOnce(failure);
    await expect(service.getSeedSuggestions('t1', 'c1')).rejects.toBe(failure);
    expect(tx.watchlistTopic.findMany).not.toHaveBeenCalled();
  });
});
