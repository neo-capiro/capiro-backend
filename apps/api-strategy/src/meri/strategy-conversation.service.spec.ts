import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StrategyConversationService } from './strategy-conversation.service.js';

describe('conversation replay transaction boundary', () => {
  it('rolls back a unique violation before reading the winning message', async () => {
    const existing = {
      id: 'message-1', tenantId: 'tenant-1', strategyId: 'strategy-1', nodeId: null,
      createdByUserId: 'user-1', clientMessageId: 'request-1', body: 'Move the meeting',
      role: 'user', kind: 'message', state: 'active', attachmentRefs: null, action: null,
      createdAt: new Date('2026-09-06T00:00:00Z'),
    };
    let rolledBack = false;
    const abortedRead = jest.fn(() => { throw new Error('current transaction is aborted'); });
    const insertTx = {
      spStrategy: { findFirst: jest.fn(async () => ({ id: existing.strategyId })) },
      spStrategyChatMessage: {
        create: jest.fn(async () => { throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }); }),
        findFirst: abortedRead,
      },
    };
    const freshRead = jest.fn(async () => {
      expect(rolledBack).toBe(true);
      return existing;
    });
    const prisma = {
      withTenantUser: async (_tenant: string, _user: string, fn: (tx: unknown) => Promise<unknown>) => {
        try { return await fn(insertTx); } catch (err) { rolledBack = true; throw err; }
      },
      withTenant: jest.fn(async (_tenant: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ spStrategyChatMessage: { findFirst: freshRead } })),
    };
    const service = new StrategyConversationService(prisma as unknown as PrismaService);
    const result = await service.appendUserMessage('tenant-1', 'user-1', {
      strategyId: 'strategy-1', nodeId: null, body: 'Move the meeting', clientMessageId: 'request-1',
    });
    expect(result.id).toBe(existing.id);
    expect(abortedRead).not.toHaveBeenCalled();
    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(freshRead).toHaveBeenCalledTimes(1);
  });
});
