import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BusinessDevelopmentBriefFlagGuard } from './bizdev-brief.flag.guard.js';

/**
 * Brief flag guard contract (businessDevelopment.brief.enabled, default
 * OFF): fail-closed with the SAME bare NotFoundException for every failure
 * mode — missing tenant context, missing tenant row, flag false/missing/null
 * settings, malformed settings, thrown DB error — indistinguishable from a
 * missing route. Mirrors the Phase 1/2 flag guard specs.
 */
describe('BusinessDevelopmentBriefFlagGuard', () => {
  const tenantId = randomUUID();

  const makeGuard = (tenantRow: unknown, rejectWith?: Error) => {
    const tx = {
      tenant: {
        findUnique: jest.fn(async () => {
          if (rejectWith) throw rejectWith;
          return tenantRow;
        }),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as never;
    return { guard: new BusinessDevelopmentBriefFlagGuard(prisma), tx };
  };

  test('enabled flag passes', async () => {
    const { guard } = makeGuard({
      settings: { clioFeatureFlags: { 'businessDevelopment.brief.enabled': true } },
    });
    await expect(guard.assertEnabledForTenant(tenantId)).resolves.toBe(true);
  });

  test('flag false → identical safe 404', async () => {
    const { guard } = makeGuard({
      settings: { clioFeatureFlags: { 'businessDevelopment.brief.enabled': false } },
    });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('flag missing from settings → identical safe 404 (default off)', async () => {
    const { guard } = makeGuard({ settings: { clioFeatureFlags: {} } });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('Phase 1 + dossier flags on but brief flag off → still 404 (independent canary)', async () => {
    const { guard } = makeGuard({
      settings: {
        clioFeatureFlags: {
          'businessDevelopment.enabled': true,
          'businessDevelopment.dossier.enabled': true,
        },
      },
    });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('settings entirely null → identical safe 404', async () => {
    const { guard } = makeGuard({ settings: null });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('no tenant row → identical safe 404', async () => {
    const { guard } = makeGuard(null);
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('DB error → identical safe 404 (fail closed, never 500)', async () => {
    const { guard } = makeGuard(undefined, new Error('db down'));
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('undefined tenantId (missing context) → identical safe 404', async () => {
    const { guard } = makeGuard({
      settings: { clioFeatureFlags: { 'businessDevelopment.brief.enabled': true } },
    });
    await expect(guard.assertEnabledForTenant(undefined)).rejects.toThrow(NotFoundException);
  });
});
