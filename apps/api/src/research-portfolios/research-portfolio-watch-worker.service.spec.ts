import { ResearchPortfolioWatchWorkerService } from './research-portfolio-watch-worker.service.js';
const tenantId = 'ed202609-2800-4000-8000-000000009100',
  userId = 'ed202609-2800-4000-8000-000000009101',
  portfolioId = 'ed202609-2800-4000-8000-000000009102',
  clientId = 'ed202609-2800-4000-8000-000000009103';
const uuid = (n: number) => `ed202609-2800-4000-8000-${String(n).padStart(12, '0')}`;
function harness(cadence = 'immediate') {
  const rows: any[] = [
    {
      id: uuid(9104),
      tenantId,
      portfolioId,
      subscriberUserId: userId,
      targetKind: 'portfolio',
      targetId: portfolioId,
      channel: 'in_app',
      cadence,
      active: true,
      baselineRevision: 7,
      baselineCompletedAt: new Date('2026-09-28T00:00:00Z'),
      checkpoint: { quietFirstBaseline: true },
      leaseOwner: null,
      leaseUntil: null,
      leaseFence: 0,
    },
  ];
  const events: any[] = [
    {
      id: uuid(9110),
      tenantId,
      portfolioId,
      aggregateRevision: 7,
      occurredAt: new Date('2026-09-28T00:00:00Z'),
      payload: { baseline: true },
    },
    {
      id: uuid(9111),
      tenantId,
      portfolioId,
      aggregateRevision: 8,
      occurredAt: new Date('2026-09-28T00:01:00Z'),
      payload: { changed: 'public' },
    },
    {
      id: uuid(9112),
      tenantId,
      portfolioId,
      aggregateRevision: 9,
      occurredAt: new Date('2026-09-28T00:02:00Z'),
      payload: { clientId, private: 'retained-private-event' },
    },
    {
      id: uuid(9113),
      tenantId,
      portfolioId,
      aggregateRevision: 10,
      occurredAt: new Date('2026-10-28T00:01:00Z'),
      payload: { future: true },
    },
  ];
  const receipts: any[] = [],
    access: any = { member: true, grant: true, lifecycle: 'active' },
    failure: any = { insert: false, finish: false },
    now = new Date('2026-09-28T01:00:00Z');
  function matches(row: any, where: any) {
    return Object.entries(where).every(([key, value]: any) => {
      if (key === 'OR') return value.some((choice: any) => matches(row, choice));
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        if ('gt' in value) return row[key] > value.gt;
        if ('lte' in value) return row[key] <= value.lte;
        if ('in' in value) return value.in.includes(row[key]);
        return true;
      }
      return row[key] === value;
    });
  }
  const tx: any = {
    $queryRaw: jest.fn(async (sql: any) =>
      sql.strings.join('').includes('tenant_memberships')
        ? access.member
          ? [{ id: 'membership' }]
          : []
        : [{ id: 'lock' }],
    ),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: clientId }]),
    tenantMembership: {
      findFirst: jest.fn(async () =>
        access.member ? { id: 'membership', status: 'active' } : null,
      ),
    },
    researchPortfolio: {
      findFirst: jest.fn(async () =>
        access.grant
          ? {
              id: portfolioId,
              lifecycle: access.lifecycle,
              revision: 10,
              grants: [{ role: 'viewer' }],
              clientLinks: [],
            }
          : null,
      ),
    },
    researchPortfolioSubscription: {
      findMany: jest.fn(async ({ where, take }: any) =>
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, take)
          .map((r) => ({
            id: r.id,
            tenantId: r.tenantId,
            portfolioId: r.portfolioId,
            subscriberUserId: r.subscriberUserId,
          })),
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        const r = rows.find((r) => matches(r, where));
        return r ? structuredClone(r) : null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = rows.find((r) => matches(r, where));
        if (!r) return { count: 0 };
        if (failure.finish && data.leaseUntil === null && data.checkpoint) {
          failure.finish = false;
          return { count: 0 };
        }
        for (const [k, v] of Object.entries(data))
          r[k] =
            v && typeof v === 'object' && 'increment' in v
              ? r[k] + (v as any).increment
              : structuredClone(v);
        return { count: 1 };
      }),
    },
    researchPortfolioEvent: {
      findMany: jest.fn(async ({ where, take }: any) =>
        events
          .filter(
            (e) => e.occurredAt <= where.occurredAt.lte && where.OR.some((r: any) => matches(e, r)),
          )
          .sort((a, b) => a.aggregateRevision - b.aggregateRevision || a.id.localeCompare(b.id))
          .slice(0, take),
      ),
    },
    researchPortfolioSubscriptionDelivery: {
      findMany: jest.fn(async ({ where }: any) => receipts.filter((r) => matches(r, where))),
      createMany: jest.fn(async ({ data }: any) => {
        if (failure.insert)
          throw Object.assign(new Error('Actual insert analogue'), { code: '23514' });
        let count = 0;
        for (const r of data)
          if (
            !receipts.some(
              (x) =>
                x.subscriptionId === r.subscriptionId &&
                x.eventId === r.eventId &&
                x.recipientUserId === r.recipientUserId &&
                x.channel === r.channel,
            )
          ) {
            receipts.push({ ...structuredClone(r), id: uuid(9200 + receipts.length) });
            count++;
          }
        return { count };
      }),
    },
    researchPortfolioEventRecipientState: { update: jest.fn(), create: jest.fn() },
  };
  const transaction = async (_tenant: string, ...args: any[]) => {
    const work = args.at(-1),
      beforeRows = structuredClone(rows),
      beforeReceipts = structuredClone(receipts);
    try {
      return await work(tx);
    } catch (e) {
      rows.splice(0, rows.length, ...beforeRows);
      receipts.splice(0, receipts.length, ...beforeReceipts);
      throw e;
    }
  };
  const prisma: any = {
    tenant: {
      findFirst: jest.fn().mockResolvedValue({ id: tenantId }),
      findMany: jest.fn().mockResolvedValue([{ id: tenantId }]),
    },
    withTenant: transaction,
    withTenantUser: transaction,
  };
  return {
    rows,
    events,
    receipts,
    access,
    failure,
    tx,
    prisma,
    now,
    worker: new ResearchPortfolioWatchWorkerService(prisma),
    identity: { id: rows[0].id, tenantId, portfolioId, subscriberUserId: userId },
  };
}
describe('Dormant fenced Research Portfolio watch worker', () => {
  const original = process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED;
  beforeEach(() => {
    process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED = 'true';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED;
    else process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED = original;
  });
  it.each(['false', 'unset'])(
    'does no discovery, timer, claim or payload read for flag %s',
    async (flag) => {
      const h = harness();
      if (flag === 'unset') delete process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED;
      else process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED = flag;
      h.worker.onModuleInit();
      await h.worker.tick(h.now);
      await h.worker.runTenant(tenantId, h.now);
      expect(h.prisma.tenant.findMany).not.toHaveBeenCalled();
      expect(h.tx.researchPortfolioSubscription.findMany).not.toHaveBeenCalled();
      expect(h.tx.researchPortfolioEvent.findMany).not.toHaveBeenCalled();
      expect((h.worker as any).timer).toBeUndefined();
    },
  );
  it('claims durably, emits post-baseline own in-app receipts and withheld private receipts, advances cursor atomically, and never alters recipient state', async () => {
    const h = harness();
    expect(await h.worker.runTenant(tenantId, h.now)).toMatchObject({ completed: 1, unknown: 0 });
    expect(h.receipts.map((r) => r.status)).toEqual(['delivered', 'withheld']);
    expect(h.receipts.every((r) => r.recipientUserId === userId)).toBe(true);
    expect(JSON.stringify(h.receipts)).not.toContain('retained-private-event');
    expect(h.rows[0].checkpoint.watchDelivery.cursorRevision).toBe(9);
    expect(h.rows[0].leaseFence).toBe(1);
    expect(h.rows[0].leaseOwner).toBeNull();
    expect(h.tx.researchPortfolioEventRecipientState.update).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioEventRecipientState.create).not.toHaveBeenCalled();
    await h.worker.runTenant(tenantId, h.now);
    expect(h.receipts).toHaveLength(2);
    expect(h.tx.researchPortfolioSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, tenantId: true, portfolioId: true, subscriberUserId: true },
        take: 100,
      }),
    );
  });
  it.each(['daily', 'weekly'])(
    'enforces actual %s due time before reading events and records a cadence receipt only when due',
    async (cadence) => {
      const h = harness(cadence);
      await h.worker.runTenant(tenantId, h.now);
      expect(h.tx.researchPortfolioEvent.findMany).not.toHaveBeenCalled();
      expect(h.receipts).toHaveLength(0);
      const due = new Date(h.now.getTime() + (cadence === 'daily' ? 86400000 : 604800000));
      await h.worker.runTenant(tenantId, due);
      expect(h.receipts).toHaveLength(2);
      expect(h.receipts[0].checkpoint.cadence).toBe(cadence);
      const before = h.tx.researchPortfolioEvent.findMany.mock.calls.length;
      await h.worker.runTenant(tenantId, due);
      expect(h.tx.researchPortfolioEvent.findMany).toHaveBeenCalledTimes(before);
    },
  );
  it('reports email as explicit partial without external sends', async () => {
    const h = harness();
    h.rows[0].channel = 'email';
    await h.worker.runTenant(tenantId, h.now);
    expect(h.receipts[0]).toMatchObject({
      status: 'partial',
      errorCode: 'email_delivery_not_configured',
      receipt: { configured: false },
    });
  });
  it.each(['member', 'grant', 'archive'])(
    'withholds %s revocation before subscription checkpoint or event payload reads',
    async (kind) => {
      const h = harness();
      if (kind === 'archive') h.access.lifecycle = 'archived';
      else h.access[kind] = false;
      expect(await h.worker.runTenant(tenantId, h.now)).toMatchObject({ withheld: 1 });
      expect(h.tx.researchPortfolioSubscription.findFirst).not.toHaveBeenCalled();
      expect(h.tx.researchPortfolioEvent.findMany).not.toHaveBeenCalled();
      expect(h.receipts).toHaveLength(0);
    },
  );
  it('honors a disabled flag between durable claim and processing without payload reads', async () => {
    const h = harness(),
      claim = await (h.worker as any).claim(h.identity, h.now);
    process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED = 'false';
    expect(await (h.worker as any).processClaim(claim, h.now)).toBe('withheld');
    expect(h.tx.researchPortfolioEvent.findMany).not.toHaveBeenCalled();
    expect(h.rows[0].leaseOwner).toBeNull();
  });
  it('rechecks active membership after the durable claim and releases the lease without event reads', async () => {
    const h = harness(),
      claim = await (h.worker as any).claim(h.identity, h.now);
    expect(claim).toBeTruthy();
    h.access.member = false;
    expect(await (h.worker as any).processClaim(claim, h.now)).toBe('withheld');
    expect(h.tx.researchPortfolioEvent.findMany).not.toHaveBeenCalled();
    expect(h.rows[0].leaseOwner).toBeNull();
  });
  it('recovers an expired crashed lease with a new fence; the old owner cannot write or advance', async () => {
    const h = harness(),
      old = await (h.worker as any).claim(h.identity, h.now),
      next = new ResearchPortfolioWatchWorkerService(h.prisma),
      later = new Date(h.now.getTime() + 61000),
      claim = await (next as any).claim(h.identity, later);
    expect(claim.fence).toBe(old.fence + 1);
    await expect((h.worker as any).processClaim(old, later)).rejects.toThrow('fence lost');
    expect(h.receipts).toHaveLength(0);
    expect(h.rows[0].leaseFence).toBe(claim.fence);
    await (next as any).processClaim(claim, later);
    expect(h.receipts).toHaveLength(2);
  });
  it('rolls back final receipts and cursor on processing SQL failure and recovers the identical event once', async () => {
    const h = harness();
    h.failure.insert = true;
    expect(await h.worker.runTenant(tenantId, h.now)).toMatchObject({ unknown: 1, completed: 0 });
    expect(h.receipts).toHaveLength(0);
    expect(h.rows[0].checkpoint.watchDelivery.cursorRevision).toBe(7);
    expect(h.rows[0].checkpoint.watchDelivery.lastErrorCode).toBe('23514');
    h.failure.insert = false;
    await h.worker.runTenant(tenantId, new Date(h.now.getTime() + 61000));
    expect(h.receipts).toHaveLength(2);
    expect(h.rows[0].checkpoint.watchDelivery.cursorRevision).toBe(9);
  });
  it('rolls back successful inserts when completion CAS loses its fence', async () => {
    const h = harness();
    h.failure.finish = true;
    expect(await h.worker.runTenant(tenantId, h.now)).toMatchObject({ unknown: 1 });
    expect(h.receipts).toHaveLength(0);
    expect(h.rows[0].checkpoint.watchDelivery.cursorRevision).toBe(7);
  });
  it('fails closed on immutable queued/unknown prior receipts with an explicit blocked checkpoint instead of silently claiming success', async () => {
    const h = harness();
    h.receipts.push({
      id: uuid(9300),
      tenantId,
      subscriptionId: h.rows[0].id,
      recipientUserId: userId,
      channel: 'in_app',
      eventId: h.events[1].id,
      status: 'queued',
    });
    expect(await h.worker.runTenant(tenantId, h.now)).toMatchObject({ blocked: 1, completed: 0 });
    expect(h.receipts).toHaveLength(1);
    expect(h.rows[0].checkpoint.watchDelivery).toMatchObject({
      cursorRevision: 7,
      lastErrorCode: 'immutable_delivery_needs_reconciliation',
      blockedDeliveryIds: [uuid(9300)],
    });
  });
  it('rotates bounded subscription batches fairly beyond the first100 and resets cursor after the tail', async () => {
    const h = harness('weekly'),
      originalRow = h.rows[0];
    h.rows.splice(
      0,
      1,
      ...Array.from({ length: 205 }, (_, i) => ({
        ...structuredClone(originalRow),
        id: uuid(9400 + i),
      })),
    );
    expect((await h.worker.runTenant(tenantId, h.now)).inspected).toBe(100);
    expect((await h.worker.runTenant(tenantId, h.now)).inspected).toBe(100);
    expect((await h.worker.runTenant(tenantId, h.now)).inspected).toBe(5);
    expect((await h.worker.runTenant(tenantId, h.now)).inspected).toBe(100);
    expect(h.tx.researchPortfolioEvent.findMany).not.toHaveBeenCalled();
  });
});
