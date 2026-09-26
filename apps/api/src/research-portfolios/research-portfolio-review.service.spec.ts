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
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'decision-1' }),
    },
    researchPortfolioContinuityLedger: {
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
    expect(tx.researchPortfolioReview.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ assigneeUserId: null }, { assigneeUserId: { not: ctx.userId } }],
      }),
    }));
  });

  it('keeps viewers read-only', async () => {
    const tx = txHarness({
      researchPortfolioGrant: { findUnique: jest.fn().mockResolvedValue({ ...grant, role: 'viewer' }) },
    });

    await expect(serviceWith(tx).assignReview(ctx, portfolio.id, review.id, {
      idempotencyKey: 'assign-viewer',
      expectedRevision: 2,
      expectedPortfolioRevision: 7,
      assigneeUserId: 'user-2',
      reason: 'Assign to an analyst',
    })).rejects.toThrow('Required role: editor');
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
    expect(tx.researchPortfolio.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ revision: 7 }),
    }));
    expect(result.outcomes[0]).toMatchObject({ status: 'assigned', revision: 3 });
  });

  it('records a dispute as an append-only evidenced decision and leaves the review open', async () => {
    const tx = txHarness();
    const evidence = [{ sourceRevisionId: 'source-1', locator: { page: 3 }, quote: 'Counter evidence', stance: 'against' as const }];

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
    expect(tx.researchPortfolioReview.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'open', revision: { increment: 1 } }),
    }));
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

    await expect(serviceWith(tx).assignReview(ctx, portfolio.id, review.id, {
      idempotencyKey: 'reused',
      expectedRevision: 2,
      expectedPortfolioRevision: 7,
      assigneeUserId: null,
      reason: 'Unassign',
    })).rejects.toThrow('Idempotency key was already used for a different operation');
  });

  it('returns a conflict for every stale bulk item without writing decisions', async () => {
    const tx = txHarness({
      researchPortfolioReview: {
        findMany: jest.fn().mockResolvedValue([
          review,
          { ...review, id: 'review-2', revision: 4 },
        ]),
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
    const unchanged = { ...changed, id: 'continuity-unchanged', status: 'unchanged', continuityKey: 'e'.repeat(64) };
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
