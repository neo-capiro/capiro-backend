import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BusinessDevelopmentWatchFlagGuard } from './bizdev-watch.flag.guard.js';

/**
 * Watch flag guard contract (businessDevelopment.watch.enabled, default
 * OFF): fail-closed with the SAME bare NotFoundException for every failure
 * mode — global env kill-switch off, missing tenant context, missing tenant
 * row, base flag off, watch flag false/missing/null settings, malformed
 * settings, thrown DB error — indistinguishable from a missing route.
 * Mirrors the Phase 1/2/4 flag guard specs.
 */
describe('BusinessDevelopmentWatchFlagGuard', () => {
  const tenantId = randomUUID();

  const makeGuard = (
    tenantRow: unknown,
    opts: { envEnabled?: boolean; rejectWith?: Error } = {},
  ) => {
    const envEnabled = opts.envEnabled ?? true;
    const tx = {
      tenant: {
        findUnique: jest.fn(async () => {
          if (opts.rejectWith) throw opts.rejectWith;
          return tenantRow;
        }),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as never;
    const config = {
      get: jest.fn((_key: string) => envEnabled),
    } as never;
    return { guard: new BusinessDevelopmentWatchFlagGuard(prisma, config), tx };
  };

  const enrolledRow = {
    settings: {
      clioFeatureFlags: {
        'businessDevelopment.enabled': true,
        'businessDevelopment.watch.enabled': true,
      },
    },
  };

  test('global switch on + both tenant flags on passes', async () => {
    const { guard } = makeGuard(enrolledRow);
    await expect(guard.assertEnabledForTenant(tenantId)).resolves.toBe(true);
  });

  test('global env kill-switch off → identical safe 404 even with all tenant flags on', async () => {
    const { guard } = makeGuard(enrolledRow, { envEnabled: false });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('watch flag false → identical safe 404', async () => {
    const { guard } = makeGuard({
      settings: { clioFeatureFlags: { 'businessDevelopment.enabled': true, 'businessDevelopment.watch.enabled': false } },
    });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('watch flag missing from settings → identical safe 404 (default off)', async () => {
    const { guard } = makeGuard({
      settings: { clioFeatureFlags: { 'businessDevelopment.enabled': true } },
    });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('base businessDevelopment.enabled off → identical safe 404 even with watch flag on', async () => {
    const { guard } = makeGuard({
      settings: {
        clioFeatureFlags: {
          'businessDevelopment.enabled': false,
          'businessDevelopment.watch.enabled': true,
        },
      },
    });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('null settings → identical safe 404', async () => {
    const { guard } = makeGuard({ settings: null });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('missing tenant row → identical safe 404', async () => {
    const { guard } = makeGuard(null);
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('missing tenant context → identical safe 404', async () => {
    const { guard } = makeGuard(enrolledRow);
    await expect(guard.assertEnabledForTenant(undefined)).rejects.toThrow(NotFoundException);
  });

  test('Phase 1 + Phase 2/4 flags on but watch flag off → still 404 (independent canary)', async () => {
    const { guard } = makeGuard({
      settings: {
        clioFeatureFlags: {
          'businessDevelopment.enabled': true,
          'businessDevelopment.dossier.enabled': true,
          'businessDevelopment.brief.enabled': true,
        },
      },
    });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('malformed settings object → identical safe 404, never a throw-through', async () => {
    const { guard } = makeGuard({ settings: 'not-an-object' });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('thrown DB error → identical safe 404 (OFF unless proven ON)', async () => {
    const { guard } = makeGuard(enrolledRow, { rejectWith: new Error('connection refused') });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('canActivate reads tenantContext from the request', async () => {
    const { guard } = makeGuard(enrolledRow);
    const req = { tenantContext: { tenantId } };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as never;
    await expect(guard.canActivate(context)).resolves.toBe(true);

    const contextNoTenant = {
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as never;
    await expect(guard.canActivate(contextNoTenant)).rejects.toThrow(NotFoundException);
  });
});
