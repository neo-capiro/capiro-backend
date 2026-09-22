import { describe, expect, it } from '@jest/globals';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
} from './capability-rollout';

const TENANT = '17b63099-bc0f-4ac5-b596-496161e9481e';
const OTHER = 'c60da102-8c0e-4590-a356-686784f7c51f';
const capability = 'TEST';

function resolve(
  mode: string,
  tenants: string,
  surfaces: string,
  tenantId: string | null = TENANT,
  surface: 'chat' | 'strategy' = 'chat',
) {
  const env: CapabilityRolloutEnvironment = {
    MERI_TEST_MODE: mode,
    MERI_TEST_TENANTS: tenants,
    MERI_TEST_SURFACES: surfaces,
  };
  return resolveCapabilityRollout({ capability, env, tenantId, surface });
}

describe('capability rollout', () => {
  it.each([
    { mode: 'off', tenants: TENANT, surfaces: 'chat', tenantId: TENANT, expected: 'off' },
    { mode: 'shadow', tenants: TENANT, surfaces: 'chat', tenantId: TENANT, expected: 'shadow' },
    { mode: 'enforce', tenants: TENANT, surfaces: 'chat', tenantId: TENANT, expected: 'enforce' },
    { mode: 'enforce', tenants: 'all', surfaces: 'chat', tenantId: OTHER, expected: 'enforce' },
    { mode: 'enforce', tenants: TENANT, surfaces: 'chat', tenantId: OTHER, expected: 'off' },
    { mode: 'enforce', tenants: TENANT, surfaces: 'strategy', tenantId: TENANT, expected: 'off' },
    { mode: 'enforce', tenants: TENANT, surfaces: 'bogus', tenantId: TENANT, expected: 'off' },
  ])(
    'mode $mode, tenants $tenants, surfaces $surfaces resolves to $expected',
    ({ mode, tenants, surfaces, tenantId, expected }) => {
      expect(resolve(mode, tenants, surfaces, tenantId).mode).toBe(expected);
    },
  );

  it('fails closed for blank, unknown, or incomplete configuration', () => {
    expect(resolve('', TENANT, 'chat').mode).toBe('off');
    expect(resolve('enabled', TENANT, 'chat').reasons).toContain('invalid_mode');
    expect(resolve('enforce', '', 'chat').reasons).toContain('tenant_not_enrolled');
    expect(resolve('enforce', TENANT, '').reasons).toContain('surface_not_enrolled');
    expect(resolve('enforce', TENANT, 'chat', null).mode).toBe('off');
  });

  it('accepts mixed-case canonical UUIDs and comma/space token separators', () => {
    expect(resolve(' ENFORCE ', `${OTHER}, ${TENANT.toUpperCase()}`, 'strategy chat').mode).toBe(
      'enforce',
    );
  });

  it('ignores and reports malformed tenant and surface tokens deterministically', () => {
    const result = resolve('enforce', `capiro-internal,${TENANT}`, 'bogus,chat');
    expect(result.mode).toBe('enforce');
    expect(result.reasons).toEqual(['invalid_tenant:capiro-internal', 'invalid_surface:bogus']);
    expect(
      validateCapabilityRolloutConfig({
        capability,
        env: {
          MERI_TEST_MODE: 'enforce',
          MERI_TEST_TENANTS: `capiro-internal,${TENANT}`,
          MERI_TEST_SURFACES: 'bogus,chat',
        },
      }),
    ).toEqual({
      ok: false,
      issues: ['invalid_tenant:capiro-internal', 'invalid_surface:bogus'],
    });
  });

  it('reports blank mode but permits deliberately empty allowlists', () => {
    expect(validateCapabilityRolloutConfig({ capability, env: {} })).toEqual({
      ok: false,
      issues: ['invalid_mode'],
    });
    expect(
      validateCapabilityRolloutConfig({ capability, env: { MERI_TEST_MODE: 'off' } }),
    ).toEqual({ ok: true, issues: [] });
  });
});
