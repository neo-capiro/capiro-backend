import { ROLES_KEY } from '../auth/roles.decorator.js';
import type { TenantContext } from '@capiro/shared';
import type { GovernedMemoryCandidateService } from './governed-memory-candidate.service.js';
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

  it('delegates listing and withdrawal with only server-resolved context', async () => {
    const listOwnPending = jest.fn(async () => ({ enabled: true, candidates: [] }));
    const withdraw = jest.fn(async () => undefined);
    const controller = new MemoryProposalController({
      listOwnPending,
      withdraw,
    } as unknown as GovernedMemoryCandidateService);

    await expect(controller.listOwnPending(ctx)).resolves.toEqual({
      enabled: true,
      candidates: [],
    });
    await expect(controller.withdraw(ctx, 'candidate-1')).resolves.toEqual({
      ok: true,
      status: 'withdrawn',
    });
    expect(listOwnPending).toHaveBeenCalledWith(ctx);
    expect(withdraw).toHaveBeenCalledWith(ctx, 'candidate-1');
  });
});
