import type { OpportunitySourceFreshnessV2 } from '@capiro/shared';
import { MeriOpportunityToolsAdapter } from './meri-opportunity-tools.adapter.js';
const AS_OF = new Date('2026-09-17T00:00:00.000Z');
const CONTEXT = { tenantId: 'tenant-1', userId: 'user-1' };

describe('Meri SAM source freshness', () => {
  it('uses the distinct observed source-health clock for hours since success', async () => {
    const healthAsOf = new Date('2026-10-19T08:00:00.000Z');
    const lastSyncedAt = '2026-10-19T03:00:00.000Z';
    const sam: OpportunitySourceFreshnessV2 = {
      source: 'sam_gov', state: 'current', recordCount: 12, activeRecordCount: 9,
      lastSyncedAt, latestAttemptAt: lastSyncedAt, lastSuccessAt: lastSyncedAt,
    };
    const readSourceHealth = jest.fn().mockResolvedValue({
      sources: [sam], generatedAt: '2026-10-19T06:00:00.000Z',
    });
    const adapter = new MeriOpportunityToolsAdapter(
      {} as never, { readSourceHealth } as never, {} as never, {} as never, {} as never,
    );
    const [result] = await adapter.readSamSourceFreshness(CONTEXT, healthAsOf);
    expect(readSourceHealth).toHaveBeenCalledWith(CONTEXT);
    expect(result).toMatchObject({
      source: 'sam_gov', state: 'current', lastSyncedAt,
      countsUnavailable: false, neverSynced: false, lastRunDegraded: false,
      hoursSinceLastSuccess: 5,
    });
  });

  it('clamps future last-success age to zero and retains null for never-synced source', async () => {
    const healthAsOf = new Date('2026-10-19T08:00:00.000Z');
    const rows: OpportunitySourceFreshnessV2[] = [
      { source: 'sam_gov', state: 'current', recordCount: 1, activeRecordCount: 1,
        lastSyncedAt: '2026-10-19T09:00:00.000Z' },
      { source: 'sam_gov', state: 'never_synced', recordCount: null, activeRecordCount: null,
        lastSyncedAt: null },
    ];
    for (const [index, sam] of rows.entries()) {
      const adapter = new MeriOpportunityToolsAdapter(
        {} as never,
        { readSourceHealth: async () => ({ sources: [sam], generatedAt: AS_OF.toISOString() }) } as never,
        {} as never, {} as never, {} as never,
      );
      const [result] = await adapter.readSamSourceFreshness(CONTEXT, healthAsOf);
      expect(result!.hoursSinceLastSuccess).toBe(index === 0 ? 0 : null);
      expect(result!.neverSynced).toBe(index === 1);
    }
  });

  it('retains the owner clock when no private observation was admitted', async () => {
    const now = Date.parse('2026-10-19T08:00:00.000Z');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const sam: OpportunitySourceFreshnessV2 = {
        source: 'sam_gov', state: 'current', recordCount: 1, activeRecordCount: 1,
        lastSyncedAt: '2026-10-19T03:00:00.000Z',
      };
      const adapter = new MeriOpportunityToolsAdapter(
        {} as never,
        { readSourceHealth: async () => ({ sources: [sam], generatedAt: AS_OF.toISOString() }) } as never,
        {} as never, {} as never, {} as never,
      );
      const [result] = await adapter.readSamSourceFreshness(CONTEXT);
      expect(result!.hoursSinceLastSuccess).toBe(5);
    } finally {
      clock.mockRestore();
    }
  });

  it('maps canonical source state without converting a stale/error run into a healthy catalog', async () => {
    const sam: OpportunitySourceFreshnessV2 = {
      source: 'sam_gov', state: 'error_cached', recordCount: null, activeRecordCount: null,
      lastSyncedAt: '2026-07-29T07:55:00.000Z', latestAttemptAt: '2026-09-08T07:55:00.000Z',
      lastSuccessAt: '2026-07-29T07:55:00.000Z',
    };
    const readSourceHealth = jest.fn().mockResolvedValue({ sources: [sam], generatedAt: AS_OF.toISOString() });
    const adapter = new MeriOpportunityToolsAdapter(
      {} as never, { readSourceHealth } as never, {} as never, {} as never, {} as never,
    );
    await expect(adapter.readSamSourceFreshness(CONTEXT)).resolves.toMatchObject([{
      source: 'sam_gov', state: 'error_cached', recordCount: null, countsUnavailable: true,
      neverSynced: false, lastRunStatus: 'error_cached', lastRunDegraded: true,
    }]);
    expect(readSourceHealth).toHaveBeenCalledWith(CONTEXT);
  });

  it('keeps confirmed never-synced distinct from unknown/unavailable coverage', async () => {
    const states: OpportunitySourceFreshnessV2[] = [
      { source: 'sam_gov', state: 'never_synced', recordCount: null, activeRecordCount: null, lastSyncedAt: null },
      { source: 'sam_gov', state: 'unknown', recordCount: null, activeRecordCount: null, lastSyncedAt: null },
      { source: 'sam_gov', state: 'unavailable', recordCount: null, activeRecordCount: null, lastSyncedAt: null },
    ];
    for (const sam of states) {
      const adapter = new MeriOpportunityToolsAdapter(
        {} as never, { readSourceHealth: async () => ({ sources: [sam], generatedAt: AS_OF.toISOString() }) } as never, {} as never, {} as never, {} as never,
      );
      const result = (await adapter.readSamSourceFreshness(CONTEXT))[0]!;
      expect(result.neverSynced).toBe(sam.state === 'never_synced');
      expect(result.countsUnavailable).toBe(true);
    }
  });
});
