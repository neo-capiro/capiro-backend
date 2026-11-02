import type { TenantContext } from '@capiro/shared';
import { OutreachReasoningService } from './outreach-reasoning.service.js';
import { OutreachReasoningError } from './outreach-reasoning.contract.js';

const ctx = { tenantId: 'tenant', userId: 'actor' } as TenantContext;
function harness() {
  const tx = {};
  const prisma = { withTenantUser: jest.fn(async (_tenant, _actor, run) => run(tx)) };
  const repository = { getOwnedConversation: jest.fn(), archiveConversation: jest.fn() };
  const service = new OutreachReasoningService(prisma as never, repository as never);
  return { tx, prisma, repository, service };
}

describe('historical Outreach reasoning records', () => {
  it('reads the exact owned record without exposing private provider continuity', async () => {
    const h = harness();
    h.repository.getOwnedConversation.mockResolvedValue({
      id: 'saved',
      sessionId: 'campaign',
      provider: 'openai',
      model: 'historical-model',
      stateMode: 'capiro_managed',
      reasoningEffort: 'high',
      status: 'active',
      createdAt: 'created',
      lastUsedAt: 'last-used',
      lastResponseId: 'private-provider-id',
    });
    const result = await h.service.getConversation(ctx, 'saved');
    expect(h.prisma.withTenantUser).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      expect.any(Function),
    );
    expect(h.repository.getOwnedConversation).toHaveBeenCalledWith(h.tx, ctx, 'saved');
    expect(result).toMatchObject({ id: 'saved', sessionId: 'campaign', model: 'historical-model' });
    expect(result).not.toHaveProperty('lastResponseId');
    expect(h.service).not.toHaveProperty('respond');
    expect(h.service).not.toHaveProperty('createConversation');
  });
  it('preserves refusal and scoped archive without creating another turn', async () => {
    const h = harness();
    h.repository.getOwnedConversation.mockRejectedValue(
      new OutreachReasoningError('OUTREACH_REASONING_NOT_FOUND', 'not found', 404),
    );
    await expect(h.service.getConversation(ctx, 'foreign')).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect(await h.service.archiveConversation(ctx, 'saved')).toEqual({
      id: 'saved',
      status: 'archived',
    });
    expect(h.repository.archiveConversation).toHaveBeenCalledWith(h.tx, ctx, 'saved');
  });
});
