import { describe, expect, it, jest } from '@jest/globals';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import type { TenantContext } from '@capiro/shared';
import type { GovernedMemoryCandidateService } from './governed-memory-candidate.service.js';
import type { OutreachReplyLearningService } from './outreach-reply-learning.service.js';
import { MemoryProposalController } from './memory-proposal.controller.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_standard',
  role: 'standard_user',
};

describe('MemoryProposalController', () => {
  it('uses standard authenticated access rather than administrator elevation', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MemoryProposalController)).toEqual(['standard_user']);
  });

  it('delegates history and withdrawal with only server-resolved context', async () => {
    const listOwnProposals = jest.fn(async () => ({ enabled: true, candidates: [] }));
    const withdraw = jest.fn(async () => undefined);
    const listCandidates = jest.fn(async () => []);
    const propose = jest.fn(async () => ({}));
    const controller = new MemoryProposalController(
      {
        listOwnProposals,
        withdraw,
      } as unknown as GovernedMemoryCandidateService,
      // Reply-backed learning is a separate governed path; this test only
      // covers history/withdrawal delegation, so it must not be exercised.
      { listCandidates, propose } as unknown as OutreachReplyLearningService,
    );

    await expect(controller.listOwnProposals(ctx)).resolves.toEqual({
      enabled: true,
      candidates: [],
    });
    await expect(controller.listOwnProposals(ctx, undefined, '50')).resolves.toEqual({
      enabled: true,
      candidates: [],
    });
    await expect(controller.withdraw(ctx, 'candidate-1')).resolves.toEqual({
      ok: true,
      status: 'withdrawn',
    });
    expect(listOwnProposals).toHaveBeenCalledWith(ctx);
    expect(listOwnProposals).toHaveBeenCalledWith(ctx, { cursor: undefined, limit: '50' });
    expect(withdraw).toHaveBeenCalledWith(ctx, 'candidate-1');
  });
});
