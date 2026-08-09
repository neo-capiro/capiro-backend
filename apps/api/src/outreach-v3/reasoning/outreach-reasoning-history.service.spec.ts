import type { TenantContext } from '@capiro/shared';
import { OutreachReasoningHistoryService } from './outreach-reasoning-history.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
} as TenantContext;

function harness(stateMode: 'capiro_managed' | 'provider_state' = 'capiro_managed') {
  const tx = {
    $queryRaw: jest.fn(async () => [
      {
        id: 'turn-1',
        stateVersion: 2,
        userMessageText: stateMode === 'capiro_managed' ? 'Visible user' : null,
        assistantMessageText: stateMode === 'capiro_managed' ? 'Visible assistant' : null,
        userMessageHash: 'a'.repeat(64),
        assistantMessageHash: 'b'.repeat(64),
        providerResponseId: 'resp_1',
        toolResultRefsJsonb: [],
        proposalIdsJsonb: ['proposal-1'],
        openQuestionsJsonb: [],
        usageJsonb: { totalTokens: 10 },
        latencyMs: 200,
        status: 'succeeded',
        failureCode: null,
        createdAt: new Date('2026-08-08T00:00:00Z'),
      },
    ]),
  };
  const prisma = {
    withTenantUser: jest.fn(async (_tenant: string, _user: string, run: (tx: unknown) => unknown) => run(tx)),
  };
  const repository = {
    getOwnedConversation: jest.fn(async () => ({
      id: '00000000-0000-4000-8000-000000000010',
      sessionId: '00000000-0000-4000-8000-000000000011',
      stateMode,
    })),
  };
  return {
    service: new OutreachReasoningHistoryService(prisma as never, repository as never),
    repository,
    tx,
  };
}

describe('OutreachReasoningHistoryService', () => {
  it('authorizes the conversation before reading turns and returns bounded visible history', async () => {
    const h = harness();
    const rows = await h.service.listTurns(
      ctx,
      '00000000-0000-4000-8000-000000000010',
      500,
    );
    expect(h.repository.getOwnedConversation).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({
      userMessage: 'Visible user',
      assistantMessage: 'Visible assistant',
      providerResponseRef: null,
      proposalIds: ['proposal-1'],
    });
  });

  it('does not fabricate visible message bodies in provider-state mode', async () => {
    const h = harness('provider_state');
    const rows = await h.service.listTurns(
      ctx,
      '00000000-0000-4000-8000-000000000010',
      10,
    );
    expect(rows[0]).toMatchObject({
      userMessage: null,
      assistantMessage: null,
      providerResponseRef: 'resp_1',
    });
  });
});
