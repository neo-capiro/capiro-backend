import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriAuthenticatedConversationScopeService } from './meri-authenticated-conversation-scope.service.js';

jest.mock('../memory/memory-wall.helpers.js', () => ({
  clientMemoryAllowed: jest.fn(),
}));

import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

const wallCheck = jest.mocked(clientMemoryAllowed);

function ctx(tenantId = 'tenant-a', userId = 'user-a'): TenantContext {
  return {
    tenantId,
    userId,
    tenantSlug: 'tenant',
    clerkUserId: `clerk-${userId}`,
    role: 'standard_user',
  } as TenantContext;
}

function make(options?: {
  conversation?: { id: string; clientId: string | null } | null;
  client?: { id: string } | null;
}) {
  const tx = {
    clioConversation: {
      findFirst: jest.fn(async (args: { where: { id: string } }) =>
        options?.conversation !== undefined
          ? options.conversation
          : { id: args.where.id, clientId: args.where.id === 'conv-b' ? 'client-b' : 'client-a' },
      ),
    },
    client: {
      findFirst: jest.fn(async (args: { where: { id: string } }) =>
        options?.client !== undefined ? options.client : { id: args.where.id },
      ),
    },
  };
  const prisma = {
    withTenantUser: jest.fn(async (_tenant: string, _user: string, run: (tx: unknown) => unknown) => run(tx)),
  };
  return { service: new MeriAuthenticatedConversationScopeService(prisma as never), prisma, tx };
}

describe('MeriAuthenticatedConversationScopeService', () => {
  beforeEach(() => wallCheck.mockReset());

  test(
    'returns only persisted wall-checked scope and marks eligibility/version unresolved',
    async () => {
      wallCheck.mockResolvedValue(true);
      const { service, prisma, tx } = make();
      const result = await service.resolve(ctx(), 'conv-a', 'client-a');

      expect(prisma.withTenantUser).toHaveBeenCalledWith(
        'tenant-a',
        'user-a',
        expect.any(Function),
      );
      expect(tx.clioConversation.findFirst).toHaveBeenCalledWith({
        where: { id: 'conv-a', tenantId: 'tenant-a', userId: 'user-a', archivedAt: null },
        select: { id: true, clientId: true },
      });
      expect(wallCheck).toHaveBeenCalledWith(tx, 'tenant-a', 'user-a', 'client-a');
      expect(result).toMatchObject({
        contractVersion: 'meri.authenticated-conversation-scope.v1',
        eligibility: 'unresolved',
        unresolvedVersions: ['capability-catalog', 'final-tool-schema'],
        tenantId: 'tenant-a',
        userId: 'user-a',
        surface: 'full_chat',
        conversationId: 'conv-a',
        clientId: 'client-a',
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).not.toHaveProperty('candidateIds');
    },
  );

  test('does not disclose another actor or tenant conversation', async () => {
    const { service, tx } = make({ conversation: null });
    await expect(service.resolve(ctx('tenant-other', 'user-other'), 'foreign-conversation'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(tx.clioConversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 'tenant-other', userId: 'user-other' }),
    }));
  });

  test('rejects caller client mismatch rather than widening conversation scope', async () => {
    const { service, tx } = make();
    await expect(service.resolve(ctx(), 'conv-a', 'client-other')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.client.findFirst).not.toHaveBeenCalled();
    expect(wallCheck).not.toHaveBeenCalled();
  });

  test('fails closed when current client visibility or wall access is denied', async () => {
    wallCheck.mockResolvedValue(false);
    const { service } = make();
    await expect(service.resolve(ctx(), 'conv-a')).rejects.toBeInstanceOf(ForbiddenException);
  });

  test('represents no-client conversation as null and ignores no external candidate set', async () => {
    const { service, tx } = make({ conversation: { id: 'conv-none', clientId: null } });
    const result = await service.resolve(ctx(), 'conv-none');
    expect(result.clientId).toBeNull();
    expect(tx.client.findFirst).not.toHaveBeenCalled();
    expect(wallCheck).not.toHaveBeenCalled();
  });

  test('rejects stale client focus when conversation scope has drifted to no client', async () => {
    const { service } = make({ conversation: { id: 'conv-none', clientId: null } });
    await expect(service.resolve(ctx(), 'conv-none', 'client-a')).rejects.toBeInstanceOf(ConflictException);
  });

  test('keeps overlapping actor/client snapshots isolated and immutable', async () => {
    wallCheck.mockResolvedValue(true);
    const { service } = make();
    const [a, b] = await Promise.all([
      service.resolve(ctx('tenant-a', 'user-a'), 'conv-a', 'client-a'),
      service.resolve(ctx('tenant-b', 'user-b'), 'conv-b', 'client-b'),
    ]);
    expect(a).not.toBe(b);
    expect(a).toMatchObject({
      tenantId: 'tenant-a',
      userId: 'user-a',
      conversationId: 'conv-a',
      clientId: 'client-a',
    });
    expect(b).toMatchObject({
      tenantId: 'tenant-b',
      userId: 'user-b',
      conversationId: 'conv-b',
      clientId: 'client-b',
    });
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });
});
