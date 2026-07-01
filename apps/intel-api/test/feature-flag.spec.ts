import { ConfigService } from '@nestjs/config';
import { FeatureFlagService, HEARING_WATCH_FEATURE } from '../src/feature-flags/feature-flag.service.js';

/**
 * SC0: Hearing Watch is gated to the Capiro internal tenant. Verifies the
 * service's allow logic: internal tenant always on; others only via an enabled
 * DB row.
 */
describe('FeatureFlagService', () => {
  const CAPIRO = 'tenant_capiro_internal';
  const CLIENT = 'tenant_client_acme';

  function makeService(rows: Array<{ feature: string; tenantId: string; enabled: boolean }>) {
    const prisma = {
      featureFlag: {
        findUnique: async ({ where }: { where: { feature_tenantId: { feature: string; tenantId: string } } }) =>
          rows.find(
            (r) => r.feature === where.feature_tenantId.feature && r.tenantId === where.feature_tenantId.tenantId,
          ) ?? null,
        findMany: async ({ where }: { where: { tenantId: string; enabled: boolean } }) =>
          rows.filter((r) => r.tenantId === where.tenantId && r.enabled === where.enabled),
      },
    } as never;
    const config = { get: (k: string) => (k === 'CAPIRO_INTERNAL_TENANT_ID' ? CAPIRO : undefined) } as unknown as ConfigService;
    return new FeatureFlagService(prisma, config);
  }

  it('internal Capiro tenant is always enabled (no DB row needed)', async () => {
    const svc = makeService([]);
    expect(await svc.isEnabled(HEARING_WATCH_FEATURE, CAPIRO)).toBe(true);
    expect(await svc.enabledFor(CAPIRO)).toEqual({ [HEARING_WATCH_FEATURE]: true });
  });

  it('client tenant is DISABLED with no flag row (SC0.1)', async () => {
    const svc = makeService([]);
    expect(await svc.isEnabled(HEARING_WATCH_FEATURE, CLIENT)).toBe(false);
    expect(await svc.enabledFor(CLIENT)).toEqual({});
  });

  it('client tenant becomes enabled once a row is inserted (SC0.4 flip)', async () => {
    const svc = makeService([{ feature: HEARING_WATCH_FEATURE, tenantId: CLIENT, enabled: true }]);
    expect(await svc.isEnabled(HEARING_WATCH_FEATURE, CLIENT)).toBe(true);
  });

  it('a disabled row keeps the client off', async () => {
    const svc = makeService([{ feature: HEARING_WATCH_FEATURE, tenantId: CLIENT, enabled: false }]);
    expect(await svc.isEnabled(HEARING_WATCH_FEATURE, CLIENT)).toBe(false);
  });
});
