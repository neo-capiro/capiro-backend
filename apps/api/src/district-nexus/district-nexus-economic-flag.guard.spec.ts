import { NotFoundException } from '@nestjs/common';
import {
  DistrictNexusEconomicFlagGuard,
  RequireDistrictNexusEconomicFeature,
} from './district-nexus-economic-flag.guard.js';
import { DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE } from './district-nexus-economic.types.js';
import { DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE } from './district-nexus-economic.types.js';
import { DISTRICT_NEXUS_FEATURE } from './district-nexus-flag.guard.js';

function context(tenantId = 'tenant-1') {
  return {
    getHandler: () => function handler() {},
    getClass: () => function Controller() {},
    switchToHttp: () => ({
      getRequest: () => ({ tenantContext: { tenantId } }),
    }),
  } as never;
}

describe('DistrictNexusEconomicFlagGuard', () => {
  test('configured internal tenants still consult explicit parent/child rows and honor a denial', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const prisma = {
      withSystem: jest.fn(async (fn: (arg: typeof tx) => unknown) => fn(tx)),
    };
    const guard = new DistrictNexusEconomicFlagGuard(
      prisma as never,
      { get: () => 'tenant-1' } as never,
      {
        getAllAndOverride: () => DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE,
      } as never,
    );
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.withSystem).toHaveBeenCalledTimes(1);
    const [strings, ...values] = tx.$queryRaw.mock.calls[0]!;
    expect(strings.join('?')).toContain('COALESCE');
    expect(strings.join('?')).not.toMatch(/tenant_id\s*::\s*uuid/);
    expect(values).toEqual(
      expect.arrayContaining([
        DISTRICT_NEXUS_FEATURE,
        DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE,
        'tenant-1',
      ]),
    );
  });
  test('configured internal tenants fail closed when the flag store is unavailable', async () => {
    const guard = new DistrictNexusEconomicFlagGuard(
      {
        withSystem: jest.fn().mockRejectedValue(new Error('offline')),
      } as never,
      { get: () => 'tenant-1' } as never,
      {} as never,
    );
    await expect(
      guard.assertEnabledForTenant('tenant-1', DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  test('fails closed when no release-3 feature metadata is present', async () => {
    const prisma = { withSystem: jest.fn() };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    };
    const guard = new DistrictNexusEconomicFlagGuard(
      prisma as never,
      config as never,
      reflector as never,
    );
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.withSystem).not.toHaveBeenCalled();
  });

  test('fails closed on a feature-store read error', async () => {
    const prisma = {
      withSystem: jest.fn().mockRejectedValue(new Error('db unavailable')),
    };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE),
    };
    const guard = new DistrictNexusEconomicFlagGuard(
      prisma as never,
      config as never,
      reflector as never,
    );
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(NotFoundException);
  });

  test('opens only when the exact tenant/feature row resolves', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) };
    const prisma = {
      withSystem: jest.fn(async (fn: (arg: typeof tx) => unknown) => fn(tx)),
    };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE),
    };
    const guard = new DistrictNexusEconomicFlagGuard(
      prisma as never,
      config as never,
      reflector as never,
    );
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  test('the decorator is defined for controller use', () => {
    expect(
      RequireDistrictNexusEconomicFeature(DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE),
    ).toBeDefined();
  });
});
