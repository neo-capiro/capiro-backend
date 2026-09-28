import { ResearchPortfolioChangesService } from './research-portfolio-changes.service.js';
const ctx: any = {
  tenantId: 'ed202609-2800-4000-8000-000000009000',
  userId: 'ed202609-2800-4000-8000-000000009001',
  role: 'standard_user',
};
const clientId = 'ed202609-2800-4000-8000-000000009002';
function harness() {
  const event: any = {
    id: 'event1',
    portfolioId: 'portfolio1',
    tenantId: ctx.tenantId,
    eventKind: 'client_linked',
    aggregateRevision: 8,
    actorUserId: ctx.userId,
    occurredAt: new Date(),
    payload: [{ targetId: clientId, targetType: 'client_link', status: 'created' }],
    recipientStates: [],
  };
  const tx: any = {
    researchPortfolio: {
      findFirst: jest
        .fn()
        .mockResolvedValue({
          id: 'portfolio1',
          revision: 8,
          grants: [{ role: 'viewer' }],
          clientLinks: [],
        }),
    },
    client: { findMany: jest.fn().mockResolvedValue([{ id: clientId }]) },
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ status: 'active' }) },
    researchPortfolioEvent: {
      findMany: jest.fn().mockResolvedValue([event]),
      findFirst: jest.fn().mockResolvedValue(event),
    },
    researchPortfolioSubscription: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          {
            id: 'subscription1',
            subscriberUserId: ctx.userId,
            targetKind: 'portfolio',
            targetId: 'portfolio1',
            channel: 'in_app',
            cadence: 'immediate',
            baselineRevision: 7,
            active: true,
          },
        ]),
    },
    researchPortfolioSubscriptionDelivery: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: clientId }]),
  };
  return {
    tx,
    event,
    service: new ResearchPortfolioChangesService({
      withTenant: async (_tenant: string, work: any) => work(tx),
    } as any),
  };
}

describe('Historical client wall and explicit delivery activation', () => {
  const originalFlag = process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED;
    else process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED = originalFlag;
  });
  it('withholds denied historical payload and delivery after the client link is removed', async () => {
    const h = harness();
    process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED = 'true';
    expect((await h.service.listChanges(ctx, 'portfolio1', null, 25)).items).toEqual([]);
    expect(h.tx.researchPortfolioSubscriptionDelivery.createMany).not.toHaveBeenCalled();
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FROM clients c'),
      ctx.tenantId,
      ctx.userId,
    );
  });
  it.each(['false', 'unset'])(
    'keeps manual changes readable but never creates delivery for flag %s',
    async (flag) => {
      const h = harness();
      h.tx.$queryRawUnsafe.mockResolvedValue([]);
      if (flag === 'unset') delete process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED;
      else process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED = flag;
      expect((await h.service.listChanges(ctx, 'portfolio1', null, 25)).items).toHaveLength(1);
      expect(h.tx.researchPortfolioSubscriptionDelivery.createMany).not.toHaveBeenCalled();
    },
  );
  it('keeps GET changes readonly even when the watch worker is explicitly enabled', async () => {
    const h = harness();
    h.tx.$queryRawUnsafe.mockResolvedValue([]);
    process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED = 'true';
    await h.service.listChanges(ctx, 'portfolio1', null, 25);
    expect(h.tx.researchPortfolioSubscriptionDelivery.createMany).not.toHaveBeenCalled();
  });
  it('does not deliver for revoked tenant membership even with a portfolio grant still present', async () => {
    const h = harness();
    h.tx.$queryRawUnsafe.mockResolvedValue([]);
    h.tx.tenantMembership.findFirst.mockResolvedValue(null);
    process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED = 'true';
    await h.service.listChanges(ctx, 'portfolio1', null, 25);
    expect(h.tx.researchPortfolioSubscriptionDelivery.createMany).not.toHaveBeenCalled();
  });
  it('masks historical delivery receipts and rejects state writes for a denied unlinked client', async () => {
    const h = harness();
    process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED = 'false';
    h.tx.researchPortfolioSubscriptionDelivery.findMany.mockResolvedValue([
      { event: { payload: h.event.payload } },
    ]);
    expect(await h.service.listDeliveries(ctx, 'portfolio1')).toEqual([]);
    await expect(
      h.service.updateEventState(ctx, 'portfolio1', h.event.id, { action: 'seen' }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('masks an own client-target subscription and prevents update after its portfolio client link is removed', async () => {
    const h = harness();
    h.tx.researchPortfolioSubscription.findMany.mockResolvedValue([
      { targetKind: 'client', targetId: clientId },
    ]);
    h.tx.researchPortfolioSubscription.findFirst = jest
      .fn()
      .mockResolvedValue({ id: 'sub-private', targetKind: 'client', targetId: clientId });
    expect(await h.service.listSubscriptions(ctx, 'portfolio1')).toEqual([]);
    await expect(
      h.service.updateSubscription(ctx, 'portfolio1', 'sub-private', { active: true }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

it('withholds delivery reads for revoked tenant membership despite a retained portfolio grant', async () => {
  const h = harness();
  h.tx.tenantMembership.findFirst.mockResolvedValue(null);
  expect(await h.service.listDeliveries(ctx, 'portfolio1')).toEqual([]);
  expect(h.tx.researchPortfolioSubscriptionDelivery.findMany).not.toHaveBeenCalled();
});
