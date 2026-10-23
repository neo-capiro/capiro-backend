import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { GRANTS_GOV_APPLICANT_TYPES, GRANTS_GOV_UNRESTRICTED_APPLICANTS } from '@capiro/shared';
import { ClientsController } from './clients.controller.js';
import { ClientsService } from './clients.service.js';

// Keep real client writers and DTOs; network/indexing collaborators are not part
// of this validation contract and must never execute during these tests.
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../intelligence/entity-resolution.service.js', () => ({
  EntityResolutionService: class {},
}));
jest.mock('../intelligence/client-prepopulation.service.js', () => ({
  ClientPrepopulationService: class {},
}));
jest.mock('../intelligence/sam-entity.service.js', () => ({
  SamEntityEnrichmentService: class {},
}));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: class {} }));

describe('client funding profile API writers', () => {
  const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', clerkUserId: 'user_synthetic', role: 'user_admin' } as never;
  const smallBusiness = GRANTS_GOV_APPLICANT_TYPES[13];

  function setup(existing: Record<string, unknown> | null = { applicantTypes: [] }) {
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
        const sql = parts.join('?');
        if (sql.includes('FOR SHARE OF tm, u')) return [{ role: 'user_admin' }];
        if (sql.includes('account_owner_version')) return [{ version: 0, primary: null }];
        if (sql.includes('client_memory_access')) return [];
        return [{ billingStatus: 'comped', clientSlots: 0, ldaRegistrantId: null }];
      }),
      $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
      tenantMembership: { findFirst: jest.fn(async () => ({ role: 'user_admin' })) },
      tenant: {
        findUnique: jest.fn(async () => ({ billingStatus: 'comped', ldaRegistrantId: null })),
      },
      client: {
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
        findFirst: jest.fn(async () => existing),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: '33333333-3333-4333-8333-333333333333',
          logoS3Key: null,
          ...data,
        })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: '33333333-3333-4333-8333-333333333333',
          name: 'Example',
          logoS3Key: null,
          ...existing,
          ...data,
        })),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenant: string, work: (value: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    };
    const config = { get: jest.fn(() => undefined) };
    const resolver = { resolveClient: jest.fn(async () => ({})) };
    const prepopulation = { prepopulate: jest.fn(async () => ({})) };
    const sam = { enrichGovIds: jest.fn(async () => ({})) };
    const kb = { indexClientProfileFireAndForget: jest.fn() };
    const service = new ClientsService(
      prisma as never,
      config as never,
      resolver as never,
      prepopulation as never,
      sam as never,
      kb as never,
    );
    return { service, tx, prisma };
  }

  test('create validates before any database writes and saves normalized priorities', async () => {
    const { service, tx, prisma } = setup();
    await expect(
      service.create(ctx, { name: 'Bad', intakeData: { fundingPriorities: 'not a list' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Repair (bizdev Phase 1): funding-profile validation now lives inside
    // ClientsService.createInTransaction, so the transaction DOES open — but
    // the invalid profile must still abort before ANY client row is written.
    expect(tx.client.create).not.toHaveBeenCalled();
    await service.create(ctx, {
      name: 'Example',
      applicantTypes: [smallBusiness],
      intakeData: { custom: 'kept', fundingPriorities: ['  Remote sensing demonstrations  '] },
    });
    expect(tx.client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicantTypes: [smallBusiness],
          intakeData: { custom: 'kept', fundingPriorities: ['Remote sensing demonstrations'] },
        }),
      }),
    );
  });

  test('bulk import rejects invalid rows and persists organization types on valid rows', async () => {
    const { service, tx } = setup();
    const result = await service.bulkImport(ctx, [
      { name: 'Source rule', applicantTypes: [GRANTS_GOV_UNRESTRICTED_APPLICANTS] },
      { name: 'Bad priorities', intakeData: { fundingPriorities: [''] } },
      {
        name: 'Good',
        applicantTypes: [smallBusiness],
        intakeData: { fundingPriorities: [' Ground vehicle trials '] },
      },
    ]);
    expect(result.created).toBe(1);
    expect(result.errors.map((error) => error.row)).toEqual([0, 1]);
    expect(tx.client.create).toHaveBeenCalledTimes(1);
    expect(tx.client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicantTypes: [smallBusiness],
          intakeData: { fundingPriorities: ['Ground vehicle trials'] },
        }),
      }),
    );
  });

  test('update allows existing legacy labels, rejects additions and accepts removal', async () => {
    const legacy = 'Unknown historical label';
    const { service, tx } = setup({ applicantTypes: [legacy], uei: null });
    await service.update(ctx, '33333333-3333-4333-8333-333333333333', {
      applicantTypes: [legacy, smallBusiness],
      intakeData: { custom: 'retained by editor' },
    });
    expect(tx.client.update).toHaveBeenLastCalledWith({
      where: { id: '33333333-3333-4333-8333-333333333333', tenantId: '11111111-1111-4111-8111-111111111111' },
      data: {
        applicantTypes: [legacy, smallBusiness],
        intakeData: { custom: 'retained by editor' },
      },
    });
    await expect(
      service.update(ctx, '33333333-3333-4333-8333-333333333333', { applicantTypes: [GRANTS_GOV_UNRESTRICTED_APPLICANTS] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(ctx, '33333333-3333-4333-8333-333333333333', { intakeData: { fundingPriorities: [3] } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.client.update).toHaveBeenCalledTimes(1);
    await service.update(ctx, '33333333-3333-4333-8333-333333333333', { applicantTypes: [], intakeData: {} });
    expect(tx.client.update).toHaveBeenLastCalledWith({
      where: { id: '33333333-3333-4333-8333-333333333333', tenantId: '11111111-1111-4111-8111-111111111111' },
      data: { applicantTypes: [], intakeData: {} },
    });
  });

  test('reads legacy organization values within the active tenant and rejects a missing client', async () => {
    const { service, tx } = setup(null);
    await expect(
      service.update(ctx, '44444444-4444-4444-8444-444444444444', { applicantTypes: [smallBusiness] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.client.findFirst).toHaveBeenCalledWith({
      where: { id: '44444444-4444-4444-8444-444444444444', tenantId: '11111111-1111-4111-8111-111111111111' },
      select: {
        uei: true,
        name: true,
        applicantTypes: true,
        intakeData: true,
        naicsCodes: true,
        setAsideCertifications: true,
      },
    });
    expect(tx.client.update).not.toHaveBeenCalled();
  });

  test('actual route DTOs reject new source rules and permit legacy updates for service validation', () => {
    const createDto = Reflect.getMetadata(
      'design:paramtypes',
      ClientsController.prototype,
      'create',
    )[1];
    const updateDto = Reflect.getMetadata(
      'design:paramtypes',
      ClientsController.prototype,
      'update',
    )[2];
    const bulkDto = Reflect.getMetadata(
      'design:paramtypes',
      ClientsController.prototype,
      'bulkImport',
    )[1];
    expect(
      validateSync(
        plainToInstance(createDto, {
          name: 'Example',
          applicantTypes: [GRANTS_GOV_UNRESTRICTED_APPLICANTS],
        }),
      ),
    ).toHaveLength(1);
    expect(
      validateSync(
        plainToInstance(createDto, { name: 'Example', applicantTypes: [smallBusiness] }),
      ),
    ).toHaveLength(0);
    expect(
      validateSync(plainToInstance(updateDto, { applicantTypes: ['Unknown historical label'] })),
    ).toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(bulkDto, {
          rows: [{ name: 'Example', applicantTypes: [GRANTS_GOV_UNRESTRICTED_APPLICANTS] }],
        }),
      ),
    ).toHaveLength(1);
  });
});
