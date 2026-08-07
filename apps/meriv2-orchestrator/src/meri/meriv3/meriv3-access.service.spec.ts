import {
  MERIV3_TENANT_FLAG,
  meriV3CanarySlugs,
  meriV3EnvironmentEnabled,
  tenantFlagEnabled,
} from './meriv3-access.service.js';

describe('MeriV3 canary access', () => {
  test('global switch is fail-closed', () => {
    expect(meriV3EnvironmentEnabled({})).toBe(false);
    expect(meriV3EnvironmentEnabled({ MERIV3_ENABLED: 'TRUE' })).toBe(false);
    expect(meriV3EnvironmentEnabled({ MERIV3_ENABLED: 'true' })).toBe(true);
  });

  test('defaults the canary allowlist to capiro-internal', () => {
    expect([...meriV3CanarySlugs({})]).toEqual(['capiro-internal']);
    expect([
      ...meriV3CanarySlugs({
        MERIV3_CANARY_TENANT_SLUGS: ' capiro-internal, design-partner-1 ',
      }),
    ]).toEqual(['capiro-internal', 'design-partner-1']);
  });

  test('requires the exact tenant flag to be explicitly true', () => {
    expect(tenantFlagEnabled(null)).toBe(false);
    expect(tenantFlagEnabled({})).toBe(false);
    expect(tenantFlagEnabled({ clioFeatureFlags: { [MERIV3_TENANT_FLAG]: false } })).toBe(
      false,
    );
    expect(tenantFlagEnabled({ clioFeatureFlags: { [MERIV3_TENANT_FLAG]: true } })).toBe(
      true,
    );
  });
});
