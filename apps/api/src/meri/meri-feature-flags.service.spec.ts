import { afterEach, describe, expect, test } from '@jest/globals';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import { MERIV2_FLAGS } from '../common/tenant-flags.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Fake PrismaService whose withTenant yields a tenant with the given settings. */
function prismaWithSettings(settings: unknown): PrismaService {
  return {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ tenant: { findFirst: async () => ({ settings }) } }),
  } as unknown as PrismaService;
}

const prismaThatMustNotQuery: PrismaService = {
  withTenant: async () => {
    throw new Error('DB must not be queried when the env kill-switch is off');
  },
} as unknown as PrismaService;

describe('MeriFeatureFlagsService.isMeriV2SurfaceEnabled', () => {
  afterEach(() => {
    delete process.env.MERIV2_ENABLED;
  });

  test('returns false WITHOUT a DB read when MERIV2_ENABLED is off', async () => {
    delete process.env.MERIV2_ENABLED;
    const svc = new MeriFeatureFlagsService(prismaThatMustNotQuery);
    await expect(
      svc.isMeriV2SurfaceEnabled('tenant-1', MERIV2_FLAGS.inEditorAssistant),
    ).resolves.toBe(false);
  });

  test('with env on, defaults to false when the tenant flag is unset', async () => {
    process.env.MERIV2_ENABLED = 'true';
    const svc = new MeriFeatureFlagsService(prismaWithSettings({}));
    await expect(
      svc.isMeriV2SurfaceEnabled('tenant-1', MERIV2_FLAGS.workspaceGen),
    ).resolves.toBe(false);
  });

  test('true only when env on AND the per-tenant flag is on', async () => {
    process.env.MERIV2_ENABLED = 'true';
    const svc = new MeriFeatureFlagsService(
      prismaWithSettings({ clioFeatureFlags: { [MERIV2_FLAGS.inEditorAssistant]: true } }),
    );
    await expect(
      svc.isMeriV2SurfaceEnabled('tenant-1', MERIV2_FLAGS.inEditorAssistant),
    ).resolves.toBe(true);
  });

  // SC0.4: a flip ON->OFF restores prior behavior immediately (no redeploy).
  // The 60s read cache is bypassed by invalidate(tenantId) (the admin flip path),
  // so rollback is sub-second.
  test('flip ON->OFF after invalidate restores prior behavior immediately (SC0.4)', async () => {
    process.env.MERIV2_ENABLED = 'true';
    let flagOn = true;
    const prisma = {
      withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          tenant: {
            findFirst: async () => ({
              settings: { clioFeatureFlags: { [MERIV2_FLAGS.inEditorAssistant]: flagOn } },
            }),
          },
        }),
    } as unknown as PrismaService;
    const svc = new MeriFeatureFlagsService(prisma);

    expect(await svc.isMeriV2SurfaceEnabled('t', MERIV2_FLAGS.inEditorAssistant)).toBe(true);
    // Operator flips the tenant flag OFF and invalidates the cache (the < 5s,
    // no-redeploy rollback). Next read reflects it at once.
    flagOn = false;
    svc.invalidate('t');
    expect(await svc.isMeriV2SurfaceEnabled('t', MERIV2_FLAGS.inEditorAssistant)).toBe(false);

    // Belt-and-suspenders: the env kill-switch alone also forces OFF instantly.
    flagOn = true;
    svc.invalidate('t');
    delete process.env.MERIV2_ENABLED;
    expect(await svc.isMeriV2SurfaceEnabled('t', MERIV2_FLAGS.inEditorAssistant)).toBe(false);
  });
});
