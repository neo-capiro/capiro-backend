import {
  MERIV3_CHAT_FLAG,
  meriV3CanaryTenantSlugs,
  meriV3ChatActive,
  meriV3EnvironmentEnabled,
  meriV3TenantFlagEnabled,
} from './meriv3-flags.js';

describe('MeriV3 API canary gate', () => {
  const flagged = { clioFeatureFlags: { [MERIV3_CHAT_FLAG]: true } };

  test('requires the literal global switch', () => {
    expect(meriV3EnvironmentEnabled({})).toBe(false);
    expect(meriV3EnvironmentEnabled({ MERIV3_ENABLED: 'true' })).toBe(true);
  });

  test('defaults the allowlist to capiro-internal', () => {
    expect([...meriV3CanaryTenantSlugs({})]).toEqual(['capiro-internal']);
  });

  test('requires an explicit tenant flag', () => {
    expect(meriV3TenantFlagEnabled({})).toBe(false);
    expect(meriV3TenantFlagEnabled(flagged)).toBe(true);
  });

  test('requires all three keys and never broadens on the browser claim', () => {
    const env = { MERIV3_ENABLED: 'true' };
    expect(meriV3ChatActive(flagged, 'capiro-internal', env)).toBe(true);
    expect(meriV3ChatActive(flagged, 'other-tenant', env)).toBe(false);
    expect(meriV3ChatActive({}, 'capiro-internal', env)).toBe(false);
    expect(meriV3ChatActive(flagged, 'capiro-internal', {})).toBe(false);
  });
});
