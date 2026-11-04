import { BadRequestException } from '@nestjs/common';
import { PortfolioTrackingService, matchingApprovedTerms } from './portfolio-tracking.service.js';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  role: 'user_admin',
} as const;
const clientId = '30000000-0000-4000-8000-000000000003';
const capabilityId = '40000000-0000-4000-8000-000000000004';
const termId = '50000000-0000-4000-8000-000000000005';
const source = {
  itemKind: 'bill',
  itemId: 'fixture-bill',
  title: 'Fixture sensor bill',
  url: 'https://example.gov/fixture',
  occurredAt: '2026-01-01T00:00:00Z',
  dateKind: 'published' as const,
  searchText: 'Fixture sensor bill',
};
describe('approved capability tracking', () => {
  it('shares canonical whole-word semantics, not substring or model scores', () => {
    expect(
      matchingApprovedTerms(source, [{ id: termId, kind: 'keyword', value: 'sensor' }]),
    ).toHaveLength(1);
    expect(
      matchingApprovedTerms(source, [{ id: termId, kind: 'keyword', value: 'sens' }]),
    ).toHaveLength(0);
    expect(matchingApprovedTerms(source, [])).toHaveLength(0);
  });
  it('only matches a PE term to the exact program identity', () => {
    expect(
      matchingApprovedTerms({ ...source, itemKind: 'budget', itemId: '0600000A' }, [
        { id: termId, kind: 'pe', value: '0600000a' },
      ]),
    ).toHaveLength(1);
    expect(
      matchingApprovedTerms({ ...source, itemKind: 'budget', itemId: '0600000B' }, [
        { id: termId, kind: 'pe', value: '0600000a' },
      ]),
    ).toHaveLength(0);
  });
  it('uses canonical hearing bill links and official committee jurisdiction as dated match evidence', async () => {
    const tx = {
      committeeHearing: {
        findFirst: jest
          .fn()
          .mockResolvedValue({
            id: 'hearing',
            title: 'Fixture oversight',
            url: 'https://example.gov/hearing',
            date: new Date('2026-01-01'),
            startsAt: null,
            committeeName: 'Fixture committee',
            committeeSystemCode: 'fixture',
          }),
      },
      committeeHearingBill: { findMany: jest.fn().mockResolvedValue([{ billId: 'fixture-bill' }]) },
      legislativeAgendaItem: { findMany: jest.fn().mockResolvedValue([]) },
      congressCommittee: {
        findFirst: jest.fn().mockResolvedValue({ jurisdiction: 'Fixture sensor systems' }),
      },
      congressBill: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ title: 'Fixture sensor bill', subjects: ['sensors'] }]),
      },
    };
    const service = new PortfolioTrackingService({} as never, {} as never, {} as never);
    const item = await service.source(tx as never, ctx as never, clientId, 'hearing', 'hearing');
    expect(item).toMatchObject({
      dateKind: 'scheduled',
      url: 'https://example.gov/hearing',
      context: 'Official hearing agenda or bill linkage',
    });
    expect(
      matchingApprovedTerms(item!, [{ id: termId, kind: 'keyword', value: 'sensor' }]),
    ).toHaveLength(1);
    expect(tx.congressCommittee.findFirst).toHaveBeenCalledWith({
      where: {
        systemCode: 'fixture',
        isCurrent: true,
        urlSource: 'congress_gov',
        urlVerifiedAt: { not: null },
      },
    });
  });
  function fixture() {
    const tx = {
      clientCapability: { findFirst: jest.fn().mockResolvedValue({ id: capabilityId }) },
      clientCapabilityTerm: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: termId, kind: 'keyword', value: 'sensor', evidence: [{ url: source.url }] },
          ]),
      },
      clientCapabilityTracking: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(async ({ create }) => create),
      },
    };
    const store = { withClient: jest.fn(async (_ctx, _client, _write, work) => work(tx)) };
    const service = new PortfolioTrackingService(store as never, {} as never, {} as never);
    jest.spyOn(service, 'source').mockResolvedValue(source);
    return { service, tx };
  }
  it('rejects pending, rejected or cross-capability term ids before writing', async () => {
    const { service, tx } = fixture();
    tx.clientCapabilityTerm.findMany.mockResolvedValue([]);
    await expect(
      service.update(ctx as never, clientId, capabilityId, {
        itemKind: 'bill',
        itemId: 'fixture-bill',
        action: 'track',
        termIds: [termId],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.clientCapabilityTracking.upsert).not.toHaveBeenCalled();
    expect(tx.clientCapabilityTerm.findMany).toHaveBeenCalledWith({
      where: { tenantId: ctx.tenantId, clientId, capabilityId, id: { in: [termId] } },
    });
  });
  it('persists dismissal only for this capability and leaves client tracking untouched', async () => {
    const { service, tx } = fixture();
    await service.update(ctx as never, clientId, capabilityId, {
      itemKind: 'bill',
      itemId: 'fixture-bill',
      action: 'dismiss',
      termIds: [termId],
    });
    expect(tx.clientCapabilityTracking.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tenantId: ctx.tenantId,
          clientId,
          capabilityId,
          status: 'dismissed',
          termIds: [termId],
        }),
      }),
    );
  });
  it('requires explicit prior dismissal before restore', async () => {
    const { service, tx } = fixture();
    await expect(
      service.update(ctx as never, clientId, capabilityId, {
        itemKind: 'bill',
        itemId: 'fixture-bill',
        action: 'restore',
        termIds: [termId],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    tx.clientCapabilityTracking.findUnique.mockResolvedValue({
      status: 'dismissed',
      history: [{ action: 'dismiss' }],
    });
    await service.update(ctx as never, clientId, capabilityId, {
      itemKind: 'bill',
      itemId: 'fixture-bill',
      action: 'restore',
      termIds: [termId],
    });
    expect(tx.clientCapabilityTracking.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: 'active',
          history: [
            expect.objectContaining({ action: 'dismiss' }),
            expect.objectContaining({ action: 'restore' }),
          ],
        }),
      }),
    );
  });
});
