import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  GovernedMemorySubjectRow,
  MemoryAuthorizationService,
} from './memory-authorization.service.js';
import { MemoryReviewWorkflowService } from './memory-review-workflow.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROPOSER = '22222222-2222-4222-8222-222222222222';
const REVIEWER = '33333333-3333-4333-8333-333333333333';
const OTHER_REVIEWER = '44444444-4444-4444-8444-444444444444';
const CANDIDATE = '55555555-5555-4555-8555-555555555555';
const REQUEST = '66666666-6666-4666-8666-666666666666';

const reviewerCtx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: REVIEWER,
  clerkUserId: 'reviewer',
  role: 'user_admin',
};

const subject: GovernedMemorySubjectRow = {
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
};

const candidate = {
  id: CANDIDATE,
  tenantId: TENANT,
  clientId: null,
  proposedByUserId: PROPOSER,
  sourceKind: 'settings_sections',
  scope: 'firm',
  candidateKind: 'standard',
  title: 'Firm Soul',
};

function workflowRow(input: Partial<Record<string, unknown>> = {}) {
  return {
    id: REQUEST,
    tenantId: TENANT,
    candidateId: CANDIDATE,
    subjectId: CANDIDATE,
    clientId: null,
    status: 'pending',
    reason: 'Memory candidate awaiting independent review.',
    requestedBy: PROPOSER,
    assignedTo: REVIEWER,
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date('2026-08-05T20:00:00.000Z'),
    ...input,
  };
}

function activeMember(
  userId: string,
  role: string,
  email: string,
  firstName: string,
  lastName: string,
) {
  return { userId, role, email, firstName, lastName };
}

function identities() {
  return [
    activeMember(PROPOSER, 'user_admin', 'proposer@example.com', 'Pat', 'Proposer'),
    activeMember(REVIEWER, 'user_admin', 'reviewer@example.com', 'Riley', 'Reviewer'),
    activeMember(
      OTHER_REVIEWER,
      'capiro_admin',
      'admin@example.com',
      'Casey',
      'Administrator',
    ),
  ];
}

function mockQueryRaw() {
  return jest.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
}

function serviceHarness(tx: Record<string, unknown>, evaluate?: jest.Mock) {
  const authorization = {
    loadCandidateInTx: jest.fn(async () => subject),
    evaluateInTx:
      evaluate ??
      jest.fn(async () => ({ allowed: true as const, basis: 'admin' as const })),
  } as unknown as MemoryAuthorizationService;
  const withTenantUser = jest.fn(
    async (_tenantId: string, _userId: string, work: (value: unknown) => unknown) =>
      work(tx),
  );
  const prisma = { withTenantUser } as unknown as PrismaService;
  return {
    service: new MemoryReviewWorkflowService(prisma, authorization),
    authorization,
    withTenantUser,
  };
}

describe('MemoryReviewWorkflowService', () => {
  it('creates one body-free workflow and deterministically assigns the strongest eligible reviewer', async () => {
    const queryRaw = mockQueryRaw()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        activeMember(REVIEWER, 'user_admin', 'z@example.com', 'Riley', 'Reviewer'),
        activeMember(
          OTHER_REVIEWER,
          'capiro_admin',
          'a@example.com',
          'Casey',
          'Administrator',
        ),
      ])
      .mockResolvedValueOnce(identities());
    const created = workflowRow({ assignedTo: REVIEWER });
    const create = jest.fn(async (..._args: unknown[]) => created);
    const auditCreate = jest.fn(async () => ({}));
    const tx = {
      $queryRaw: queryRaw,
      reviewRequest: { create, update: jest.fn() },
      auditLog: { create: auditCreate },
    } as unknown as Prisma.TransactionClient;
    const h = serviceHarness(tx as unknown as Record<string, unknown>);

    await expect(
      h.service.ensureAndDescribeInTx(tx, reviewerCtx, candidate, subject),
    ).resolves.toMatchObject({
      status: 'pending',
      submittedBy: { name: 'Pat Proposer' },
      assignedReviewer: { userId: REVIEWER, name: 'Riley Reviewer' },
      viewerIsAssignedReviewer: true,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        surface: 'memory',
        subjectType: 'memory_candidate',
        subjectId: CANDIDATE,
        requestedBy: PROPOSER,
        assignedTo: REVIEWER,
        status: 'pending',
        payload: {
          workflow: 'memory_review_v2',
          schemaVersion: 1,
          candidateKind: 'standard',
          sourceKind: 'settings_sections',
          scope: 'firm',
        },
      }),
    });
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain('Firm Soul body');
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'memory.review.assignment.created' }),
    });
  });

  it('reassigns a pending workflow when the old reviewer is no longer eligible', async () => {
    const existing = workflowRow({ assignedTo: OTHER_REVIEWER });
    const queryRaw = mockQueryRaw()
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([
        activeMember(REVIEWER, 'user_admin', 'reviewer@example.com', 'Riley', 'Reviewer'),
      ])
      .mockResolvedValueOnce(identities());
    const update = jest.fn(async () => workflowRow({ assignedTo: REVIEWER }));
    const tx = {
      $queryRaw: queryRaw,
      reviewRequest: { create: jest.fn(), update },
      auditLog: { create: jest.fn(async () => ({})) },
    } as unknown as Prisma.TransactionClient;
    const h = serviceHarness(tx as unknown as Record<string, unknown>);

    await expect(
      h.service.ensureAndDescribeInTx(tx, reviewerCtx, candidate, subject),
    ).resolves.toMatchObject({
      assignedReviewer: { userId: REVIEWER, name: 'Riley Reviewer' },
      viewerIsAssignedReviewer: true,
      capabilities: { requestChanges: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: REQUEST },
      data: { assignedTo: REVIEWER },
    });
  });

  it('requires bounded feedback before opening a transaction', async () => {
    const h = serviceHarness({});
    await expect(
      h.service.requestChanges(reviewerCtx, CANDIDATE, '   '),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.withTenantUser).not.toHaveBeenCalled();
  });

  it('records changes_requested only for the assigned independent reviewer', async () => {
    const pending = workflowRow();
    const updated = workflowRow({
      status: 'changes_needed',
      reason: 'Add the underlying source.',
      decidedBy: REVIEWER,
      decidedAt: new Date('2026-08-05T20:05:00.000Z'),
    });
    const queryRaw = mockQueryRaw()
      .mockResolvedValueOnce([
        {
          id: CANDIDATE,
          clientId: null,
          proposedBy: PROPOSER,
          sourceKind: 'settings_sections',
          scope: 'firm',
          payload: { canonicalItem: { title: 'Firm Soul' } },
        },
      ])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([
        activeMember(REVIEWER, 'user_admin', 'reviewer@example.com', 'Riley', 'Reviewer'),
      ])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce(identities());
    const update = jest.fn(async () => updated);
    const auditCreate = jest.fn(async () => ({}));
    const tx = {
      $queryRaw: queryRaw,
      reviewRequest: { create: jest.fn(), update },
      auditLog: { create: auditCreate },
    } as unknown as Prisma.TransactionClient;
    const h = serviceHarness(tx as unknown as Record<string, unknown>);

    await expect(
      h.service.requestChanges(reviewerCtx, CANDIDATE, ' Add the underlying\nsource. '),
    ).resolves.toMatchObject({
      status: 'changes_requested',
      feedbackReason: 'Add the underlying source.',
      decidedBy: { userId: REVIEWER, name: 'Riley Reviewer' },
      capabilities: { requestChanges: false },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: REQUEST },
      data: expect.objectContaining({
        status: 'changes_needed',
        reason: 'Add the underlying source.',
        decidedBy: REVIEWER,
      }),
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'memory.review.changes_requested',
        after: expect.objectContaining({ reasonChars: 26 }),
      }),
    });
  });

  it('rejects an authorized but unassigned reviewer', async () => {
    const pending = workflowRow({ assignedTo: OTHER_REVIEWER });
    const queryRaw = mockQueryRaw()
      .mockResolvedValueOnce([
        {
          id: CANDIDATE,
          clientId: null,
          proposedBy: PROPOSER,
          sourceKind: 'settings_sections',
          scope: 'firm',
          payload: { canonicalItem: { title: 'Firm Soul' } },
        },
      ])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([
        activeMember(
          OTHER_REVIEWER,
          'capiro_admin',
          'admin@example.com',
          'Casey',
          'Administrator',
        ),
      ])
      .mockResolvedValueOnce([pending]);
    const tx = {
      $queryRaw: queryRaw,
      reviewRequest: { create: jest.fn(), update: jest.fn() },
      auditLog: { create: jest.fn() },
    } as unknown as Prisma.TransactionClient;
    const h = serviceHarness(tx as unknown as Record<string, unknown>);

    await expect(
      h.service.requestChanges(reviewerCtx, CANDIDATE, 'Needs revision.'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.reviewRequest.update).not.toHaveBeenCalled();
  });

  it('gates approval to the named reviewer while the workflow is pending', async () => {
    const pending = workflowRow();
    const queryRaw = mockQueryRaw()
      .mockResolvedValueOnce([
        {
          id: CANDIDATE,
          clientId: null,
          proposedBy: PROPOSER,
          sourceKind: 'settings_sections',
          scope: 'firm',
          payload: { canonicalItem: { title: 'Firm Soul' } },
        },
      ])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([
        activeMember(REVIEWER, 'user_admin', 'reviewer@example.com', 'Riley', 'Reviewer'),
      ])
      .mockResolvedValueOnce([pending]);
    const tx = {
      $queryRaw: queryRaw,
      reviewRequest: { create: jest.fn(), update: jest.fn() },
      auditLog: { create: jest.fn() },
    } as unknown as Prisma.TransactionClient;
    const h = serviceHarness(tx as unknown as Record<string, unknown>);

    await expect(
      h.service.assertAssignedForDecision(reviewerCtx, CANDIDATE, 'approve'),
    ).resolves.toBeUndefined();
    expect(h.authorization.evaluateInTx).toHaveBeenLastCalledWith(
      tx,
      reviewerCtx,
      subject,
      'approve',
    );
  });

  it('requires a reason and writes the bounded DB token for rejection completion', async () => {
    const pending = workflowRow();
    const updated = workflowRow({
      status: 'rejected',
      reason: 'The source does not support this claim.',
      decidedBy: REVIEWER,
      decidedAt: new Date('2026-08-05T20:10:00.000Z'),
    });
    const queryRaw = mockQueryRaw().mockResolvedValueOnce([pending]).mockResolvedValueOnce(identities());
    const update = jest.fn(async () => updated);
    const tx = {
      $queryRaw: queryRaw,
      reviewRequest: { update },
      auditLog: { create: jest.fn(async () => ({})) },
    } as unknown as Prisma.TransactionClient;
    const h = serviceHarness(tx as unknown as Record<string, unknown>);

    await expect(
      h.service.completeDecision(
        reviewerCtx,
        CANDIDATE,
        'rejected',
        'The source does not support this claim.',
      ),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(update).toHaveBeenCalledWith({
      where: { id: REQUEST },
      data: expect.objectContaining({ status: 'rejected', decidedBy: REVIEWER }),
    });
  });

  it('allows an administrator to reassign only to a currently eligible reviewer', async () => {
    const pending = workflowRow({ assignedTo: OTHER_REVIEWER });
    const queryRaw = mockQueryRaw()
      .mockResolvedValueOnce([
        {
          id: CANDIDATE,
          clientId: null,
          proposedBy: PROPOSER,
          sourceKind: 'settings_sections',
          scope: 'firm',
          payload: { canonicalItem: { title: 'Firm Soul' } },
        },
      ])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([
        activeMember(REVIEWER, 'user_admin', 'reviewer@example.com', 'Riley', 'Reviewer'),
      ])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([
        activeMember(REVIEWER, 'user_admin', 'reviewer@example.com', 'Riley', 'Reviewer'),
      ])
      .mockResolvedValueOnce(identities());
    const update = jest.fn(async () => workflowRow({ assignedTo: REVIEWER }));
    const tx = {
      $queryRaw: queryRaw,
      reviewRequest: { create: jest.fn(), update },
      auditLog: { create: jest.fn(async () => ({})) },
    } as unknown as Prisma.TransactionClient;
    const h = serviceHarness(tx as unknown as Record<string, unknown>);

    await expect(
      h.service.assignReviewer(
        reviewerCtx,
        CANDIDATE,
        REVIEWER,
        'Reviewer coverage changed.',
      ),
    ).resolves.toMatchObject({ assignedReviewer: { userId: REVIEWER } });
  });
});
