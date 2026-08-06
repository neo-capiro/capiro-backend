import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryReviewAdminInboxService } from './memory-review-admin-inbox.service.js';
import {
  MemoryReviewInboxService,
  type MemoryReviewInboxItem,
} from './memory-review-inbox.service.js';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';

const adminCtx: TenantContext = {
  tenantId: '44444444-4444-4444-8444-444444444444',
  tenantSlug: 'test',
  userId: ADMIN,
  clerkUserId: 'admin',
  role: 'user_admin',
};

const subject = {
  id: CANDIDATE,
  tenantId: adminCtx.tenantId,
  clientId: null,
  ownerUserId: ADMIN,
  proposedByUserId: ADMIN,
  memoryClass: 'institutional_authoritative' as const,
  scope: 'firm' as const,
  status: 'pending_review' as const,
  legalHold: false,
  clientStatus: null,
};

function item(): MemoryReviewInboxItem {
  return {
    candidateId: CANDIDATE,
    reviewRequestId: REQUEST,
    candidateKind: 'standard',
    scope: 'firm',
    client: null,
    title: 'Firm Soul',
    status: 'pending',
    revisionNumber: 1,
    rootCandidateId: CANDIDATE,
    predecessorCandidateId: null,
    submittedBy: { userId: ADMIN, name: 'Admin Proposer' },
    assignedReviewer: {
      userId: '55555555-5555-4555-8555-555555555555',
      name: 'Other Reviewer',
    },
    decidedBy: null,
    createdAt: '2026-08-06T12:00:00.000Z',
    decidedAt: null,
    blockedReason: 'reviewer_unavailable',
    nextAction: 'await_reviewer',
    capabilities: {
      open: true,
      approve: false,
      reject: false,
      requestChanges: false,
      revise: false,
      reassign: false,
      withdraw: true,
    },
  };
}

function harness(allowed = true) {
  const tx = {};
  const withTenantUser = jest.fn(
    async (
      _tenantId: string,
      _userId: string,
      work: (value: typeof tx) => unknown,
    ) => work(tx),
  );
  const loadCandidateInTx = jest.fn(async () => subject);
  const evaluateInTx = jest.fn(async () =>
    allowed
      ? ({ allowed: true, basis: 'admin' } as const)
      : ({ allowed: false, reason: 'admin_required' } as const),
  );
  const service = new MemoryReviewAdminInboxService(
    { withTenantUser } as unknown as PrismaService,
    { loadCandidateInTx, evaluateInTx } as unknown as MemoryAuthorizationService,
  );
  return { service, withTenantUser, loadCandidateInTx, evaluateInTx };
}

afterEach(() => jest.restoreAllMocks());

describe('MemoryReviewAdminInboxService', () => {
  it('shows an admin proposer in Needs my review with decision capabilities', async () => {
    const baseList = jest
      .spyOn(MemoryReviewInboxService.prototype, 'list')
      .mockResolvedValue({
        enabled: true,
        view: 'all_pending',
        items: [item()],
        nextCursor: null,
      });
    const h = harness(true);

    await expect(
      h.service.list(adminCtx, { view: 'needs_my_review', limit: 25 }),
    ).resolves.toMatchObject({
      enabled: true,
      view: 'needs_my_review',
      items: [
        {
          candidateId: CANDIDATE,
          blockedReason: null,
          nextAction: 'review',
          capabilities: {
            approve: true,
            reject: true,
            requestChanges: true,
            reassign: true,
            withdraw: true,
          },
        },
      ],
    });
    expect(baseList).toHaveBeenCalledWith(
      adminCtx,
      expect.objectContaining({ view: 'all_pending' }),
    );
    expect(h.withTenantUser).toHaveBeenCalledTimes(1);
    expect(h.loadCandidateInTx).toHaveBeenCalledWith(txMatcher(), adminCtx.tenantId, CANDIDATE);
    expect(h.evaluateInTx).toHaveBeenCalledWith(
      txMatcher(),
      adminCtx,
      subject,
      'approve',
      { emitDenialMetrics: false },
    );
  });

  it('does not manufacture capabilities when current authorization denies the admin', async () => {
    jest.spyOn(MemoryReviewInboxService.prototype, 'list').mockResolvedValue({
      enabled: true,
      view: 'all_pending',
      items: [item()],
      nextCursor: null,
    });
    const h = harness(false);
    const result = await h.service.list(adminCtx, { view: 'all_pending' });
    expect(result.items[0]).toMatchObject({
      blockedReason: 'reviewer_unavailable',
      capabilities: { approve: false, reject: false },
    });
  });

  it('leaves the standard-user base path unchanged', async () => {
    const standardCtx: TenantContext = { ...adminCtx, role: 'standard_user' };
    const page = {
      enabled: true,
      view: 'needs_my_review' as const,
      items: [item()],
      nextCursor: null,
    };
    const baseList = jest
      .spyOn(MemoryReviewInboxService.prototype, 'list')
      .mockResolvedValue(page);
    const h = harness(true);

    await expect(h.service.list(standardCtx, { view: 'needs_my_review' })).resolves.toBe(page);
    expect(baseList).toHaveBeenCalledWith(standardCtx, { view: 'needs_my_review' });
    expect(h.withTenantUser).not.toHaveBeenCalled();
    expect(h.evaluateInTx).not.toHaveBeenCalled();
  });
});

function txMatcher(): object {
  return expect.any(Object) as object;
}
