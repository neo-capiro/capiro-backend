import {
  MERIV3_CHAT_FLAG,
  meriV3ChatActive,
  meriV3EnvironmentEnabled,
  meriV3TenantFlagEnabled,
} from './meriv3-flags.js';

describe('MeriV3 two-key gate', () => {
  const off = { clioFeatureFlags: { [MERIV3_CHAT_FLAG]: false } };
  const on = { clioFeatureFlags: { [MERIV3_CHAT_FLAG]: true } };

  test('the global switch defaults on and only an explicit off value closes it', () => {
    expect(meriV3EnvironmentEnabled({})).toBe(true);
    expect(meriV3EnvironmentEnabled({ MERIV3_ENABLED: '' })).toBe(true);
    expect(meriV3EnvironmentEnabled({ MERIV3_ENABLED: 'true' })).toBe(true);
    for (const value of ['false', 'FALSE', ' false ', '0', 'off', 'no']) {
      expect(meriV3EnvironmentEnabled({ MERIV3_ENABLED: value })).toBe(false);
    }
  });

  test('the tenant flag defaults on and only an explicit false closes it', () => {
    expect(meriV3TenantFlagEnabled(undefined)).toBe(true);
    expect(meriV3TenantFlagEnabled({})).toBe(true);
    expect(meriV3TenantFlagEnabled({ clioFeatureFlags: [] })).toBe(true);
    expect(meriV3TenantFlagEnabled({ clioFeatureFlags: { [MERIV3_CHAT_FLAG]: 'false' } })).toBe(
      true,
    );
    expect(meriV3TenantFlagEnabled(on)).toBe(true);
    expect(meriV3TenantFlagEnabled(off)).toBe(false);
  });

  test('either key closes chat; no slug allow-list exists', () => {
    expect(meriV3ChatActive({}, {})).toBe(true);
    expect(meriV3ChatActive(on, { MERIV3_ENABLED: 'true' })).toBe(true);
    expect(meriV3ChatActive(off, { MERIV3_ENABLED: 'true' })).toBe(false);
    expect(meriV3ChatActive(on, { MERIV3_ENABLED: 'false' })).toBe(false);
    expect(
      meriV3ChatActive(on, { MERIV3_ENABLED: 'true', MERIV3_CANARY_TENANT_SLUGS: 'other' }),
    ).toBe(true);
  });
});
