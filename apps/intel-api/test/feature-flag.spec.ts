import { ConfigService } from '@nestjs/config';
import {
  FeatureFlagService, HEARING_WATCH_FEATURE, BILL_360_FEATURE, DEFENSE_FUNDING_INTEL_FEATURE,
  DISTRICT_NEXUS_STRATEGIC_FEATURE, DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE,
  DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE, FOLDER_TRACKER_FEATURE,
} from '../src/feature-flags/feature-flag.service.js';

/**
 * SC0: Hearing Watch is gated to the Capiro internal tenant. Verifies the
 * service's allow logic: internal canary defaults only fill missing rows;
 * explicit disabled rows win, and other tenants require an enabled DB row.
 */
describe('FeatureFlagService', () => {
  const CAPIRO = 'tenant_capiro_internal';
  const CLIENT = 'tenant_client_acme';

  function makeService(rows: Array<{ feature: string; tenantId: string; enabled: boolean }>) {
    const tx = {
      featureFlag: {
        findUnique: jest.fn(async ({ where }: { where: { feature_tenantId: { feature: string; tenantId: string } } }) =>
          rows.find(
            (r) => r.feature === where.feature_tenantId.feature && r.tenantId === where.feature_tenantId.tenantId,
          ) ?? null),
        findMany: jest.fn(async ({ where }: { where: { tenantId: string } }) =>
          rows.filter((r) => r.tenantId === where.tenantId)),
      },
    };
    const prisma = { withTenant: jest.fn(async (_tenantId: string, fn: (db: typeof tx) => Promise<unknown>) => fn(tx)) };
    const config = { get: (k: string) => (k === 'CAPIRO_INTERNAL_TENANT_ID' ? CAPIRO : undefined) } as unknown as ConfigService;
    return { service: new FeatureFlagService(prisma as never, config), prisma, tx };
  }

  it('internal Capiro tenant receives the canonical canary defaults when rows are absent', async () => {
    const { service: svc } = makeService([]);
    expect(await svc.isEnabled(HEARING_WATCH_FEATURE, CAPIRO)).toBe(true);
    expect(await svc.enabledFor(CAPIRO)).toEqual({
      [HEARING_WATCH_FEATURE]: true, [BILL_360_FEATURE]: true, [DEFENSE_FUNDING_INTEL_FEATURE]: true,
      [DISTRICT_NEXUS_STRATEGIC_FEATURE]: true, [DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE]: true,
      [DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE]: true,
    });
    expect(await svc.isEnabled(FOLDER_TRACKER_FEATURE, CAPIRO)).toBe(false);
  });

  it('client tenant is DISABLED with no flag row (SC0.1)', async () => {
    const { service: svc } = makeService([]);
    expect(await svc.isEnabled(HEARING_WATCH_FEATURE, CLIENT)).toBe(false);
    expect(await svc.enabledFor(CLIENT)).toEqual({});
  });

  it('client tenant becomes enabled once a row is inserted (SC0.4 flip)', async () => {
    const { service: svc } = makeService([{ feature: HEARING_WATCH_FEATURE, tenantId: CLIENT, enabled: true }]);
    expect(await svc.isEnabled(HEARING_WATCH_FEATURE, CLIENT)).toBe(true);
  });

  it('a disabled row keeps the client off', async () => {
    const { service: svc } = makeService([{ feature: HEARING_WATCH_FEATURE, tenantId: CLIENT, enabled: false }]);
    expect(await svc.isEnabled(HEARING_WATCH_FEATURE, CLIENT)).toBe(false);
  });

  it('reads only the requested tenant through the callback, including explicit disabled rows', async () => {
    const { service, prisma, tx } = makeService([
      { feature: HEARING_WATCH_FEATURE, tenantId: CAPIRO, enabled: false },
      { feature: HEARING_WATCH_FEATURE, tenantId: CLIENT, enabled: true },
    ]);
    expect(await service.isEnabled(HEARING_WATCH_FEATURE, CAPIRO)).toBe(false);
    expect(await service.enabledFor(CAPIRO)).not.toHaveProperty(HEARING_WATCH_FEATURE);
    expect(prisma.withTenant).toHaveBeenCalledTimes(2);
    for (const call of prisma.withTenant.mock.calls) expect(call).toEqual([CAPIRO, expect.any(Function)]);
    expect(tx.featureFlag.findUnique).toHaveBeenCalledWith({ where: { feature_tenantId: { feature: HEARING_WATCH_FEATURE, tenantId: CAPIRO } } });
    expect(tx.featureFlag.findMany).toHaveBeenCalledWith({ where: { tenantId: CAPIRO } });
  });

  it('does not enable an internal fallback when its tenant read fails', async () => {
    const { service, prisma } = makeService([]);
    const failure = new Error('tenant read unavailable');
    prisma.withTenant.mockRejectedValueOnce(failure);
    await expect(service.isEnabled(HEARING_WATCH_FEATURE, CAPIRO)).rejects.toBe(failure);
  });
});
