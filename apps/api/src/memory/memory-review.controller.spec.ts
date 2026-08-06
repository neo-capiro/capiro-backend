import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import type { MemoryCandidateReviewService } from './memory-candidate-review.service.js';
import { MemoryReviewController } from './memory-review.controller.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_standard',
  role: 'standard_user',
};

describe('MemoryReviewController', () => {
  it('is a standard-authenticated surface rather than an administrator route', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MemoryReviewController)).toEqual(['standard_user']);
  });

  it('delegates list, request-changes, assignment, and decisions without browser authority facts', async () => {
    const listReviewable = jest.fn(async () => ({ enabled: true, candidates: [] }));
    const requestChanges = jest.fn(async () => ({
      requestId: 'request-1',
      status: 'changes_requested' as const,
      submittedBy: { userId: 'proposer-1', name: 'Pat Proposer' },
      assignedReviewer: { userId: ctx.userId, name: 'Riley Reviewer' },
      decidedBy: { userId: ctx.userId, name: 'Riley Reviewer' },
      feedbackReason: 'Add the source.',
      createdAt: '2026-08-05T20:00:00.000Z',
      decidedAt: '2026-08-05T20:05:00.000Z',
      viewerIsSubmitter: false,
      viewerIsAssignedReviewer: true,
      capabilities: { requestChanges: false, reassign: false },
    }));
    const assignReviewer = jest.fn(async () => ({
      requestId: 'request-1',
      status: 'pending' as const,
      submittedBy: { userId: 'proposer-1', name: 'Pat Proposer' },
      assignedReviewer: { userId: 'reviewer-2', name: 'Alex Reviewer' },
      decidedBy: null,
      feedbackReason: null,
      createdAt: '2026-08-05T20:00:00.000Z',
      decidedAt: null,
      viewerIsSubmitter: false,
      viewerIsAssignedReviewer: false,
      capabilities: { requestChanges: false, reassign: false },
    }));
    const approve = jest.fn(async () => ({
      candidateId: 'candidate-1',
      candidateKind: 'correction' as const,
      outcome: 'activated' as const,
      memoryItemId: 'item-2',
      controllingItemId: 'item-2',
    }));
    const reject = jest.fn(async () => ({
      candidateId: 'candidate-1',
      candidateKind: 'correction' as const,
      outcome: 'rejected' as const,
    }));
    const controller = new MemoryReviewController({
      listReviewable,
      requestChanges,
      assignReviewer,
      approve,
      reject,
    } as unknown as MemoryCandidateReviewService);

    await expect(controller.listCandidates(ctx)).resolves.toEqual({
      enabled: true,
      candidates: [],
    });
    await expect(
      controller.requestChanges(ctx, 'candidate-1', { reason: 'Add the source.' }),
    ).resolves.toMatchObject({
      ok: true,
      candidateId: 'candidate-1',
      workflow: { status: 'changes_requested', feedbackReason: 'Add the source.' },
    });
    await expect(
      controller.assignReviewer(ctx, 'candidate-1', {
        reviewerUserId: 'reviewer-2',
        reason: 'Coverage changed.',
      }),
    ).resolves.toMatchObject({
      ok: true,
      candidateId: 'candidate-1',
      workflow: { assignedReviewer: { userId: 'reviewer-2' } },
    });
    await expect(controller.approveCandidate(ctx, 'candidate-1')).resolves.toEqual({
      ok: true,
      candidateId: 'candidate-1',
      candidateKind: 'correction',
      outcome: 'activated',
      memoryItemId: 'item-2',
      controllingItemId: 'item-2',
    });
    await expect(
      controller.rejectCandidate(ctx, 'candidate-1', { reason: 'Unsupported source.' }),
    ).resolves.toEqual({
      ok: true,
      candidateId: 'candidate-1',
      candidateKind: 'correction',
      outcome: 'rejected',
    });

    expect(listReviewable).toHaveBeenCalledWith(ctx);
    expect(requestChanges).toHaveBeenCalledWith(ctx, 'candidate-1', 'Add the source.');
    expect(assignReviewer).toHaveBeenCalledWith(
      ctx,
      'candidate-1',
      'reviewer-2',
      'Coverage changed.',
    );
    expect(approve).toHaveBeenCalledWith(ctx, 'candidate-1');
    expect(reject).toHaveBeenCalledWith(ctx, 'candidate-1', 'Unsupported source.');
  });
});
