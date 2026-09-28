import type { TenantContext } from '@capiro/shared';
import { ResearchPortfolioReviewService } from './research-portfolio-review.service.js';

const ctx: TenantContext = {
  tenantId: 'tenant-1',
  tenantSlug: 'tenant',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
};

const portfolio = {
  id: 'portfolio-1',
  tenantId: ctx.tenantId,
  lifecycle: 'active',
  revision: 7,
};

const review = {
  id: 'review-1',
  tenantId: ctx.tenantId,
  portfolioId: portfolio.id,
  targetKind: 'program',
  targetId: 'program-1',
  trigger: 'manual',
  triggerIdentity: 'manual-1',
  dependencyIdentity: null,
  assigneeUserId: ctx.userId,
  reason: 'Needs review',
  evidenceFor: [],
  evidenceAgainst: [],
  revision: 2,
  triggerFingerprint: 'a'.repeat(64),
  status: 'open',
  createdAt: new Date('2028-09-30T00:00:00Z'),
  updatedAt: new Date('2028-09-30T00:00:00Z'),
  resolvedAt: null,
};

const grant = { id: 'grant-1', role: 'editor' };

function txHarness(overrides: Record<string, unknown> = {}) {
  return {
    researchPortfolioGrant: {
      findUnique: jest.fn().mockResolvedValue(grant),
    },
    researchPortfolio: {
      findUnique: jest.fn().mockResolvedValue(portfolio),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    researchPortfolioReview: {
      findMany: jest.fn().mockResolvedValue([review]),
      findUnique: jest.fn().mockResolvedValue(review),
      update: jest.fn().mockResolvedValue({ ...review, revision: 3 }),
      create: jest.fn().mockResolvedValue({ ...review, id: 'review-created', revision: 1 }),
    },
    researchPortfolioDecision: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'decision-1' }),
    },
    programIdentityCrosswalk: { findMany: jest.fn().mockResolvedValue([]) },
    researchPortfolioContinuityLedger: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    tenantMembership: {
      findFirst: jest.fn().mockResolvedValue({ id: 'membership-1', status: 'active' }),
    },
    researchPortfolioEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ occurredAt: new Date('2028-09-30T01:00:00Z') }),
    },
    ...overrides,
  } as any;
}

function serviceWith(tx: any) {
  return new ResearchPortfolioReviewService({
    withTenant: jest.fn((_tenantId: string, action: (client: unknown) => unknown) => action(tx)),
  } as any);
}

describe('ResearchPortfolioReviewService', () => {
  it('allows archived read lanes and includes unassigned work in Team', async () => {
    const tx = txHarness({
      researchPortfolio: {
        findUnique: jest.fn().mockResolvedValue({ ...portfolio, lifecycle: 'archived' }),
        updateMany: jest.fn(),
      },
    });

    const result = await serviceWith(tx).listReviews(ctx, portfolio.id, 'team');

    expect(result).toHaveLength(1);
    expect(tx.researchPortfolioReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ assigneeUserId: null }, { assigneeUserId: { not: ctx.userId } }],
        }),
      }),
    );
  });

  it('keeps viewers read-only', async () => {
    const tx = txHarness({
      researchPortfolioGrant: {
        findUnique: jest.fn().mockResolvedValue({ ...grant, role: 'viewer' }),
      },
    });

    await expect(
      serviceWith(tx).assignReview(ctx, portfolio.id, review.id, {
        idempotencyKey: 'assign-viewer',
        expectedRevision: 2,
        expectedPortfolioRevision: 7,
        assigneeUserId: 'user-2',
        reason: 'Assign to an analyst',
      }),
    ).rejects.toThrow('Required role: editor');
  });

  it('assigns only an active tenant member under review and portfolio revisions', async () => {
    const tx = txHarness();

    const result = await serviceWith(tx).assignReview(ctx, portfolio.id, review.id, {
      idempotencyKey: 'assign-1',
      expectedRevision: 2,
      expectedPortfolioRevision: 7,
      assigneeUserId: 'user-2',
      reason: 'Assign to an analyst',
    });

    expect(tx.tenantMembership.findFirst).toHaveBeenCalledWith({
      where: { tenantId: ctx.tenantId, userId: 'user-2', status: 'active' },
    });
    expect(tx.researchPortfolio.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revision: 7 }),
      }),
    );
    expect(result.outcomes[0]).toMatchObject({ status: 'assigned', revision: 3 });
  });

  it('records a dispute as an append-only evidenced decision and leaves the review open', async () => {
    const tx = txHarness();
    const evidence = [
      {
        sourceRevisionId: 'source-1',
        locator: { page: 3 },
        quote: 'Counter evidence',
        stance: 'against' as const,
      },
    ];

    const result = await serviceWith(tx).decideReview(ctx, portfolio.id, review.id, {
      idempotencyKey: 'dispute-1',
      expectedRevision: 2,
      expectedPortfolioRevision: 7,
      decisionType: 'dispute',
      reason: 'The evidence conflicts',
      evidenceAgainst: evidence,
    });

    expect(tx.researchPortfolioDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decisionType: 'dispute',
        evidenceAgainst: evidence,
        priorDecisionId: null,
        supersedesId: null,
      }),
    });
    expect(tx.researchPortfolioReview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'open', revision: { increment: 1 } }),
      }),
    );
    expect(result.outcomes[0]?.decisionId).toBe('decision-1');
  });

  it('rejects an idempotency key reused for a different operation', async () => {
    const tx = txHarness({
      researchPortfolioEvent: {
        findFirst: jest.fn().mockResolvedValue({
          payloadFingerprint: 'different',
          payload: [],
          portfolioId: portfolio.id,
          actorUserId: ctx.userId,
          occurredAt: new Date(),
        }),
        create: jest.fn(),
      },
    });

    await expect(
      serviceWith(tx).assignReview(ctx, portfolio.id, review.id, {
        idempotencyKey: 'reused',
        expectedRevision: 2,
        expectedPortfolioRevision: 7,
        assigneeUserId: null,
        reason: 'Unassign',
      }),
    ).rejects.toThrow('Idempotency key was already used for a different operation');
  });

  it('returns a conflict for every stale bulk item without writing decisions', async () => {
    const tx = txHarness({
      researchPortfolioReview: {
        findMany: jest.fn().mockResolvedValue([review, { ...review, id: 'review-2', revision: 4 }]),
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
    });

    const result = await serviceWith(tx).bulkDecideReviews(ctx, portfolio.id, {
      idempotencyKey: 'bulk-stale',
      expectedRevision: 7,
      items: [
        { reviewId: review.id, expectedRevision: 1, decisionType: 'defer', reason: 'Wait' },
        { reviewId: 'review-2', expectedRevision: 3, decisionType: 'defer', reason: 'Wait' },
      ],
    });

    expect(result.outcomes.map((item) => item.status)).toEqual(['conflict', 'conflict']);
    expect(tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
    expect(tx.researchPortfolio.updateMany).not.toHaveBeenCalled();
  });

  it('returns zeroed annual counts when no continuity history exists', async () => {
    const result = await serviceWith(txHarness()).getAnnualReview(ctx, portfolio.id);

    expect(result.items).toEqual([]);
    expect(Object.values(result.counts)).toEqual(Array(9).fill(0));
  });

  it('reopens only materially changed continuity once and skips unchanged items', async () => {
    const changed = {
      id: 'continuity-changed',
      tenantId: ctx.tenantId,
      portfolioId: portfolio.id,
      priorDecisionId: null,
      currentDecisionId: null,
      continuityKey: 'b'.repeat(64),
      priorDependencyFingerprint: 'c'.repeat(64),
      dependencyFingerprint: 'd'.repeat(64),
      status: 'changed',
    };
    const unchanged = {
      ...changed,
      id: 'continuity-unchanged',
      status: 'unchanged',
      continuityKey: 'e'.repeat(64),
    };
    const tx = txHarness({
      researchPortfolioContinuityLedger: {
        findMany: jest.fn().mockResolvedValue([changed, unchanged]),
        update: jest.fn().mockResolvedValue({}),
      },
      researchPortfolioReview: {
        findMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        create: jest.fn().mockResolvedValue({ ...review, id: 'annual-review-1', revision: 1 }),
      },
    });

    const result = await serviceWith(tx).reopenAnnualReview(ctx, portfolio.id, {
      idempotencyKey: 'annual-1',
      expectedRevision: 7,
      continuityIds: [changed.id, unchanged.id],
      reason: 'Annual evidence changed',
    });

    expect(tx.researchPortfolioReview.create).toHaveBeenCalledTimes(1);
    expect(result.outcomes.map((item) => item.status)).toEqual(['assigned', 'unchanged']);
    expect(tx.researchPortfolioEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventKind: 'annual_reopened' }),
    });
  });
});

describe('Research portfolio durable review receipt replay', () => {
  async function committed(kind: 'assign' | 'decide', priorDecisionId: string | null = null) {
    const tx = txHarness();
    const service = serviceWith(tx);
    const input: any = {
      idempotencyKey: 'receipt-' + kind,
      expectedRevision: 2,
      expectedPortfolioRevision: 7,
      reason: 'Reviewed reason',
      ...(kind === 'assign'
        ? { assigneeUserId: null }
        : {
            decisionType: 'include',
            priorDecisionId,
            evidenceFor: [
              {
                sourceRevisionId: 'source-1',
                locator: { page: 1 },
                quote: 'Evidence',
                stance: 'for',
              },
            ],
          }),
    };
    if (priorDecisionId)
      tx.researchPortfolioDecision.findFirst.mockResolvedValue({ id: priorDecisionId });
    const action = (actor = ctx, request = input, destination = portfolio.id) =>
      kind === 'assign'
        ? service.assignReview(actor, destination, review.id, request)
        : service.decideReview(actor, destination, review.id, request);
    const receipt = await action();
    const eventData = tx.researchPortfolioEvent.create.mock.calls[0][0].data;
    tx.researchPortfolioEvent.findFirst.mockResolvedValue({
      ...eventData,
      occurredAt: new Date('2028-09-30T01:00:00Z'),
    });
    tx.researchPortfolioReview.findUnique.mockResolvedValue({
      ...review,
      revision: 30,
      status: 'resolved',
    });
    tx.researchPortfolio.findUnique.mockResolvedValue({
      ...portfolio,
      revision: 40,
      lifecycle: 'archived',
    });
    tx.researchPortfolioDecision.findFirst.mockResolvedValue({
      id: 'later-decision',
      priorDecisionId: 'different-lineage',
    });
    tx.researchPortfolioReview.update.mockClear();
    tx.researchPortfolioDecision.create.mockClear();
    tx.researchPortfolioEvent.create.mockClear();
    tx.researchPortfolio.updateMany.mockClear();
    return { tx, input, receipt, action };
  }
  it.each(['assign', 'decide'] as const)(
    'replays %s after status, revision, archive and decision lineage drift',
    async (kind) => {
      const { tx, receipt, action } = await committed(
        kind,
        kind === 'decide' ? 'original-prior' : null,
      );
      await expect(action()).resolves.toEqual(receipt);
      expect(tx.researchPortfolioReview.update).not.toHaveBeenCalled();
      expect(tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
      expect(tx.researchPortfolioEvent.create).not.toHaveBeenCalled();
      expect(tx.researchPortfolio.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each(['assign', 'decide'] as const)(
    'binds %s receipt to actor, portfolio and original content',
    async (kind) => {
      const { action, input } = await committed(kind);
      await expect(action({ ...ctx, userId: 'different-actor' })).rejects.toThrow(
        'another actor or portfolio',
      );
      await expect(action(ctx, input, 'different-portfolio')).rejects.toThrow(
        'another actor or portfolio',
      );
      await expect(action(ctx, { ...input, reason: 'Changed payload' })).rejects.toThrow(
        'different operation',
      );
    },
  );
  it.each(['assign', 'decide'] as const)(
    'reauthorizes %s before returning a committed receipt',
    async (kind) => {
      const { tx, action } = await committed(kind);
      tx.researchPortfolioGrant.findUnique.mockResolvedValue(null);
      await expect(action()).rejects.toThrow('do not have access');
      tx.researchPortfolioGrant.findUnique.mockResolvedValue({ ...grant, role: 'viewer' });
      await expect(action()).rejects.toThrow('Required role: editor');
    },
  );
  it('keeps a fresh archived mutation blocked', async () => {
    const { tx, input, action } = await committed('assign');
    tx.researchPortfolioEvent.findFirst.mockResolvedValue(null);
    await expect(action(ctx, { ...input, idempotencyKey: 'fresh-archived' })).rejects.toThrow(
      'archived',
    );
  });
  it('replays an existing omitted-prior decision receipt against its immutable original lineage', async () => {
    const tx = txHarness();
    // Captured from the actual pre-repair decideReview service call; no mirrored hash implementation.
    tx.researchPortfolioEvent.findFirst.mockResolvedValue({
      portfolioId: portfolio.id,
      actorUserId: ctx.userId,
      occurredAt: new Date('2028-09-30T01:00:00Z'),
      payloadFingerprint: 'e0657b6bbd88b3339d9f30f88c6166b0ef125f1f96d27a388ac8f52476cdbee2',
      payload: [
        {
          reviewId: review.id,
          status: 'decided',
          revision: 3,
          decisionId: 'decision-1',
          message: null,
        },
      ],
    });
    tx.researchPortfolio.findUnique.mockResolvedValue({
      ...portfolio,
      lifecycle: 'archived',
      revision: 40,
    });
    tx.researchPortfolioReview.findUnique.mockResolvedValue({
      ...review,
      revision: 30,
      status: 'resolved',
    });
    tx.researchPortfolioDecision.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === 'decision-1'
        ? { id: 'decision-1', priorDecisionId: 'original-prior' }
        : { id: 'unrelated-latest' },
    );
    const input = {
      idempotencyKey: 'legacy-defer',
      expectedRevision: 2,
      expectedPortfolioRevision: 7,
      decisionType: 'defer' as const,
      reason: 'Wait for immutable lineage',
    };
    const result = await serviceWith(tx).decideReview(ctx, portfolio.id, review.id, input);
    expect(result.outcomes[0]).toMatchObject({ decisionId: 'decision-1', revision: 3 });
    expect(tx.researchPortfolioDecision.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'decision-1',
        tenantId: ctx.tenantId,
        portfolioId: portfolio.id,
        reviewId: review.id,
      },
    });
    expect(tx.researchPortfolioReview.findUnique).not.toHaveBeenCalled();
    expect(tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
  });
});

describe('Annual continuity captured basis and current readonly projections', () => {
  function harness() {
    const currentPortfolio: any = { ...portfolio };
    const currentReview: any = { ...review, targetKind: 'program_element', targetId: '0604115A' };
    const decisions: any[] = [];
    const ledgers: any[] = [];
    const events = new Map<string, any>();
    const mapping: any = {
      id: 'mapping-1',
      programId: '00000000-0000-4000-8000-000000000001',
      program: {
        id: '00000000-0000-4000-8000-000000000001',
        canonicalName: 'Canonical Program',
        status: 'active',
      },
      identityKind: 'pe',
      sourceSystem: 'dod',
      sourceIdentifier: '0604115A',
      relationshipKind: 'identity',
      validFromFy: 2020,
      validToFy: null,
      recordedAt: new Date('2026-01-01T00:00:00Z'),
      supersedesId: null,
      sourceDocumentId: 'immutable-source',
      sourceDocument: {
        id: 'immutable-source',
        sha256: 'a'.repeat(64),
        fiscalYear: 2026,
        ingestedAt: new Date('2026-01-01T00:00:00Z'),
        sourceUrl: 'https://example.test/r2',
      },
      source: 'R2',
      sourceUrl: 'https://example.test/r2',
      evidence: { locator: { page: 3 } },
      confidence: 0.9,
      reviewStatus: 'accepted',
    };
    const mappings: any[] = [mapping];
    const tx: any = txHarness();
    tx.researchPortfolio.findUnique.mockImplementation(async () => currentPortfolio);
    tx.researchPortfolio.updateMany.mockImplementation(async ({ where }: any) => {
      if (where.revision !== currentPortfolio.revision) return { count: 0 };
      currentPortfolio.revision++;
      return { count: 1 };
    });
    tx.researchPortfolioReview.findUnique.mockImplementation(async ({ where }: any) =>
      where.id ? currentReview : null,
    );
    tx.researchPortfolioReview.update.mockImplementation(async ({ data }: any) => {
      currentReview.status = data.status;
      currentReview.revision++;
      return { ...currentReview };
    });
    tx.researchPortfolioDecision.create.mockImplementation(async ({ data }: any) => {
      const decision = {
        ...data,
        id: `decision-${decisions.length + 1}`,
        decisionTime: new Date(),
        createdAt: new Date(),
      };
      decisions.push(decision);
      return decision;
    });
    tx.researchPortfolioDecision.findFirst.mockImplementation(async () => decisions.at(-1) ?? null);
    tx.researchPortfolioDecision.findMany.mockImplementation(async ({ where }: any) =>
      decisions
        .filter((decision) => !where.id || where.id.in.includes(decision.id))
        .slice()
        .reverse(),
    );
    tx.researchPortfolioContinuityLedger.findMany.mockImplementation(async ({ where }: any) =>
      ledgers.filter(
        (ledger) =>
          (!where.id || where.id.in.includes(ledger.id)) &&
          (!where.currentDecisionId ||
            where.currentDecisionId.in.includes(ledger.currentDecisionId)),
      ),
    );
    tx.researchPortfolioContinuityLedger.create.mockImplementation(async ({ data }: any) => {
      const row = {
        ...JSON.parse(JSON.stringify(data)),
        id: data.id ?? `ledger-${ledgers.length + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      ledgers.push(row);
      return row;
    });
    tx.researchPortfolioContinuityLedger.update.mockImplementation(async ({ where, data }: any) => {
      const row = ledgers.find((item) => item.id === where.id);
      Object.assign(row, JSON.parse(JSON.stringify(data)), { updatedAt: new Date() });
      return row;
    });
    tx.researchPortfolioEvent.findFirst.mockImplementation(
      async ({ where }: any) => events.get(where.idempotencyKey) ?? null,
    );
    tx.researchPortfolioEvent.create.mockImplementation(async ({ data }: any) => {
      const event = { ...data, occurredAt: new Date() };
      events.set(data.idempotencyKey, event);
      return event;
    });
    tx.programElement = {
      findUnique: jest.fn(async ({ where }: any) => ({
        peCode: where.peCode,
        title: 'Canonical PE',
        service: 'Army',
        sourceConfidence: 1,
        raw: {},
        sources: [
          {
            id: 'pe-source',
            sourceDocumentId: 'immutable-source',
            confidence: 0.9,
            pageNumber: 3,
            fy: 2026,
            observedAt: new Date('2026-01-01T00:00:00Z'),
            sourceUrl: 'https://example.test/r2',
            sourceDocument: {
              sha256: 'a'.repeat(64),
              supersededByDocumentId: null,
              ingestedAt: new Date('2026-01-01T00:00:00Z'),
              sourceUrl: 'https://example.test/r2',
            },
          },
        ],
      })),
    };
    tx.capabilityBudgetLineMatch = { findMany: jest.fn().mockResolvedValue([]) };
    tx.programIdentityCrosswalk.findMany.mockImplementation(async ({ where }: any) =>
      mappings.filter(
        (row) =>
          row.reviewStatus === where.reviewStatus &&
          row.recordedAt <= where.recordedAt.lte &&
          (row.validFromFy == null || row.validFromFy <= where.AND[0].OR[1].validFromFy.lte) &&
          (row.validToFy == null || row.validToFy >= where.AND[1].OR[1].validToFy.gte) &&
          !mappings.some(
            (newer) =>
              newer.supersedesId === row.id &&
              newer.recordedAt <= where.recordedAt.lte &&
              (!where.revisions.none.reviewStatus ||
                newer.reviewStatus === where.revisions.none.reviewStatus),
          ),
      ),
    );
    const service = serviceWith(tx);
    const evidence: any = [
      {
        sourceRevisionId: 'immutable-source',
        locator: { page: 3, row: 2 },
        stance: 'for',
        quote: 'Original exact evidence',
      },
    ];
    const decide = () =>
      service.decideReview(ctx, portfolio.id, review.id, {
        idempotencyKey: 'continuity-decision',
        expectedRevision: 2,
        expectedPortfolioRevision: 7,
        decisionType: 'include',
        reason: 'Original supported decision',
        evidenceFor: evidence,
      });
    return {
      tx,
      service,
      currentPortfolio,
      currentReview,
      decisions,
      ledgers,
      mappings,
      mapping,
      evidence,
      decide,
    };
  }
  it('captures the original committed dependency/evidence basis and keeps annual GET readonly', async () => {
    const h = harness();
    await h.decide();
    expect(h.ledgers).toHaveLength(1);
    expect(h.ledgers[0].originalEvidence).toMatchObject({
      baselineVersion: 1,
      decisionId: 'decision-1',
      evidenceFor: h.evidence,
      baseline: {
        available: true,
        mappings: [{ id: 'mapping-1', sourceDocument: { sha256: 'a'.repeat(64) } }],
      },
    });
    const original = JSON.stringify(h.ledgers[0]);
    const annual = await h.service.getAnnualReview(ctx, portfolio.id);
    expect(annual.counts.unchanged).toBe(1);
    expect(annual.items[0]).toMatchObject({ persisted: true, currentDecisionId: 'decision-1' });
    expect(h.tx.researchPortfolioContinuityLedger.create).toHaveBeenCalledTimes(1);
    expect(h.tx.researchPortfolioContinuityLedger.update).not.toHaveBeenCalled();
    expect(JSON.stringify(h.ledgers[0])).toBe(original);
  });
  it('ignores candidates and follows accepted split lineage while preserving original evidence on refresh', async () => {
    const h = harness();
    await h.decide();
    const originalEvidence = JSON.stringify(h.ledgers[0].originalEvidence);
    h.mappings.push({
      ...h.mapping,
      id: 'candidate-split',
      relationshipKind: 'split_from',
      reviewStatus: 'candidate',
      supersedesId: 'mapping-1',
    });
    expect((await h.service.getAnnualReview(ctx, portfolio.id)).counts.unchanged).toBe(1);
    h.mappings.push({
      ...h.mapping,
      id: 'accepted-split',
      relationshipKind: 'split_from',
      supersedesId: 'mapping-1',
    });
    const current = await h.service.getAnnualReview(ctx, portfolio.id);
    expect(current.counts.split).toBe(1);
    expect(h.ledgers[0].status).toBe('unchanged');
    await h.service.refreshAnnualReview(ctx, portfolio.id, {
      idempotencyKey: 'refresh-split',
      expectedRevision: 8,
    });
    expect(h.ledgers[0].status).toBe('split');
    expect(JSON.stringify(h.ledgers[0].originalEvidence)).toBe(originalEvidence);
    expect(h.tx.programIdentityCrosswalk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reviewStatus: 'accepted',
          revisions: { none: { reviewStatus: 'accepted', recordedAt: expect.any(Object) } },
        }),
      }),
    );
  });
  it('refreshes a current readonly split before existing annual reopen and never supersedes original decisions', async () => {
    const h = harness();
    await h.decide();
    h.mappings.push({
      ...h.mapping,
      id: 'accepted-split',
      relationshipKind: 'split_from',
      supersedesId: 'mapping-1',
    });
    expect((await h.service.getAnnualReview(ctx, portfolio.id)).counts.split).toBe(1);
    const originalDecision = JSON.stringify(h.decisions[0]);
    const result = await h.service.reopenAnnualReview(ctx, portfolio.id, {
      idempotencyKey: 'reopen-split',
      expectedRevision: 8,
      continuityIds: [h.ledgers[0].id],
    });
    expect(result.outcomes[0]?.status).toBe('assigned');
    expect(h.tx.researchPortfolioReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        targetKind: 'program_element',
        targetId: '0604115A',
        trigger: 'annual_continuity',
      }),
    });
    expect(JSON.stringify(h.decisions[0])).toBe(originalDecision);
    expect(h.decisions).toHaveLength(1);
  });
  it('reports legacy original-basis gaps without fabricating a historic comparison or writing on GET', async () => {
    const h = harness();
    await h.decide();
    h.ledgers.splice(0);
    const annual = await h.service.getAnnualReview(ctx, portfolio.id);
    expect(annual.items[0]).toMatchObject({
      persisted: false,
      status: 'unresolved',
      priorDependencyFingerprint: null,
      changedDependencies: { reasons: ['original_dependency_basis_not_captured'] },
      originalEvidence: { baselineVersion: null, evidenceFor: h.evidence },
    });
    expect(h.tx.researchPortfolioContinuityLedger.create).toHaveBeenCalledTimes(1);
    expect(h.tx.researchPortfolioContinuityLedger.update).not.toHaveBeenCalled();
  });
  it('keeps refresh replay actor bound, currently authorized and independent of later revision/archive', async () => {
    const h = harness();
    await h.decide();
    const input = { idempotencyKey: 'owned-refresh', expectedRevision: 8 };
    const first = await h.service.refreshAnnualReview(ctx, portfolio.id, input);
    h.currentPortfolio.revision = 12;
    h.currentPortfolio.lifecycle = 'archived';
    expect(await h.service.refreshAnnualReview(ctx, portfolio.id, input)).toEqual(first);
    await expect(
      h.service.refreshAnnualReview({ ...ctx, userId: 'other-actor' }, portfolio.id, input),
    ).rejects.toThrow('another actor');
    h.tx.researchPortfolioGrant.findUnique.mockResolvedValue(null);
    await expect(h.service.refreshAnnualReview(ctx, portfolio.id, input)).rejects.toThrow(
      'do not have access',
    );
  });
  it.each([
    ['merged_into', 'merged'],
    ['renumbered_from', 'renumbered'],
    ['renamed_from', 'renamed'],
  ])(
    'projects accepted %s lineage as %s without changing the original decision',
    async (relationshipKind, status) => {
      const h = harness();
      await h.decide();
      const original = JSON.stringify(h.decisions[0]);
      h.mappings.push({
        ...h.mapping,
        id: 'accepted-lineage',
        relationshipKind,
        supersedesId: 'mapping-1',
      });
      expect((await h.service.getAnnualReview(ctx, portfolio.id)).items[0]?.status).toBe(status);
      expect(JSON.stringify(h.decisions[0])).toBe(original);
    },
  );
  it('uses accepted fiscal validity windows for expiry and excludes future knowledge', async () => {
    const h = harness();
    h.mapping.validToFy = 2026;
    await h.decide();
    await h.service.refreshAnnualReview(ctx, portfolio.id, {
      idempotencyKey: 'expiry-refresh',
      expectedRevision: 8,
      asOfFiscalYear: 2027,
    });
    expect(h.ledgers[0].status).toBe('expired');
    const future = new Date(Date.now() + 86400000).toISOString();
    await expect(
      h.service.refreshAnnualReview(ctx, portfolio.id, {
        idempotencyKey: 'future-refresh',
        expectedRevision: 9,
        knownAt: future,
      }),
    ).rejects.toThrow('timestamp no later than now');
  });
  it('detects a changed canonical source revision independently from capability or label changes', async () => {
    const h = harness();
    await h.decide();
    const originalEvidence = JSON.stringify(h.ledgers[0].originalEvidence);
    h.tx.programElement.findUnique.mockImplementation(async ({ where }: any) => ({
      peCode: where.peCode,
      title: 'Canonical PE',
      service: 'Army',
      sourceConfidence: 1,
      raw: {},
      sources: [
        {
          id: 'pe-source-new',
          sourceDocumentId: 'immutable-source-new',
          confidence: 0.9,
          pageNumber: 3,
          fy: 2026,
          observedAt: new Date('2026-01-01T00:00:00Z'),
          sourceUrl: 'https://example.test/r2',
          sourceDocument: {
            sha256: 'b'.repeat(64),
            supersededByDocumentId: null,
            ingestedAt: new Date('2026-01-01T00:00:00Z'),
            sourceUrl: 'https://example.test/r2',
          },
        },
      ],
    }));
    const current = await h.service.getAnnualReview(ctx, portfolio.id);
    expect(current.items[0]?.status).toBe('changed');
    expect(current.items[0]?.priorDependencyFingerprint).not.toBe(
      current.items[0]?.dependencyFingerprint,
    );
    await h.service.refreshAnnualReview(ctx, portfolio.id, {
      idempotencyKey: 'source-refresh',
      expectedRevision: 8,
    });
    expect(JSON.stringify(h.ledgers[0].originalEvidence)).toBe(originalEvidence);
  });
  it.each([{ evidence: {} }, { confidence: 0.5 }, { sourceUrl: 'javascript:unqualified' }])(
    'does not qualify a non-PE identity from a source hash alone or weak provenance',
    async (bad) => {
      const h = harness();
      h.currentReview.targetKind = 'program';
      h.currentReview.targetId = h.mapping.programId;
      h.tx.program = {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: h.mapping.programId,
            canonicalName: 'Canonical Program',
            status: 'active',
            metadata: {},
          }),
      };
      Object.assign(h.mapping, bad);
      await h.decide();
      expect(h.ledgers[0].originalEvidence.baseline.available).toBe(false);
      const annual = await h.service.getAnnualReview(ctx, portfolio.id);
      expect(annual.items[0]?.status).toBe('unresolved');
      expect(annual.items[0]?.identityMapping).toMatchObject({
        mappings: [{ qualified: false }],
        sourceEditionAvailability: 'unavailable',
      });
    },
  );
  it('labels missing source editions partial without inventing a fiscal edition', async () => {
    const h = harness();
    h.currentReview.targetKind = 'program';
    h.currentReview.targetId = h.mapping.programId;
    h.tx.program = {
      findUnique: jest
        .fn()
        .mockResolvedValue({
          id: h.mapping.programId,
          canonicalName: 'Canonical Program',
          status: 'active',
          metadata: {},
        }),
    };
    h.mapping.sourceDocument.fiscalYear = null;
    await h.decide();
    expect(
      (await h.service.getAnnualReview(ctx, portfolio.id)).items[0]?.identityMapping,
    ).toMatchObject({
      sourceEditionAvailability: 'partial',
      limitations: expect.arrayContaining(['source_edition_not_fully_available']),
    });
  });
  it('selects historical identity evidence while marking current canonical reconstruction unsupported', async () => {
    const h = harness();
    await h.decide();
    const knownAt = new Date().toISOString();
    h.tx.programElement.findUnique.mockImplementation(async ({ where }: any) => ({
      peCode: where.peCode,
      title: 'Current facts after requested knowledge',
      service: 'Army',
      sourceConfidence: 1,
      raw: {},
      sources: [],
    }));
    await h.service.refreshAnnualReview(ctx, portfolio.id, {
      idempotencyKey: 'historical-known-at',
      expectedRevision: 8,
      knownAt,
    });
    expect(h.ledgers[0]).toMatchObject({
      status: 'unresolved',
      changedDependencies: { reasons: ['historical_canonical_source_projection_not_supported'] },
      identityMapping: {
        knownAtSupport: 'current_projection_with_temporal_identity',
        limitations: expect.arrayContaining([
          'historical_canonical_source_projection_not_supported',
        ]),
      },
    });
  });
  it('excludes future observed source records from current qualification', async () => {
    const h = harness();
    await h.decide();
    h.tx.programElement.findUnique.mockImplementation(async ({ where }: any) => ({
      peCode: where.peCode,
      title: 'Canonical PE',
      service: 'Army',
      sourceConfidence: 1,
      raw: {},
      sources: [
        {
          id: 'future-pe-source',
          sourceDocumentId: 'future-source',
          confidence: 1,
          pageNumber: 3,
          fy: 2026,
          observedAt: new Date(Date.now() + 86400000),
          sourceUrl: 'https://example.test/future',
          sourceDocument: {
            sha256: 'b'.repeat(64),
            supersededByDocumentId: null,
            ingestedAt: new Date(),
            sourceUrl: 'https://example.test/future',
          },
        },
      ],
    }));
    expect((await h.service.getAnnualReview(ctx, portfolio.id)).items[0]?.status).toBe(
      'unresolved',
    );
  });
});

describe('Exact review evidence validation for new decisions', () => {
  const request = (evidence: any, decisionType: any = 'include') => ({
    idempotencyKey: 'typed-evidence',
    expectedRevision: 2,
    expectedPortfolioRevision: 7,
    decisionType,
    reason: 'Bounded evidence',
    evidenceFor: evidence,
  });
  const valid = (locator: any = { page: 1 }) => ({
    sourceRevisionId: 'opaque:legacy-source/revision-v1',
    locator,
    stance: 'for',
    quote: 'Exact source text',
  });
  it.each(['include', 'exclude', 'dispute'])(
    'rejects an empty object for %s with 400 and no immutable decision',
    async (kind) => {
      const tx = txHarness();
      await expect(
        serviceWith(tx).decideReview(ctx, portfolio.id, review.id, request([{}], kind) as any),
      ).rejects.toMatchObject({ status: 400 });
      expect(tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
      expect(tx.researchPortfolioContinuityLedger.create).not.toHaveBeenCalled();
      expect(tx.researchPortfolioReview.update).not.toHaveBeenCalled();
    },
  );
  it.each([
    { page: 0 },
    { page: -1 },
    { page: '3' },
    { page: 1.5 },
    { start: 4, end: 4 },
    { span: { start: 5, end: 2 } },
    { xmlPath: ' ' },
    { table: 'T', row: {} },
    { page: 1, span: { start: 5, end: 2 } },
    { section: '' },
  ])('rejects malformed locator %j', async (locator) => {
    const tx = txHarness();
    await expect(
      serviceWith(tx).decideReview(ctx, portfolio.id, review.id, request([valid(locator)]) as any),
    ).rejects.toMatchObject({ status: 400 });
    expect(tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
  });
  it.each([
    { sourceRevisionId: ' ' },
    { stance: 'against' },
    { quote: {} },
    { quote: 'x'.repeat(10001) },
  ])('rejects malformed reference, stance or quote', async (patch) => {
    const tx = txHarness();
    await expect(
      serviceWith(tx).decideReview(
        ctx,
        portfolio.id,
        review.id,
        request([{ ...valid(), ...patch }]) as any,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
  });
  it('bounds evidence arrays before writes', async () => {
    const tx = txHarness();
    await expect(
      serviceWith(tx).decideReview(
        ctx,
        portfolio.id,
        review.id,
        request(Array.from({ length: 101 }, () => valid())) as any,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
  });
  it.each([
    { page: 3 },
    { start: 0, end: 5 },
    { span: { start: 0, end: 5 } },
    { xmlPath: '/budget/project[1]' },
    { table: 'Budget', row: 2 },
    { section: 'Section IV' },
  ])(
    'preserves valid opaque references and exact locator %j without an official-source claim',
    async (locator) => {
      const tx = txHarness(),
        evidence = [valid(locator)];
      await serviceWith(tx).decideReview(ctx, portfolio.id, review.id, request(evidence) as any);
      expect(tx.researchPortfolioDecision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ evidenceFor: evidence }),
      });
      expect(tx.researchPortfolioContinuityLedger.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          originalEvidence: expect.objectContaining({
            evidenceSourceQualification: 'unresolved_reference',
            evidenceQualificationLimitations: [
              'Review source references are retained without source resolution or official provenance qualification.',
            ],
          }),
        }),
      });
    },
  );
  it('rejects malformed bulk evidence before committing any member of the batch', async () => {
    const tx = txHarness();
    await expect(
      serviceWith(tx).bulkDecideReviews(ctx, portfolio.id, {
        idempotencyKey: 'bad-bulk',
        expectedRevision: 7,
        items: [
          {
            reviewId: review.id,
            expectedRevision: 2,
            decisionType: 'include',
            reason: 'Invalid bulk evidence',
            evidenceFor: [{}],
          },
        ],
      } as any),
    ).rejects.toMatchObject({ status: 400 });
    expect(tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
    expect(tx.researchPortfolioEvent.create).not.toHaveBeenCalled();
  });
  it('uses the same typed locator validator for imported reviews before creating a review', async () => {
    const tx = txHarness();
    await expect(
      serviceWith(tx).importReviewInTransaction(
        tx,
        ctx,
        portfolio.id,
        {
          target_kind: 'portfolio',
          target_id: portfolio.id,
          reason: 'Invalid imported evidence',
          decision_type: 'include',
          evidence_for: JSON.stringify([valid({ page: 0 })]),
        },
        'bad-import',
        7,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(tx.researchPortfolioReview.create).not.toHaveBeenCalled();
    expect(tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
  });
  it('reports malformed imported JSON as 400 before creating a review', async () => {
    const tx = txHarness();
    await expect(
      serviceWith(tx).importReviewInTransaction(
        tx,
        ctx,
        portfolio.id,
        {
          target_kind: 'portfolio',
          target_id: portfolio.id,
          reason: 'Malformed JSON',
          decision_type: 'include',
          evidence_for: '{',
        },
        'bad-json',
        7,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(tx.researchPortfolioReview.create).not.toHaveBeenCalled();
  });
  it('replays a matching legacy committed payload before applying new evidence validation, but requires current editor and original actor', async () => {
    const tx = txHarness(),
      service = serviceWith(tx),
      input = request([{}]);
    const validator = jest
      .spyOn(service as any, 'validateDecisionEvidence')
      .mockImplementation(() => {});
    const receipt = await service.decideReview(ctx, portfolio.id, review.id, input as any);
    validator.mockRestore();
    const calls = tx.researchPortfolioEvent.create.mock.calls;
    expect(calls).toHaveLength(1);
    const committed = calls[0];
    if (!committed) throw new Error('Committed event absent');
    tx.researchPortfolioEvent.findFirst.mockResolvedValue({
      ...committed[0].data,
      occurredAt: new Date('2028-09-30T01:00:00Z'),
    });
    tx.researchPortfolio.findUnique.mockResolvedValue({
      ...portfolio,
      revision: 80,
      lifecycle: 'archived',
    });
    tx.researchPortfolioDecision.create.mockClear();
    await expect(service.decideReview(ctx, portfolio.id, review.id, input as any)).resolves.toEqual(
      receipt,
    );
    expect(tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
    await expect(
      service.decideReview(
        { ...ctx, userId: 'different-editor' },
        portfolio.id,
        review.id,
        input as any,
      ),
    ).rejects.toThrow('another actor');
    tx.researchPortfolioGrant.findUnique.mockResolvedValue({ ...grant, role: 'viewer' });
    await expect(service.decideReview(ctx, portfolio.id, review.id, input as any)).rejects.toThrow(
      'Required role: editor',
    );
  });
  it('replays committed bulk evidence after archive drift before new validation', async () => {
    const tx = txHarness(),
      service = serviceWith(tx),
      input: any = {
        idempotencyKey: 'legacy-bulk',
        expectedRevision: 7,
        items: [
          {
            reviewId: review.id,
            expectedRevision: 2,
            decisionType: 'include',
            reason: 'Legacy bulk',
            evidenceFor: [{}],
          },
        ],
      };
    const validator = jest
      .spyOn(service as any, 'validateDecisionEvidence')
      .mockImplementation(() => {});
    const receipt = await service.bulkDecideReviews(ctx, portfolio.id, input);
    validator.mockRestore();
    const calls = tx.researchPortfolioEvent.create.mock.calls;
    expect(calls).toHaveLength(1);
    const committed = calls[0];
    if (!committed) throw new Error('Committed event absent');
    tx.researchPortfolioEvent.findFirst.mockResolvedValue({
      ...committed[0].data,
      occurredAt: new Date('2028-09-30T01:00:00Z'),
    });
    tx.researchPortfolio.findUnique.mockResolvedValue({
      ...portfolio,
      lifecycle: 'archived',
      revision: 80,
    });
    tx.researchPortfolioDecision.create.mockClear();
    await expect(service.bulkDecideReviews(ctx, portfolio.id, input)).resolves.toEqual(receipt);
    expect(tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
  });
});
