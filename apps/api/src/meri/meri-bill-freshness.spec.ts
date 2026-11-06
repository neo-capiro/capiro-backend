import { MeriFederalLegislationTools } from './meri-federal-legislation-tools.js';

describe('stored federal bill freshness', () => {
  afterEach(() => jest.useRealTimers());
  it.each([new Date('2025-01-01T00:00:00.000Z'), null])('reports the source snapshot time %s independently of response and action dates', async (lastSyncedAt) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-06T12:00:00.000Z'));
    const service = new MeriFederalLegislationTools({
      congressBill: { findUnique: async () => ({ id: '119-s-2809', title: 'Synthetic bill', congress: 119,
        status: 'rule_failed', statusAt: null, latestActionText: 'Synthetic action',
        latestActionDate: new Date('2024-12-31T00:00:00.000Z'), lastSyncedAt,
        sponsorName: null, sponsorBioguideId: null, cosponsorsCount: 0 }) },
      congressBillAction: { findMany: async () => [] }, rollCallVote: { findMany: async () => [] },
      billRuleLink: { findMany: async () => [] },
    } as never, {} as never);
    const page = JSON.parse(JSON.stringify(await service.getBillStatus({ billId: '119-s-2809' })));
    expect(page.lastSyncedAt).toBe(lastSyncedAt?.toISOString() ?? null);
    expect(page.generatedAt).toBe('2026-11-06T12:00:00.000Z');
    expect(page.latestAction.date).toBe('2024-12-31T00:00:00.000Z');
    expect(page.note).toContain(lastSyncedAt ? `last synced at ${lastSyncedAt.toISOString()}` : 'snapshot sync time is unknown');
    expect(page.note).toContain('Live status has not been checked');
    expect(page.note).toContain('No recorded roll-call vote');
    expect(page.note).toContain('The rule governing this bill FAILED');
  });
});
