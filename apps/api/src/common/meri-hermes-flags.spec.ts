import {
  MERI_HERMES_RUNTIME_FLAG,
  meriHermesConfigurationError,
  meriHermesEnvironmentEnabled,
  meriHermesPilotTenantIds,
  meriHermesRuntimeActive,
  meriHermesRuntimeConfig,
  meriHermesTenantFlagEnabled,
} from './meri-hermes-flags.js';

const PILOT_ID = '17b63099-bc0f-4ac5-b596-496161e9481e';
const OTHER_ID = 'c60da102-8c0e-4590-a356-686784f7c51f';
const flagged = { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: true } };

describe('Meri Hermes pilot gate', () => {
  test('requires the literal global switch', () => {
    expect(meriHermesEnvironmentEnabled({})).toBe(false);
    expect(meriHermesEnvironmentEnabled({ MERI_HERMES_ENABLED: 'yes' })).toBe(false);
    expect(meriHermesEnvironmentEnabled({ MERI_HERMES_ENABLED: 'true' })).toBe(true);
  });

  test('the tenant allowlist defaults to EMPTY and ignores non-UUID entries such as slugs', () => {
    expect([...meriHermesPilotTenantIds({})]).toEqual([]);
    expect([
      ...meriHermesPilotTenantIds({
        MERI_HERMES_PILOT_TENANT_IDS: `capiro-internal, ${PILOT_ID.toUpperCase()}`,
      }),
    ]).toEqual([PILOT_ID]);
  });

  test('requires an explicit per-tenant true (never a default-on)', () => {
    expect(meriHermesTenantFlagEnabled({})).toBe(false);
    expect(
      meriHermesTenantFlagEnabled({ clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: 'true' } }),
    ).toBe(false);
    expect(meriHermesTenantFlagEnabled(flagged)).toBe(true);
  });

  test('all three keys must be open and only the server-resolved canonical id counts', () => {
    const env = { MERI_HERMES_ENABLED: 'true', MERI_HERMES_PILOT_TENANT_IDS: PILOT_ID };
    expect(meriHermesRuntimeActive(flagged, PILOT_ID, env)).toBe(true);
    expect(meriHermesRuntimeActive(flagged, OTHER_ID, env)).toBe(false);
    expect(meriHermesRuntimeActive({}, PILOT_ID, env)).toBe(false);
    expect(meriHermesRuntimeActive(flagged, PILOT_ID, { MERI_HERMES_ENABLED: 'true' })).toBe(false);
    expect(
      meriHermesRuntimeActive(flagged, PILOT_ID, { MERI_HERMES_PILOT_TENANT_IDS: PILOT_ID }),
    ).toBe(false);
  });

  test('a spoofed tenant claim (slug or arbitrary string) cannot open the gate', () => {
    const env = { MERI_HERMES_ENABLED: 'true', MERI_HERMES_PILOT_TENANT_IDS: PILOT_ID };
    expect(meriHermesRuntimeActive(flagged, 'capiro-internal', env)).toBe(false);
    expect(meriHermesRuntimeActive(flagged, `${PILOT_ID} OR 1=1`, env)).toBe(false);
    expect(meriHermesRuntimeActive(flagged, '', env)).toBe(false);
    expect(meriHermesRuntimeActive(flagged, undefined, env)).toBe(false);
  });

  test('configuration problems are reported, never hidden', () => {
    const empty = meriHermesRuntimeConfig({});
    expect(empty.runtimeUrl).toBeNull();
    expect(meriHermesConfigurationError(empty)).toMatch(/MERI_HERMES_RUNTIME_URL/);
    const noKey = meriHermesRuntimeConfig({ MERI_HERMES_RUNTIME_URL: 'http://hermes:8642/' });
    expect(noKey.runtimeUrl).toBe('http://hermes:8642');
    expect(meriHermesConfigurationError(noKey)).toMatch(/MERI_HERMES_API_KEY/);
    const shortSigning = meriHermesRuntimeConfig({
      MERI_HERMES_RUNTIME_URL: 'http://hermes:8642',
      MERI_HERMES_API_KEY: 'k',
      MERI_HERMES_BROKER_SIGNING_KEY: 'short',
    });
    expect(meriHermesConfigurationError(shortSigning)).toMatch(/SIGNING_KEY/);
    const ok = meriHermesRuntimeConfig({
      MERI_HERMES_RUNTIME_URL: 'http://hermes:8642',
      MERI_HERMES_API_KEY: 'k',
      MERI_HERMES_BROKER_SIGNING_KEY: 'x'.repeat(32),
      MERI_HERMES_REQUEST_TIMEOUT_MS: '5000',
    });
    expect(meriHermesConfigurationError(ok)).toBeNull();
    expect(ok.requestTimeoutMs).toBe(5000);
    expect(ok.apiKeyConfigured).toBe(true);
  });
});
