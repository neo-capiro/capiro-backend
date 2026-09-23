import {
  meriMobileCapabilityEnvironmentEnabled,
  meriMobilePilotTenantIds,
  meriMobileTenantAllowed,
} from './meri-mobile-flags.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Meri mobile rollout flags', () => {
  test('is default closed', () => {
    expect(meriMobileTenantAllowed(tenantId, {})).toBe(false);
    expect(meriMobilePilotTenantIds({})).toEqual(new Set());
    expect(meriMobileCapabilityEnvironmentEnabled('meetings', {})).toBe(false);
  });

  test('requires the fleet switch and canonical tenant allowlist', () => {
    expect(
      meriMobileTenantAllowed(tenantId, {
        MERI_MOBILE_ENABLED: 'true',
        MERI_MOBILE_PILOT_TENANT_IDS: `not-a-uuid, ${tenantId.toUpperCase()}`,
      }),
    ).toBe(true);
    expect(
      meriMobileTenantAllowed('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
        MERI_MOBILE_ENABLED: 'true',
        MERI_MOBILE_PILOT_TENANT_IDS: tenantId,
      }),
    ).toBe(false);
  });

  test('keeps each capability independently default closed', () => {
    expect(
      meriMobileCapabilityEnvironmentEnabled('runs', {
        MERI_MOBILE_RUNS_ENABLED: 'true',
      }),
    ).toBe(true);
    expect(meriMobileCapabilityEnvironmentEnabled('files', { MERI_MOBILE_RUNS_ENABLED: 'true' })).toBe(false);
  });
});
