import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MemoryReviewCompatibilityGuardService } from './memory-review-compatibility-guard.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user',
  role: 'standard_user',
};

function harness(exists: boolean) {
  const queryRaw = jest.fn(async () => [{ exists }]);
  const tx = { $queryRaw: queryRaw };
  const prisma = {
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, work: (value: typeof tx) => unknown) =>
        work(tx),
    ),
  } as unknown as PrismaService;
  return {
    service: new MemoryReviewCompatibilityGuardService(prisma),
    queryRaw,
  };
}

describe('MemoryReviewCompatibilityGuardService', () => {
  it('rejects a governed-memory row from the generic review surface', async () => {
    const h = harness(true);
    await expect(
      h.service.assertNotMemoryReview(
        ctx,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('allows non-memory reviews and filters memory rows from broad lists', async () => {
    const h = harness(false);
    await expect(
      h.service.assertNotMemoryReview(
        ctx,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).resolves.toBeUndefined();
    expect(
      h.service.filterNonMemoryReviews([
        { id: 'a', surface: 'memory' },
        { id: 'b', surface: 'research' },
      ]),
    ).toEqual([{ id: 'b', surface: 'research' }]);
  });
});
