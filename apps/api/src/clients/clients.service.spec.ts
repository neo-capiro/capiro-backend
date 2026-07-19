import { NotFoundException } from '@nestjs/common';
import { ClientsService } from './clients.service.js';

describe('ClientsService.list — archived filtering', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;

  const makeService = () => {
    const tenantTx = {
      client: { findMany: jest.fn(async () => [] as unknown[]) },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (tx: unknown) => Promise<unknown>) =>
        run(tenantTx),
      ),
    };
    // No ASSETS_BUCKET configured → logo signing is skipped (clients list is empty).
    const config = { get: jest.fn(() => undefined) };
    // resolve-on-create dependencies; unused by the list() paths under test.
    const entityResolution = {
      resolveClient: jest.fn(async () => ({ created: 0, autoConfirmed: 0, needsReview: 0 })),
    };
    const prepopulation = {
      prepopulate: jest.fn(async () => ({ ldaClientIds: [], issueCodesAdded: 0 })),
    };
    const samEntity = { enrichGovIds: jest.fn(async () => ({ filled: [], matched: false })) };
    const clientKb = { indexClientProfileFireAndForget: jest.fn() };
    const service = new ClientsService(
      prisma as never,
      config as never,
      entityResolution as never,
      prepopulation as never,
      samEntity as never,
      clientKb as never,
    );
    return { service, tenantTx };
  };

  test('excludes soft-archived ("deleted") clients by default', async () => {
    const { service, tenantTx } = makeService();

    await service.list(ctx);

    expect(tenantTx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1', status: { not: 'archived' } } }),
    );
  });

  test('includes archived clients only when includeArchived is set', async () => {
    const { service, tenantTx } = makeService();

    await service.list(ctx, { includeArchived: true });

    // No status filter is added → only the always-on tenant scope remains (the
    // app role bypasses RLS, so list() puts tenantId in every where clause).
    expect(tenantTx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1' } }),
    );
  });

  test('keeps profileStatus/sectorTag filters alongside the archived exclusion', async () => {
    const { service, tenantTx } = makeService();

    await service.list(ctx, { profileStatus: 'ACTIVE', sectorTag: 'defense' });

    expect(tenantTx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          profileStatus: 'ACTIVE',
          sectorTag: 'defense',
          status: { not: 'archived' },
        },
      }),
    );
  });
});

describe('ClientsService.updateProfileNotes — targeted intakeData merge', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;

  const makeService = (row: Record<string, unknown> | null) => {
    const tenantTx = {
      client: {
        findUnique: jest.fn(async () => row),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...row,
          ...data,
        })),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (tx: unknown) => Promise<unknown>) =>
        run(tenantTx),
      ),
    };
    const config = { get: jest.fn(() => undefined) };
    const entityResolution = { resolveClient: jest.fn() };
    const prepopulation = { prepopulate: jest.fn() };
    const samEntity = { enrichGovIds: jest.fn() };
    const clientKb = { indexClientProfileFireAndForget: jest.fn() };
    const service = new ClientsService(
      prisma as never,
      config as never,
      entityResolution as never,
      prepopulation as never,
      samEntity as never,
      clientKb as never,
    );
    return { service, tenantTx };
  };

  test('merges profileNotes without clobbering sibling intakeData keys', async () => {
    const { service, tenantTx } = makeService({
      id: 'client-1',
      intakeData: { profileNotes: 'old notes', ldaSignals: { totalSpend: 5 }, custom: 'kept' },
      logoS3Key: null,
    });

    await service.updateProfileNotes(ctx, 'client-1', 'new notes');

    expect(tenantTx.client.update).toHaveBeenCalledWith({
      where: { id: 'client-1' },
      data: {
        intakeData: { profileNotes: 'new notes', ldaSignals: { totalSpend: 5 }, custom: 'kept' },
      },
    });
  });

  test('allows clearing notes with an empty string and tolerates null intakeData', async () => {
    const { service, tenantTx } = makeService({
      id: 'client-1',
      intakeData: null,
      logoS3Key: null,
    });

    await service.updateProfileNotes(ctx, 'client-1', '');

    expect(tenantTx.client.update).toHaveBeenCalledWith({
      where: { id: 'client-1' },
      data: { intakeData: { profileNotes: '' } },
    });
  });

  test('throws NotFound for an unknown client (no write attempted)', async () => {
    const { service, tenantTx } = makeService(null);

    await expect(service.updateProfileNotes(ctx, 'missing', 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tenantTx.client.update).not.toHaveBeenCalled();
  });
});
