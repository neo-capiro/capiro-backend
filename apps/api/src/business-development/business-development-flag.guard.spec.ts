import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BusinessDevelopmentFlagGuard } from './business-development-flag.guard.js';

/**
 * Flag guard contract: the module is OFF unless we can PROVE it is on. Every
 * failure mode — missing tenant context, missing tenant row, flag false,
 * malformed settings JSON, thrown DB error — must fail closed with the SAME
 * NotFoundException, indistinguishable from a missing route.
 */
describe('BusinessDevelopmentFlagGuard', () => {
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
    return { guard: new BusinessDevelopmentFlagGuard(prisma), tx };
  };

  test('enabled flag passes', async () => {
    const { guard } = makeGuard({
      settings: { clioFeatureFlags: { 'businessDevelopment.enabled': true } },
    });
    await expect(guard.assertEnabledForTenant(tenantId)).resolves.toBe(true);
  });

  test('flag false → identical safe 404', async () => {
    const { guard } = makeGuard({
      settings: { clioFeatureFlags: { 'businessDevelopment.enabled': false } },
    });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('flag missing from settings → identical safe 404 (default off)', async () => {
    const { guard } = makeGuard({ settings: { clioFeatureFlags: {} } });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('settings entirely null → identical safe 404', async () => {
    const { guard } = makeGuard({ settings: null });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('malformed settings (non-object JSON) → identical safe 404', async () => {
    const { guard } = makeGuard({ settings: 'not-an-object' });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('tenant row missing → identical safe 404', async () => {
    const { guard } = makeGuard(null);
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('missing tenant context → identical safe 404', async () => {
    const { guard } = makeGuard({ settings: null });
    await expect(guard.assertEnabledForTenant(undefined)).rejects.toThrow(NotFoundException);
  });

  test('DB error during flag read → identical safe 404 (fail closed)', async () => {
    const { guard } = makeGuard(null, new Error('connection reset'));
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('all failure 404s are indistinguishable (same message)', async () => {
    const messages = new Set<string>();
    for (const setup of [
      makeGuard({ settings: { clioFeatureFlags: { 'businessDevelopment.enabled': false } } }),
      makeGuard(null),
      makeGuard({ settings: 'garbage' }),
      makeGuard(null, new Error('db down')),
    ]) {
      try {
        await setup.guard.assertEnabledForTenant(tenantId);
        throw new Error('expected NotFoundException');
      } catch (e) {
        if (e instanceof NotFoundException) messages.add(e.message);
        else throw e;
      }
    }
    expect(messages.size).toBe(1);
  });

  test('reads the tenant row under withTenant with the caller tenant id', async () => {
    const { guard, tx } = makeGuard({
      settings: { clioFeatureFlags: { 'businessDevelopment.enabled': true } },
    });
    await guard.assertEnabledForTenant(tenantId);
    expect(tx.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: tenantId },
      select: { settings: true },
    });
  });
});
