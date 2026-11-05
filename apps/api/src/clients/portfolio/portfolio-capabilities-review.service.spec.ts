import { BadRequestException, ConflictException } from '@nestjs/common';
import { PortfolioCapabilitiesReviewService } from './portfolio-capabilities-review.service.js';
import { PortfolioProposalStore } from './portfolio-proposal.store.js';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  clerkUserId: 'fixture',
  tenantSlug: 'fixture',
  role: 'user_admin',
} as const;
const clientId = '30000000-0000-4000-8000-000000000003';
const capabilityId = '40000000-0000-4000-8000-000000000004';
const id = '50000000-0000-4000-8000-000000000005';
const evidence = [
  {
    url: 'https://example.gov/fixture',
    title: 'Synthetic fixture',
    excerpt: 'This is test evidence without a real member attribution.',
    observedAt: '2026-01-01T00:00:00.000Z',
    sourceType: 'official',
  },
];
function fixture(type = 'keyword', status = 'proposed', score = 90) {
  const row = {
    id,
    tenantId: ctx.tenantId,
    clientId,
    capabilityId,
    kind: 'alignment',
    payload: {
      targetType: type,
      value:
        type === 'pe'
          ? '0600000A'
          : type === 'naics'
            ? '541330'
            : type === 'psc'
              ? 'R425'
              : 'fixture sensor',
      rationale: 'Test evidence',
      score,
    },
    evidence,
    version: 1,
    status,
    reviewHistory: [],
  };
  const tx = {
    clientPortfolioProposal: {
      findFirst: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    clientCapability: {
      findFirst: jest.fn().mockResolvedValue({ id: capabilityId }),
      findFirstOrThrow: jest
        .fn()
        .mockResolvedValue({ id: capabilityId, keywords: [], peNumbers: [] }),
      update: jest.fn(),
    },
    clientCapabilityTerm: { upsert: jest.fn().mockResolvedValue({ id: 'term' }) },
    clientCapabilityFitRecommendation: { deleteMany: jest.fn() },
  };
  const store = new PortfolioProposalStore({} as never);
  jest
    .spyOn(store, 'withClient')
    .mockImplementation(async (_ctx, _client, _write, work) => work(tx as never));
  const capabilities = {
    createCapabilityInTransaction: jest.fn(),
    afterCapabilityCreated: jest.fn(),
  };
  const fit = { getFit: jest.fn().mockResolvedValue({ status: 'ready' }) };
  const service = new PortfolioCapabilitiesReviewService(
    store,
    capabilities as never,
    fit as never,
  );
  return { service, store, tx, row, fit };
}
describe('capability alignment approval', () => {
  it('does not activate pending or rejected terms', async () => {
    const { service, tx } = fixture();
    await service.review(ctx, clientId, id, { expectedVersion: 1, action: 'reject' }, capabilityId);
    expect(tx.clientCapabilityTerm.upsert).not.toHaveBeenCalled();
    expect(tx.clientCapability.update).not.toHaveBeenCalled();
  });
  it('approves a PE individually and retains evidence/actor/date before refreshing the canonical fit', async () => {
    const { service, tx, fit } = fixture('pe');
    const result = await service.review(
      ctx,
      clientId,
      id,
      { expectedVersion: 1, action: 'approve' },
      capabilityId,
    );
    expect(tx.clientCapabilityTerm.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: 'pe',
          value: '0600000a',
          evidence,
          approvedByUserId: ctx.userId,
          approvedAt: expect.any(Date),
        }),
      }),
    );
    expect(tx.clientCapability.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ peNumbers: ['0600000A'] }) }),
    );
    expect(fit.getFit).toHaveBeenCalledWith(ctx, clientId, { refresh: true });
    expect(result).toMatchObject({ status: 'approved', trackingRefresh: 'ready' });
  });
  it.each(['naics', 'psc'])('%s approval never creates watch terms', async (type) => {
    const { service, tx } = fixture(type);
    await service.review(
      ctx,
      clientId,
      id,
      { expectedVersion: 1, action: 'approve' },
      capabilityId,
    );
    expect(tx.clientCapabilityTerm.upsert).not.toHaveBeenCalled();
    expect(tx.clientCapability.update).not.toHaveBeenCalled();
  });
  it.each(['pe', 'program', 'naics', 'psc'])(
    'rejects %s bulk approval even with a high score',
    async (type) => {
      const { service, tx } = fixture(type, 'proposed', 100);
      await expect(
        service.bulkApprove(ctx, clientId, capabilityId, { items: [{ id, expectedVersion: 1 }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.clientCapabilityTerm.upsert).not.toHaveBeenCalled();
    },
  );
  it('does not treat 85 as above the bulk threshold', async () => {
    const { service, tx } = fixture('tag', 'proposed', 85);
    await expect(
      service.bulkApprove(ctx, clientId, capabilityId, { items: [{ id, expectedVersion: 1 }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.clientCapabilityTerm.upsert).not.toHaveBeenCalled();
  });
  it('remembers a rejection until explicit restore, without activating it on restore', async () => {
    const { service, tx } = fixture('keyword', 'rejected');
    await expect(
      service.review(ctx, clientId, id, { expectedVersion: 1, action: 'approve' }, capabilityId),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.review(ctx, clientId, id, { expectedVersion: 1, action: 'restore' }, capabilityId),
    ).resolves.toMatchObject({ status: 'proposed' });
    expect(tx.clientCapabilityTerm.upsert).not.toHaveBeenCalled();
  });
  it('reports source refresh failure without undoing a human approval', async () => {
    const { service, fit, tx } = fixture();
    fit.getFit.mockRejectedValue(new Error('fixture source unavailable'));
    await expect(
      service.review(ctx, clientId, id, { expectedVersion: 1, action: 'approve' }, capabilityId),
    ).resolves.toMatchObject({ status: 'approved', trackingRefresh: 'unavailable' });
    expect(tx.clientCapabilityTerm.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('sourced updates of an existing capability', () => {
  function updateFixture(version = 4) {
    const input = {
      kind: 'capability',
      capabilityId,
      payload: {
        name: 'Fixture vessel',
        type: 'platform',
        lifecycle: 'in_service',
        description: 'Reviewed description',
        tags: ['vessel'],
        classification: 'capability',
        expectedCapabilityVersion: 4,
      },
      evidence,
    };
    const tx = {
      clientCapability: { findFirst: jest.fn().mockResolvedValue({ id: capabilityId, version }) },
    };
    let committed = false;
    const store = {
      withClient: jest.fn(async (_ctx, _id, _write, work) => {
        const result = await work(tx);
        committed = true;
        return result;
      }),
      requireProposal: jest.fn().mockResolvedValue({ id, kind: 'capability', capabilityId }),
      review: jest.fn(async (_tx, _ctx, _row, _command, apply) => {
        await apply(input);
        return { id, status: 'approved' };
      }),
    };
    const capabilities = {
      updateCapabilityInTransaction: jest.fn().mockResolvedValue({ id: capabilityId }),
      createCapabilityInTransaction: jest.fn(),
      afterCapabilityCreated: jest.fn(() => {
        expect(committed).toBe(true);
      }),
    };
    return {
      service: new PortfolioCapabilitiesReviewService(
        store as never,
        capabilities as never,
        {} as never,
      ),
      capabilities,
    };
  }
  it('uses canonical update and normal embedding only after review transaction commits', async () => {
    const h = updateFixture();
    await h.service.review(ctx, clientId, id, { expectedVersion: 1, action: 'approve' });
    expect(h.capabilities.updateCapabilityInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      clientId,
      capabilityId,
      expect.objectContaining({ description: 'Reviewed description' }),
      expect.arrayContaining([
        expect.objectContaining({ origin: 'research_reviewed', proposalId: id }),
      ]),
    );
    expect(h.capabilities.createCapabilityInTransaction).not.toHaveBeenCalled();
    expect(h.capabilities.afterCapabilityCreated).toHaveBeenCalledTimes(1);
  });
  it('keeps an edited canonical capability intact when a research update is stale', async () => {
    const h = updateFixture(5);
    await expect(
      h.service.review(ctx, clientId, id, { expectedVersion: 1, action: 'approve' }),
    ).rejects.toThrow('Capability changed');
    expect(h.capabilities.updateCapabilityInTransaction).not.toHaveBeenCalled();
    expect(h.capabilities.afterCapabilityCreated).not.toHaveBeenCalled();
  });
});
