import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  GovernedMemorySubjectRow,
  MemoryAuthorizationService,
} from './memory-authorization.service.js';
import {
  MemorySettingsReviewReadinessService,
  nextActionForPendingReview,
  settingsMemoryReviewEnabledForTenant,
} from './memory-settings-review-readiness.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROPOSER = '22222222-2222-4222-8222-222222222222';
const REVIEWER = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';

const ctx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: PROPOSER,
  clerkUserId: 'user_1',
  role: 'user_admin',
};

const members = [
  {
    userId: PROPOSER,
    role: 'user_admin',
    email: 'proposer@example.com',
    firstName: 'Pat',
    lastName: 'Proposer',
  },
  {
    userId: REVIEWER,
    role: 'user_admin',
    email: 'reviewer@example.com',
    firstName: 'Riley',
    lastName: 'Reviewer',
  },
];

function enableReview(): void {
  process.env.MEMORY_CLIENT_REVIEW = 'enforce';
  process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
  process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
  process.env.MEMORY_GOVERNANCE_TENANTS = TENANT;
}

function firmInput() {
  return {
    type: 'firm-soul' as const,
    slug: 'firm',
    title: 'Firm Soul',
    scope: 'firm' as const,
    clientId: null,
    sections: [{ key: 'mission', heading: 'Mission', owner: 'human' as const, body: 'Win.' }],
  };
}

function subject(
  id: string,
  proposedByUserId: string,
  scope: 'firm' | 'client' = 'firm',
): GovernedMemorySubjectRow {
  return {
    id,
    tenantId: TENANT,
    clientId: scope === 'client' ? CLIENT : null,
    ownerUserId: proposedByUserId,
    proposedByUserId,
    memoryClass: scope === 'client' ? 'client_steering' : 'institutional_authoritative',
    scope,
    status: 'pending_review',
    legalHold: false,
    clientStatus: 'active',
  };
}

function harness(
  options: {
    memberRows?: typeof members;
    candidate?: Record<string, unknown> | null;
    candidates?: Array<Record<string, unknown>>;
    authorization?: (
      userId: string,
      subject: GovernedMemorySubjectRow,
      operation: string,
    ) => boolean;
    subjects?: Record<string, GovernedMemorySubjectRow>;
  } = {},
) {
  const tx = {
    $queryRaw: jest.fn(async () => options.memberRows ?? members),
    client: { findFirst: jest.fn(async () => ({ status: 'active' })) },
    user: { findFirst: jest.fn(async () => null) },
    memoryCandidate: {
      findFirst: jest.fn(async () => options.candidate ?? null),
      findMany: jest.fn(async () => options.candidates ?? []),
    },
  };
  const withTenantUser = jest.fn(
    async (_tenantId: string, _userId: string, work: (value: typeof tx) => unknown) => work(tx),
  );
  const loadCandidateInTx = jest.fn(
    async (_tx: unknown, _tenantId: string, candidateId: string) =>
      options.subjects?.[candidateId] ?? null,
  );
  const evaluateInTx = jest.fn(
    async (
      _tx: unknown,
      actor: Pick<TenantContext, 'tenantId' | 'userId' | 'role'>,
      candidate: GovernedMemorySubjectRow,
      operation: string,
    ) =>
      options.authorization?.(actor.userId, candidate, operation)
        ? ({ allowed: true, basis: 'admin' } as const)
        : ({ allowed: false, reason: 'admin_required' } as const),
  );
  const service = new MemorySettingsReviewReadinessService(
    { withTenantUser } as unknown as PrismaService,
    { loadCandidateInTx, evaluateInTx } as unknown as MemoryAuthorizationService,
  );
  return { service, tx, withTenantUser, loadCandidateInTx, evaluateInTx };
}

afterEach(() => {
  delete process.env.MEMORY_CLIENT_REVIEW;
  delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  delete process.env.MEMORY_GOVERNANCE_ENFORCE;
  delete process.env.MEMORY_GOVERNANCE_TENANTS;
  jest.restoreAllMocks();
});

describe('MemorySettingsReviewReadinessService', () => {
  it('requires every tenant-scoped review control to be armed', () => {
    expect(settingsMemoryReviewEnabledForTenant(TENANT, {})).toBe(false);
    expect(
      settingsMemoryReviewEnabledForTenant(TENANT, {
        MEMORY_CLIENT_REVIEW: 'enforce',
        MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
        MEMORY_GOVERNANCE_ENFORCE: 'enforce',
        MEMORY_GOVERNANCE_TENANTS: TENANT,
      }),
    ).toBe(true);
    expect(
      settingsMemoryReviewEnabledForTenant(TENANT, {
        MEMORY_CLIENT_REVIEW: 'true',
        MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
        MEMORY_GOVERNANCE_ENFORCE: 'enforce',
        MEMORY_GOVERNANCE_TENANTS: TENANT,
      }),
    ).toBe(false);
    expect(
      settingsMemoryReviewEnabledForTenant(TENANT, {
        MEMORY_CLIENT_REVIEW: 'enforce',
        MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
        MEMORY_GOVERNANCE_ENFORCE: 'enforce',
        MEMORY_GOVERNANCE_TENANTS: '99999999-9999-4999-8999-999999999999',
      }),
    ).toBe(false);
  });

  it('returns a disabled zero-count summary without querying governed tables', async () => {
    const h = harness();
    await expect(h.service.summary(ctx)).resolves.toEqual({
      enabled: false,
      counts: { awaitingMyReview: 0, submittedByMe: 0, allPending: 0, blocked: 0 },
      message: expect.stringContaining('disabled'),
    });
    expect(h.withTenantUser).not.toHaveBeenCalled();
  });

  it('returns 409 before touching the database when review is disabled', async () => {
    const h = harness();
    await expect(h.service.assertSubmissionReady(ctx, firmInput())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(h.withTenantUser).not.toHaveBeenCalled();
  });

  it('shows the proposer their stranded proposal while review is disabled', async () => {
    const candidateId = '51515151-5151-4515-8515-515151515151';
    const h = harness({
      candidate: {
        id: candidateId,
        proposedBy: PROPOSER,
        sourceKind: 'settings_sections',
        scope: 'firm',
        clientId: null,
        createdAt: new Date('2026-08-05T12:00:00.000Z'),
        payload: {
          canonicalItem: {
            title: 'Firm Soul',
            sections: [{ key: 'mission', heading: 'Mission', owner: 'human', body: 'Stranded.' }],
          },
        },
      },
    });

    await expect(
      h.service.describePendingCandidate(
        TENANT,
        PROPOSER,
        { candidateId, status: 'pending_review', submittedAt: 'old' },
        { reviewEnabled: false },
      ),
    ).resolves.toMatchObject({
      proposal: { sections: [expect.objectContaining({ body: 'Stranded.' })] },
      blocked: true,
      canWithdraw: false,
      nextAction: expect.stringContaining('currently unavailable'),
    });
    expect(h.loadCandidateInTx).not.toHaveBeenCalled();
    expect(h.evaluateInTx).not.toHaveBeenCalled();
  });

  it('blocks a shared submission when nobody else can approve it', async () => {
    enableReview();
    const h = harness({ authorization: () => false });
    await expect(h.service.assertSubmissionReady(ctx, firmInput())).rejects.toThrow(
      'No eligible reviewer is available',
    );
  });

  it('returns the eligible independent reviewers used by the real approval policy', async () => {
    enableReview();
    const h = harness({
      authorization: (userId, _candidate, operation) =>
        userId === REVIEWER && operation === 'approve',
    });
    await expect(h.service.assertSubmissionReady(ctx, firmInput())).resolves.toEqual({
      eligibleReviewers: [expect.objectContaining({ userId: REVIEWER, name: 'Riley Reviewer' })],
    });
    expect(h.evaluateInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: REVIEWER }),
      expect.anything(),
      'approve',
      { emitDenialMetrics: false },
    );
  });

  it('returns the proposed sections, proposer, reviewers, and next step on reload', async () => {
    enableReview();
    const candidateId = '55555555-5555-4555-8555-555555555555';
    const h = harness({
      candidate: {
        id: candidateId,
        proposedBy: PROPOSER,
        sourceKind: 'settings_sections',
        scope: 'firm',
        clientId: null,
        createdAt: new Date('2026-08-05T12:00:00.000Z'),
        payload: {
          canonicalItem: {
            title: 'Firm Soul',
            sections: [
              { key: 'mission', heading: 'Mission', owner: 'human', body: 'Proposed truth.' },
            ],
          },
        },
      },
      subjects: { [candidateId]: subject(candidateId, PROPOSER) },
      authorization: (userId, _candidate, operation) =>
        userId === REVIEWER && operation === 'approve',
    });

    await expect(
      h.service.describePendingCandidate(TENANT, PROPOSER, {
        candidateId,
        status: 'pending_review',
        submittedAt: 'old',
      }),
    ).resolves.toMatchObject({
      proposal: {
        title: 'Firm Soul',
        sections: [expect.objectContaining({ body: 'Proposed truth.' })],
      },
      submittedBy: { name: 'Pat Proposer' },
      eligibleReviewers: [expect.objectContaining({ name: 'Riley Reviewer' })],
      blocked: false,
      canWithdraw: true,
      viewerCanReview: false,
      nextAction: expect.stringContaining('You cannot approve your own'),
    });
  });

  it('lets an authorized reject-only reviewer inspect without implying approval authority', async () => {
    enableReview();
    const candidateId = '65656565-6565-4565-8565-656565656565';
    const rejectOnly = '76767676-7676-4767-8767-767676767676';
    const h = harness({
      memberRows: [
        ...members,
        {
          userId: rejectOnly,
          role: 'standard_user',
          email: 'rejector@example.com',
          firstName: 'Reese',
          lastName: 'Reviewer',
        },
      ],
      candidate: {
        id: candidateId,
        proposedBy: PROPOSER,
        sourceKind: 'settings_sections',
        scope: 'firm',
        clientId: null,
        createdAt: new Date('2026-08-05T12:00:00.000Z'),
        payload: {
          canonicalItem: {
            title: 'Firm Soul',
            sections: [{ key: 'mission', heading: 'Mission', owner: 'human', body: 'Review me.' }],
          },
        },
      },
      subjects: { [candidateId]: subject(candidateId, PROPOSER) },
      authorization: (userId, _candidate, operation) =>
        (userId === REVIEWER && operation === 'approve') ||
        (userId === rejectOnly && operation === 'review'),
    });

    await expect(
      h.service.describePendingCandidate(TENANT, rejectOnly, {
        candidateId,
        status: 'pending_review',
        submittedAt: 'old',
      }),
    ).resolves.toMatchObject({
      proposal: { sections: [expect.objectContaining({ body: 'Review me.' })] },
      viewerCanReview: true,
      viewerCanApprove: false,
      viewerCanReject: true,
      nextAction: expect.stringContaining('reject this proposal'),
    });
  });

  it('does not expose unapproved proposal content to an unrelated viewer', async () => {
    enableReview();
    const candidateId = '66666666-6666-4666-8666-666666666666';
    const unrelated = '77777777-7777-4777-8777-777777777777';
    const h = harness({
      memberRows: [
        ...members,
        {
          userId: unrelated,
          role: 'standard_user',
          email: 'viewer@example.com',
          firstName: 'Una',
          lastName: 'Related',
        },
      ],
      candidate: {
        id: candidateId,
        proposedBy: PROPOSER,
        sourceKind: 'settings_sections',
        scope: 'firm',
        clientId: null,
        createdAt: new Date('2026-08-05T12:00:00.000Z'),
        payload: {
          canonicalItem: {
            title: 'Firm Soul',
            sections: [{ key: 'mission', heading: 'Mission', owner: 'human', body: 'Unapproved.' }],
          },
        },
      },
      subjects: { [candidateId]: subject(candidateId, PROPOSER) },
      authorization: (userId, _candidate, operation) =>
        userId === REVIEWER && operation === 'approve',
    });

    const result = await h.service.describePendingCandidate(TENANT, unrelated, {
      candidateId,
      status: 'pending_review',
      submittedAt: 'old',
    });
    expect(result).toMatchObject({
      proposal: { title: 'Pending shared-memory proposal', sections: [] },
      eligibleReviewers: [],
      viewerCanReview: false,
      canWithdraw: false,
    });
    expect(result).not.toHaveProperty('submittedBy');
  });

  it('splits review counts into mine, submitted, all visible, and blocked', async () => {
    enableReview();
    const ownId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const blockedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const blockedProposer = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const h = harness({
      candidates: [
        { id: ownId, proposedBy: PROPOSER, scope: 'firm' },
        { id: otherId, proposedBy: REVIEWER, scope: 'firm' },
        { id: blockedId, proposedBy: blockedProposer, scope: 'client' },
      ],
      subjects: {
        [ownId]: subject(ownId, PROPOSER),
        [otherId]: subject(otherId, REVIEWER),
        [blockedId]: subject(blockedId, blockedProposer, 'client'),
      },
      authorization: (userId, candidate, operation) => {
        if (candidate.id === ownId) return userId === REVIEWER && operation === 'approve';
        if (candidate.id === otherId) return userId === PROPOSER && operation === 'approve';
        if (candidate.id === blockedId) return userId === PROPOSER && operation === 'read';
        return false;
      },
    });

    await expect(h.service.summary(ctx)).resolves.toEqual({
      enabled: true,
      counts: {
        awaitingMyReview: 1,
        submittedByMe: 1,
        allPending: 3,
        blocked: 1,
      },
      message: '1 pending submission has no eligible independent reviewer.',
    });
  });
});

describe('nextActionForPendingReview', () => {
  it('explains the proposer independence rule in plain English', () => {
    expect(
      nextActionForPendingReview({
        blocked: false,
        viewerIsProposer: true,
        viewerCanApprove: false,
        viewerCanReject: false,
        reviewers: [
          { userId: REVIEWER, name: 'Riley Reviewer', email: 'r@example.com', role: 'user_admin' },
        ],
      }),
    ).toContain('You cannot approve your own');
  });
});
