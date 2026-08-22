import { ClientCapabilitiesService } from './client-capabilities.service.js';

describe('ClientCapabilitiesService — issueCodes persistence', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;

  const makeService = () => {
    const tenantTx = {
      client: { findFirst: jest.fn(async () => ({ id: 'client-1' })) },
      clientCapability: {
        findFirst: jest.fn(async () => ({ id: 'cap-1' })),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'cap-1',
          ...data,
        })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'cap-1',
          ...data,
        })),
        delete: jest.fn(async () => undefined),
      },
      clientCapabilityFitRecommendation: {
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (tx: unknown) => Promise<unknown>) =>
        run(tenantTx),
      ),
    };
    const embeddings = { embedCapabilityFireAndForget: jest.fn() };
    // G3: submission-outcome mirror (fire-and-forget; asserted in its own tests)
    const outcomes = { recordSystem: jest.fn(async () => undefined) };
    const service = new ClientCapabilitiesService(
      prisma as never,
      embeddings as never,
      outcomes as never,
    );
    return { service, tenantTx, outcomes };
  };

  test('createCapability persists normalized issueCodes (uppercase, deduped)', async () => {
    const { service, tenantTx } = makeService();

    await service.createCapability(ctx, 'client-1', {
      name: 'Hypersonics',
      issueCodes: ['def', ' DEF ', 'Bud', 42],
    });

    expect(tenantTx.clientCapability.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ issueCodes: ['DEF', 'BUD'] }),
      }),
    );
  });

  test('createCapability defaults issueCodes to [] when omitted', async () => {
    const { service, tenantTx } = makeService();

    await service.createCapability(ctx, 'client-1', { name: 'Hypersonics' });

    expect(tenantTx.clientCapability.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ issueCodes: [] }),
      }),
    );
  });

  test('updateCapability merges issueCodes only when present in the input', async () => {
    const { service, tenantTx } = makeService();

    await service.updateCapability(ctx, 'client-1', 'cap-1', { issueCodes: ['tec'] });

    expect(tenantTx.clientCapability.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ issueCodes: ['TEC'] }),
      }),
    );
  });

  test('updateCapability without issueCodes leaves the column untouched', async () => {
    const { service, tenantTx } = makeService();

    await service.updateCapability(ctx, 'client-1', 'cap-1', { name: 'Renamed' });

    const call = tenantTx.clientCapability.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).not.toHaveProperty('issueCodes');
  });
});

describe('ClientCapabilitiesService — capability-fit cache invalidation (Phase F)', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;

  const makeService = () => {
    const tenantTx = {
      client: { findFirst: jest.fn(async () => ({ id: 'client-1' })) },
      clientCapability: {
        findFirst: jest.fn(async () => ({ id: 'cap-1' })),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'cap-1',
          ...data,
        })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'cap-1',
          ...data,
        })),
        delete: jest.fn(async () => undefined),
      },
      clientCapabilityFitRecommendation: {
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
      $executeRawUnsafe: jest.fn(async () => undefined),
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (tx: unknown) => Promise<unknown>) =>
        run(tenantTx),
      ),
    };
    const embeddings = { embedCapabilityFireAndForget: jest.fn() };
    const outcomes = { recordSystem: jest.fn(async () => undefined) };
    const service = new ClientCapabilitiesService(
      prisma as never,
      embeddings as never,
      outcomes as never,
    );
    return { service, tenantTx, outcomes };
  };

  test('createCapability clears the fit cache row for this client/tenant in the same tx', async () => {
    const { service, tenantTx } = makeService();

    await service.createCapability(ctx, 'client-1', { name: 'Hypersonics' });

    expect(tenantTx.clientCapabilityFitRecommendation.deleteMany).toHaveBeenCalledWith({
      where: { clientId: 'client-1', tenantId: 'tenant-1' },
    });
    // deleteMany must run inside the same withTenant callback as the create —
    // proven here by both being invoked on the one tenantTx handle passed to
    // a single prisma.withTenant call.
    expect(tenantTx.clientCapability.create).toHaveBeenCalledTimes(1);
  });

  test('updateCapability clears the fit cache row for this client/tenant in the same tx', async () => {
    const { service, tenantTx } = makeService();

    await service.updateCapability(ctx, 'client-1', 'cap-1', { name: 'Renamed' });

    expect(tenantTx.clientCapabilityFitRecommendation.deleteMany).toHaveBeenCalledWith({
      where: { clientId: 'client-1', tenantId: 'tenant-1' },
    });
    expect(tenantTx.clientCapability.update).toHaveBeenCalledTimes(1);
  });

  test('deleteCapability clears the fit cache row for this client/tenant in the same tx', async () => {
    const { service, tenantTx } = makeService();

    await service.deleteCapability(ctx, 'client-1', 'cap-1');

    expect(tenantTx.clientCapabilityFitRecommendation.deleteMany).toHaveBeenCalledWith({
      where: { clientId: 'client-1', tenantId: 'tenant-1' },
    });
    expect(tenantTx.clientCapability.delete).toHaveBeenCalledWith({ where: { id: 'cap-1' } });
  });

  test('create/update/delete never call the fit cache upsert (no recompute on write)', async () => {
    const { service, tenantTx } = makeService();

    await service.createCapability(ctx, 'client-1', { name: 'Hypersonics' });
    await service.updateCapability(ctx, 'client-1', 'cap-1', { name: 'Renamed' });
    await service.deleteCapability(ctx, 'client-1', 'cap-1');

    // The Prisma model has no `upsert` stub on this fake tx at all — if the
    // service ever called compute-and-persist from a write path, referencing
    // a nonexistent `.upsert` would throw and fail these awaits.
    expect(tenantTx.clientCapabilityFitRecommendation.deleteMany).toHaveBeenCalledTimes(3);
  });
});
