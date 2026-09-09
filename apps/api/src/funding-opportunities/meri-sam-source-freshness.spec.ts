import { MeriOpportunityToolsAdapter } from './meri-opportunity-tools.adapter.js';

describe('Meri SAM source freshness', () => {
  it('reuses the canonical source reader and keeps the all-federal failure distinct from grants', async () => {
    const sam = {
      source: 'sam_gov', verb: 'sync-sam-opportunities-all-federal',
      lastSyncedAt: '2026-07-29T07:55:00.000Z',
      lastAttemptAt: '2026-09-08T07:55:00.000Z',
      lastRunStatus: 'error', lastRunDegraded: true,
    };
    const readFreshness = jest.fn().mockResolvedValue([
      { source: 'grants_gov', lastRunStatus: 'success' }, sam,
    ]);
    const adapter = new MeriOpportunityToolsAdapter(
      {} as never, { readFreshness } as never, {} as never, {} as never,
    );
    await expect(adapter.readSamSourceFreshness()).resolves.toEqual([sam]);
    expect(readFreshness).toHaveBeenCalledTimes(1);
  });

  it('retains unknown source health instead of inventing an empty healthy catalog', async () => {
    const unknown = { source: 'sam_gov', countsUnavailable: true, recordCount: null, lastSyncedAt: null };
    const adapter = new MeriOpportunityToolsAdapter(
      {} as never, { readFreshness: async () => [unknown] } as never, {} as never, {} as never,
    );
    await expect(adapter.readSamSourceFreshness()).resolves.toEqual([unknown]);
  });
});
