import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryReviewInboxService } from './memory-review-inbox.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PROPOSER = '33333333-3333-4333-8333-333333333333';
const CANDIDATE = '44444444-4444-4444-8444-444444444444';
const REQUEST = '55555555-5555-4555-8555-555555555555';

const ctx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: USER,
  clerkUserId: 'user',
  role: 'user_admin',
};

const subject = {
  id: CANDIDATE,
  tenantId: TENANT,
  clientId: null,
  ownerUserId: PROPOSER,
  proposedByUserId: PROPOSER,
  memoryClass: 'institutional_authoritative',
  scope: 'firm',
  status: 'pending_review',
  legalHold: false,
  clientStatus: null,
} as const;

function inboxRow(overrides: Record<string, unknown> = {}) {
  return {
    reviewRequestId: REQUEST,
    candidateId: CANDIDATE,
    clientId: null,
    clientName: null,
    clientStatus: null,
    title: 'Firm Soul',
    workflowStatus: 'pending',
    requestedBy: PROPOSER,
    assignedTo: USER,
    decidedBy: null,
    createdAt: new Date('2026-08-06T12:00:00.000Z'),
    decidedAt: null,
    candidateKind: 'standard',
    sourceKind: 'settings_sections',
    scope: 'firm',
    revisionNumber: 1,
    rootCandidateId: CANDIDATE,
    predecessorCandidateId: null,
    supersededById: null,
    assignedReviewerActive: true,
    assignedReviewerRole: 'user_admin',
    submitterEmail: 'proposer@example.test',
    submitterFirstName: 'Pat',
    submitterLastName: 'Proposer',
    reviewerEmail: 'reviewer@example.test',
    reviewerFirstName: 'Riley',
    reviewerLastName: 'Reviewer',
    deciderEmail: null,
    deciderFirstName: null,
    deciderLastName: null,
    ...overrides,
  };
}

function harness(queryResults: unknown[][]) {
  const queryRaw = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
  for (const result of queryResults) queryRaw.mockResolvedValueOnce(result);
  const tx = {
    $queryRaw: queryRaw,
    $executeRaw: jest.fn(),
  };
  const prisma = {
    withTenantUser: jest.fn(
      async (
        _tenantId: string,
        _userId: string,
        work: (value: typeof tx) => unknown,
      ) => work(tx),
    ),
  } as unknown as PrismaService;
  const authorization = {
    loadCandidateInTx: jest.fn(async () => subject),
    evaluateInTx: jest.fn(
      async (
        _tx: unknown,
        _viewer: unknown,
        _subject: unknown,
        operation: string,
      ) => ({
        allowed: ['read', 'approve', 'review', 'propose'].includes(operation),
        basis: 'admin',
      }),
    ),
  } as unknown as MemoryAuthorizationService;
  return {
    service: new MemoryReviewInboxService(prisma, authorization),
    queryRaw,
    authorization,
    tx,
  };
}

describe('MemoryReviewInboxService', () => {
  beforeEach(() => {
    process.env.MEMORY_CLIENT_REVIEW = 'enforce';
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
    process.env.MEMORY_GOVERNANCE_TENANTS = TENANT;
  });

  it('returns a body-free current-assignment work item', async () => {
    const h = harness([[{ userId: USER, role: 'user_admin' }], [inboxRow()]]);
    const result = await h.service.list(ctx, {
      view: 'needs_my_review',
      limit: 25,
    });
    expect(result).toMatchObject({
      enabled: true,
      view: 'needs_my_review',
      items: [
        {
          candidateId: CANDIDATE,
          reviewRequestId: REQUEST,
          title: 'Firm Soul',
          nextAction: 'review',
          capabilities: {
            approve: true,
            reject: true,
            requestChanges: true,
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('proposal');
    expect(JSON.stringify(result)).not.toContain('payload');
  });

  it('hides detail from a former non-admin reviewer after reassignment', async () => {
    const formerCtx = { ...ctx, role: 'standard_user' as const };
    const row = inboxRow({
      assignedTo: '66666666-6666-4666-8666-666666666666',
      payload: {},
    });
    const h = harness([[{ userId: USER, role: 'standard_user' }], [row]]);
    await expect(h.service.detail(formerCtx, CANDIDATE)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('marks only a currently visible recipient notification as read', async () => {
    const h = harness([
      [{ userId: USER, role: 'user_admin' }],
      [
        {
          id: '77777777-7777-4777-8777-777777777777',
          reviewRequestId: REQUEST,
          candidateId: CANDIDATE,
          clientId: null,
          eventType: 'review_assigned',
          title: 'Firm Soul',
          readAt: null,
          createdAt: new Date('2026-08-06T12:00:00.000Z'),
        },
      ],
    ]);
    h.tx.$executeRaw = jest.fn(async () => 1);
    await expect(
      h.service.markNotificationRead(
        ctx,
        '77777777-7777-4777-8777-777777777777',
      ),
    ).resolves.toBeUndefined();
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('treats an active but no-longer-authorized assignee as blocked', async () => {
    const h = harness([
      [{ userId: USER, role: 'user_admin' }],
      [
        inboxRow({
          assignedTo: '66666666-6666-4666-8666-666666666666',
        }),
      ],
    ]);
    (
      h.authorization.evaluateInTx as unknown as {
        mockImplementation: (
          implementation: (
            tx: unknown,
            viewer: { userId?: string },
            subject: unknown,
            operation: string,
          ) => Promise<{ allowed: boolean; basis: string }>,
        ) => void;
      }
    ).mockImplementation(
      async (
        _tx: unknown,
        viewer: { userId?: string },
        _subject: unknown,
        operation: string,
      ) => ({
        allowed:
          operation === 'read' ||
          (operation === 'review' && viewer.userId === USER),
        basis: 'admin',
      }),
    );
    const result = await h.service.list(ctx, { view: 'blocked', limit: 25 });
    expect(result.items[0]?.blockedReason).toBe('reviewer_unavailable');
  });
});
