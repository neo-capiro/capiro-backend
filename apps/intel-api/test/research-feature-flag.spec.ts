import { ConfigService } from '@nestjs/config';
import { FeatureFlagService } from '../src/feature-flags/feature-flag.service.js';

describe('Phase 7 research requires explicit tenant activation', () => {
  const feature = 'legiwatch_research_v1';
  function service(enabled?: boolean) {
    const rows = enabled === undefined ? [] : [{ feature, tenantId: 'internal', enabled }];
    const db = {
      featureFlag: {
        findUnique: async ({ where }: any) =>
          rows.find(
            (r) =>
              r.feature === where.feature_tenantId.feature &&
              r.tenantId === where.feature_tenantId.tenantId,
          ) ?? null,
        findMany: async ({ where }: any) => rows.filter((r) => r.tenantId === where.tenantId),
      },
    };
    return new FeatureFlagService(
      { withTenant: async (_tenant: string, fn: (tx: typeof db) => unknown) => fn(db) } as never,
      { get: () => 'internal' } as unknown as ConfigService,
    );
  }
  it('keeps internal and client reads off without a row, consistently with UI flags', async () => {
    const flags = service();
    expect(await flags.isEnabled(feature, 'internal')).toBe(false);
    expect(await flags.isEnabled(feature, 'client')).toBe(false);
    expect((await flags.enabledFor('internal'))[feature]).toBeUndefined();
  });
  it('enables only the explicitly selected tenant', async () => {
    const flags = service(true);
    expect(await flags.isEnabled(feature, 'internal')).toBe(true);
    expect((await flags.enabledFor('internal'))[feature]).toBe(true);
    expect(await flags.isEnabled(feature, 'client')).toBe(false);
  });
  it('honors an explicit internal rollback', async () => {
    const flags = service(false);
    expect(await flags.isEnabled(feature, 'internal')).toBe(false);
    expect((await flags.enabledFor('internal'))[feature]).toBeUndefined();
  });
});
