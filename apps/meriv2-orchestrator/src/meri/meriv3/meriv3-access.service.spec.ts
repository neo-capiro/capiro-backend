import {
  MERIV3_TENANT_FLAG,
  MeriV3AccessService,
  meriV3EnvironmentEnabled,
  tenantFlagEnabled,
} from './meriv3-access.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

describe('MeriV3 two-key access (matches the API gate)', () => {
  test('the global switch defaults on and only an explicit off value closes it', () => {
    expect(meriV3EnvironmentEnabled({})).toBe(true);
    expect(meriV3EnvironmentEnabled({ MERIV3_ENABLED: 'true' })).toBe(true);
    for (const value of ['false', 'FALSE', ' false ', '0', 'off', 'no']) {
      expect(meriV3EnvironmentEnabled({ MERIV3_ENABLED: value })).toBe(false);
    }
  });

  test('the tenant flag defaults on and only an explicit false closes it', () => {
    expect(tenantFlagEnabled(null)).toBe(true);
    expect(tenantFlagEnabled({})).toBe(true);
    expect(tenantFlagEnabled({ clioFeatureFlags: { [MERIV3_TENANT_FLAG]: 'false' } })).toBe(true);
    expect(tenantFlagEnabled({ clioFeatureFlags: { [MERIV3_TENANT_FLAG]: true } })).toBe(true);
    expect(tenantFlagEnabled({ clioFeatureFlags: { [MERIV3_TENANT_FLAG]: false } })).toBe(false);
  });

  const prismaFor = (tenant: unknown): PrismaService =>
    ({
      withTenant: async (_id: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ tenant: { findFirst: async () => tenant } }),
    }) as unknown as PrismaService;

  const saved = process.env.MERIV3_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.MERIV3_ENABLED;
    else process.env.MERIV3_ENABLED = saved;
  });

  test('a tenant outside any former slug list is allowed; an explicit false is not', async () => {
    delete process.env.MERIV3_ENABLED;
    process.env.MERIV3_CANARY_TENANT_SLUGS = 'capiro-internal';
    const open = new MeriV3AccessService(prismaFor({ slug: 'brand-new', settings: {} }));
    await expect(open.isAllowed('t-new')).resolves.toBe(true);
    const closed = new MeriV3AccessService(
      prismaFor({ slug: 'revere', settings: { clioFeatureFlags: { [MERIV3_TENANT_FLAG]: false } } }),
    );
    await expect(closed.isAllowed('t-revere')).resolves.toBe(false);
    delete process.env.MERIV3_CANARY_TENANT_SLUGS;
  });

  test('a missing tenant row and the global kill switch both deny', async () => {
    const missing = new MeriV3AccessService(prismaFor(null));
    await expect(missing.isAllowed('t-missing')).resolves.toBe(false);
    process.env.MERIV3_ENABLED = 'false';
    const killed = new MeriV3AccessService(prismaFor({ slug: 'revere', settings: {} }));
    await expect(killed.isAllowed('t-killed')).resolves.toBe(false);
  });
});
