import {
  advanceCursor,
  buildRailPlan,
  deriveLastSyncAt,
  executeRailRead,
  parseCursor,
  type RailPlanReaders,
} from './district-nexus-retrieval.helpers.js';

const availableRead = { read: async () => ({}) };
const readers: RailPlanReaders = {
  strategic: availableRead,
  economicFootprint: availableRead,
  supplierFootprint: availableRead,
  economicContext: () => availableRead,
  priorityIntelligence: () => availableRead,
};

describe('District Nexus retrieval helpers', () => {
  it('rejects an invalid cursor without recovering partial cursor state', () => {
    expect(parseCursor('not-a-json-cursor')).toBeUndefined();
    expect(
      parseCursor(
        Buffer.from(JSON.stringify({ client: 'client-a', offset: -1 })).toString('base64url'),
      ),
    ).toBeUndefined();
  });

  it('hands the cursor to the next client only after the current client rail plan is complete', () => {
    const result = advanceCursor({
      clientIds: ['client-a', 'client-b'],
      clientIndex: 0,
      clientId: 'client-a',
      offset: 4,
      pageLength: 2,
      railCount: 6,
    });

    expect(result).toMatchObject({ hasMore: true, moreRails: false });
    expect(parseCursor(result.nextCursor)).toEqual({ client: 'client-b', offset: 0 });
  });

  it('rebuilds the rail plan from the current footprint so a stale footprint offset is outside the plan', () => {
    const priorPlan = buildRailPlan({ districts: [{ districtKey: 'VA-10' }] }, readers);
    const currentPlan = buildRailPlan({ districts: [] }, readers);

    expect(priorPlan).toHaveLength(6);
    expect(currentPlan.map((rail) => rail.key)).toEqual([
      'verified_footprint',
      'strategic_relevance',
      'economic_footprint',
      'supplier_footprint_status',
    ]);
    expect(currentPlan[4]).toBeUndefined();
  });

  it('preserves a base-read failure as unavailable with null data', async () => {
    const read = jest.fn().mockRejectedValue(new Error('base read failed'));

    await expect(executeRailRead({ key: 'verified_footprint', read })).resolves.toEqual({
      status: 'unavailable',
      data: null,
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('derives the oldest complete sync time and preserves missing freshness as undefined', () => {
    expect(
      deriveLastSyncAt([
        { lastSyncedAt: '2026-09-01T00:00:00Z' },
        { lastSyncedAt: '2026-08-01T00:00:00Z' },
      ]),
    ).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(
      deriveLastSyncAt([{ lastSyncedAt: '2026-09-01T00:00:00Z' }, { lastSyncedAt: null }]),
    ).toBeUndefined();
    expect(deriveLastSyncAt([])).toBeUndefined();
  });
});
