import { NotFoundException } from '@nestjs/common';
import {
  DistrictNexusEconomicFlagGuard,
  RequireDistrictNexusEconomicFeature,
} from './district-nexus-economic-flag.guard.js';
import { DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE } from './district-nexus-economic.types.js';

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
  test('fails closed when no release-3 feature metadata is present', async () => {
    const prisma = { withSystem: jest.fn() };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    const guard = new DistrictNexusEconomicFlagGuard(prisma as never, config as never, reflector as never);
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.withSystem).not.toHaveBeenCalled();
  });

  test('fails closed on a feature-store read error', async () => {
    const prisma = { withSystem: jest.fn().mockRejectedValue(new Error('db unavailable')) };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE),
    };
    const guard = new DistrictNexusEconomicFlagGuard(prisma as never, config as never, reflector as never);
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(NotFoundException);
  });

  test('opens only when the exact tenant/feature row resolves', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) };
    const prisma = { withSystem: jest.fn(async (fn: (arg: typeof tx) => unknown) => fn(tx)) };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE),
    };
    const guard = new DistrictNexusEconomicFlagGuard(prisma as never, config as never, reflector as never);
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  test('the decorator is defined for controller use', () => {
    expect(RequireDistrictNexusEconomicFeature(DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE)).toBeDefined();
  });
});
