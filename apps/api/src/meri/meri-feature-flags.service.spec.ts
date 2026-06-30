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
});
