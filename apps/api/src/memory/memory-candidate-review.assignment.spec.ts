import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCandidateService } from './memory-candidate.service.js';
import { MemoryCandidateReviewService } from './memory-candidate-review.service.js';
import type { MemoryReviewWorkflowService } from './memory-review-workflow.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'admin',
  role: 'user_admin',
};

function withReviewEnabled<T>(work: () => Promise<T>): Promise<T> {
  const before = {
    review: process.env.MEMORY_CLIENT_REVIEW,
    lifecycle: process.env.MEMORY_GOVERNANCE_LIFECYCLE,
    enforce: process.env.MEMORY_GOVERNANCE_ENFORCE,
  };
  process.env.MEMORY_CLIENT_REVIEW = 'enforce';
  process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
  process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
  return work().finally(() => {
    restore('MEMORY_CLIENT_REVIEW', before.review);
    restore('MEMORY_GOVERNANCE_LIFECYCLE', before.lifecycle);
    restore('MEMORY_GOVERNANCE_ENFORCE', before.enforce);
  });
}

describe('MemoryCandidateReviewService assignment authorization', () => {
  it('does not let a walled administrator reassign a guessed candidate id', async () => {
    await withReviewEnabled(async () => {
      const tx = {};
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
        loadCandidateInTx: jest.fn(async () => ({
          id: 'candidate-1',
          tenantId: ctx.tenantId,
          clientId: '33333333-3333-4333-8333-333333333333',
          ownerUserId: '44444444-4444-4444-8444-444444444444',
          proposedByUserId: '44444444-4444-4444-8444-444444444444',
          memoryClass: 'client_steering',
          scope: 'client',
          status: 'pending_review',
          legalHold: false,
          clientStatus: 'active',
        })),
        evaluateInTx: jest.fn(async () => ({
          allowed: false as const,
          reason: 'ethical_wall' as const,
        })),
      } as unknown as MemoryAuthorizationService;
      const assignReviewer = jest.fn();
      const service = new MemoryCandidateReviewService(
        prisma,
        authorization,
        {} as MemoryCandidateService,
        {} as ImmutableMemoryVersionService,
        { assignReviewer } as unknown as MemoryReviewWorkflowService,
      );

      await expect(
        service.assignReviewer(ctx, 'candidate-1', 'reviewer-2', 'Coverage changed.'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(assignReviewer).not.toHaveBeenCalled();
    });
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
