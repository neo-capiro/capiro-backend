jest.mock('./embedder.js', () => ({
  EMBEDDING_MODEL: 'test-embedding-model',
  embedAndUpsert: jest.fn(),
  embedText: jest.fn().mockResolvedValue([0.1, 0.2]),
  normalize: jest.fn((value: string) => value),
  vectorLiteral: jest.fn(() => '[0.1,0.2]'),
}));

import { Prisma } from '@prisma/client';
import { embedText } from './embedder.js';
import { ClientKbService } from './client-kb.service.js';

describe('ClientKbService.searchWithAccess wall snapshot', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects an unsupported source kind before the tenant query can broaden', async () => {
    const withTenant = jest.fn();
    const service = Object.assign(Object.create(ClientKbService.prototype), {
      prisma: { withTenant },
    }) as ClientKbService;

    await expect(service.searchWithAccess('tenant-a', {
      query: 'capability', clientId: 'client-a', userId: 'user-a', kind: 'other_kind',
    })).rejects.toThrow('kind must be a supported client knowledge source type');
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('rejects non-string kinds before embedding or tenant access', async () => {
    const withTenant = jest.fn();
    const service = Object.assign(Object.create(ClientKbService.prototype), {
      prisma: { withTenant },
    }) as ClientKbService;

    for (const kind of [0, false, {}]) {
      await expect(service.searchWithAccess('tenant-a', {
        query: 'capability', clientId: 'client-a', userId: 'user-a', kind: kind as unknown as string,
      })).rejects.toThrow('kind must be a supported client knowledge source type');
    }
    expect(embedText).not.toHaveBeenCalled();
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('observes a revoked grant in the retrieval transaction and returns no evidence', async () => {
    // Empty authorization rows mean the client is walled and this user has no
    // active grant at the instant the retrieval transaction checks access.
    // There is no separate permission preflight: RepeatableRead binds this
    // decision and the evidence query to one snapshot. Revocations committed
    // after the snapshot starts may still race an in-flight response.
    const wallCheck = jest.fn().mockResolvedValue([]);
    const withTenant = jest.fn(async (
      _tenantId: string,
      callback: (tx: unknown) => unknown,
      _options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => callback({ $queryRawUnsafe: wallCheck }),
    );
    const service = Object.assign(Object.create(ClientKbService.prototype), {
      prisma: { withTenant },
    }) as ClientKbService;

    const result = await service.searchWithAccess('tenant-a', {
      query: 'capability', clientId: 'client-a', userId: 'user-a',
    });

    expect(withTenant).toHaveBeenCalledTimes(1);
    expect(withTenant.mock.calls[0]?.[2]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(wallCheck).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ authorized: false, results: [] });
  });
});
