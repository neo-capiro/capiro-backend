import type { TenantContext } from '@capiro/shared';
import { OutreachReasoningTurnClaimService } from './outreach-reasoning-turn-claim.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
} as TenantContext;

const conversationId = '00000000-0000-4000-8000-000000000010';
const turnId = '00000000-0000-4000-8000-000000000020';

function service(input: { updateCount: number; owned?: boolean }) {
  const tx = {
    $executeRaw: jest.fn(async () => input.updateCount),
    $queryRaw: jest.fn(async () => (input.owned === false ? [] : [{ id: conversationId }])),
  };
  const prisma = {
    withTenantUser: jest.fn(async (_tenant: string, _user: string, run: (tx: unknown) => unknown) => run(tx)),
  };
  return { service: new OutreachReasoningTurnClaimService(prisma as never), tx };
}

describe('OutreachReasoningTurnClaimService', () => {
  it('claims one active conversation turn without a long-lived transaction', async () => {
    const h = service({ updateCount: 1 });
    await expect(h.service.claim(ctx, conversationId, turnId)).resolves.toBeUndefined();
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('returns a retryable conflict when another non-stale turn owns the lease', async () => {
    const h = service({ updateCount: 0, owned: true });
    await expect(h.service.claim(ctx, conversationId, turnId)).rejects.toMatchObject({
      code: 'OUTREACH_REASONING_LIMIT_EXCEEDED',
      httpStatus: 409,
      retryable: true,
    });
  });

  it('does not leak the existence of a foreign or missing conversation', async () => {
    const h = service({ updateCount: 0, owned: false });
    await expect(h.service.claim(ctx, conversationId, turnId)).rejects.toMatchObject({
      code: 'OUTREACH_REASONING_NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('releases only the matching server-owned turn id', async () => {
    const h = service({ updateCount: 1 });
    await expect(h.service.release(ctx, conversationId, turnId)).resolves.toBeUndefined();
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
