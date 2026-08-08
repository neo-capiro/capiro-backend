import type { TenantContext } from '@capiro/shared';
import { ForbiddenException } from '@nestjs/common';
import { OutreachReviewTransactionsService } from './outreach-review-transactions.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  role: 'standard_user',
} as TenantContext;

type Tx = {
  reviewRequest: {
    findFirst: jest.Mock;
    updateMany?: jest.Mock;
  };
};

function prismaFor(tx: Tx) {
  return {
    withTenant: jest.fn(
      async (_tenantId: string, run: (transaction: Tx) => Promise<unknown>) => run(tx),
    ),
  };
}

describe('OutreachReviewTransactionsService', () => {
  it('decides and stamps the exact immutable version in one transaction', async () => {
    const tx: Tx = {
      reviewRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'review-a',
          surface: 'outreach',
          subjectType: 'outreach-draft-version',
          subjectId: 'version-a',
          assignedTo: ctx.userId,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = prismaFor(tx);
    const drafts = {
      decideWithinTx: jest.fn().mockResolvedValue({
        id: 'version-a',
        version: 1,
        approvalStatus: 'approved',
        auditStatus: 'passed',
      }),
    };
    const service = new OutreachReviewTransactionsService(prisma as never, drafts as never);

    const result = await service.decide(ctx, 'review-a', 'approved');

    expect(drafts.decideWithinTx).toHaveBeenCalledWith(
      tx,
      ctx.tenantId,
      'version-a',
      'review-a',
      'approved',
    );
    expect(tx.reviewRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'review-a', status: 'pending' }),
      }),
    );
    expect(result.id).toBe('version-a');
  });

  it('does not let an unassigned requester decide', async () => {
    const tx: Tx = {
      reviewRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'review-a',
          surface: 'outreach',
          subjectType: 'outreach-draft-version',
          subjectId: 'version-a',
          assignedTo: '00000000-0000-4000-8000-000000000099',
        }),
      },
    };
    const drafts = { decideWithinTx: jest.fn() };
    const service = new OutreachReviewTransactionsService(prismaFor(tx) as never, drafts as never);

    await expect(service.decide(ctx, 'review-a', 'approved')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(drafts.decideWithinTx).not.toHaveBeenCalled();
  });

  it('cannot use a non-Outreach review to release a draft', async () => {
    const tx: Tx = {
      reviewRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'review-a',
          surface: 'alert-memo',
          subjectType: 'outreach-draft-version',
          subjectId: 'version-b',
          assignedTo: ctx.userId,
        }),
      },
    };
    const drafts = { decideWithinTx: jest.fn() };
    const service = new OutreachReviewTransactionsService(prismaFor(tx) as never, drafts as never);

    await expect(service.decide(ctx, 'review-a', 'approved')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(drafts.decideWithinTx).not.toHaveBeenCalled();
  });
});
