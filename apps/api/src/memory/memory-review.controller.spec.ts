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

  it('delegates list and decisions without accepting browser authority facts', async () => {
    const listReviewable = jest.fn(async () => ({ enabled: true, candidates: [] }));
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
      approve,
      reject,
    } as unknown as MemoryCandidateReviewService);

    await expect(controller.listCandidates(ctx)).resolves.toEqual({
      enabled: true,
      candidates: [],
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
    expect(approve).toHaveBeenCalledWith(ctx, 'candidate-1');
    expect(reject).toHaveBeenCalledWith(ctx, 'candidate-1', 'Unsupported source.');
  });
});
