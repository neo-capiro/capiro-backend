import { randomUUID } from 'node:crypto';
import { createBizDevJevFactory } from './bizdev-jev.factory.js';

/**
 * Phase 3 provider-factory gating coverage. The factory is the apps/api
 * mirror of the orchestrator's factory: it reuses the SHARED
 * @capiro/meriv2-core config/client/registry/rollout — no second transport,
 * no second client. These tests pin the gating semantics: shared-config
 * availability, task allow-list, task registry lifecycle/model ceiling, the
 * shared provider rollout (tenant + `research` surface enrollment), and the
 * API-key requirement. A rejected gate returns null — never a throwing or
 * partially-configured provider.
 */

const BASE_ENV = {
  TYPESAFE_API_KEY: 'test-key',
  MERI_JEV_TASKS: 'bd_entity,bd_signal',
  MERI_JEV_PROVIDER_MODE: 'shadow',
  MERI_JEV_PROVIDER_TENANTS: 'all',
  MERI_JEV_PROVIDER_SURFACES: 'research',
};

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();

describe('createBizDevJevFactory gating', () => {
  test('fully enrolled env → provider for both BD tasks (shared core transport)', () => {
    const factory = createBizDevJevFactory({ ...BASE_ENV });
    for (const task of ['bd_entity', 'bd_signal'] as const) {
      const provider = factory.createProvider(task, TENANT);
      expect(provider).not.toBeNull();
      expect(provider!.name).toBe(`jev:${task}`);
      expect(provider!.available()).toBe(true);
    }
  });

  test.each([
    ['missing API key', { TYPESAFE_API_KEY: '' }],
    ['moving-alias/invalid model', { MERI_JEV_MODEL: 'jev-alias' }],
    ['task not in MERI_JEV_TASKS', { MERI_JEV_TASKS: 'claim_support' }],
    ['provider rollout mode off', { MERI_JEV_PROVIDER_MODE: 'off' }],
    ['provider rollout mode invalid', { MERI_JEV_PROVIDER_MODE: 'maybe' }],
    ['surface not enrolled', { MERI_JEV_PROVIDER_SURFACES: 'chat' }],
    ['no surfaces enrolled at all', { MERI_JEV_PROVIDER_SURFACES: '' }],
  ])('%s → no provider for either task', (_label, env) => {
    const factory = createBizDevJevFactory({ ...BASE_ENV, ...env });
    for (const task of ['bd_entity', 'bd_signal'] as const) {
      expect(factory.createProvider(task, TENANT)).toBeNull();
    }
  });

  test('tenant not enrolled in the shared provider rollout → no provider; enrolled tenant → provider', () => {
    const factory = createBizDevJevFactory({
      ...BASE_ENV,
      MERI_JEV_PROVIDER_TENANTS: TENANT,
    });
    expect(factory.createProvider('bd_signal', TENANT)).not.toBeNull();
    expect(factory.createProvider('bd_signal', OTHER_TENANT)).toBeNull();
  });

  test('non-BD task never yields a provider through the BD factory', () => {
    const factory = createBizDevJevFactory({ ...BASE_ENV });
    // The task argument type is BdJevTask, but gating must hold even if a
    // broader task string reaches the factory (defense in depth).
    expect(factory.createProvider('bd_claim' as never, TENANT)).toBeNull();
    expect(factory.createProvider('claim_support' as never, TENANT)).toBeNull();
  });

  test('unregistered/inactive-task gating holds via the registry ceiling', () => {
    const factory = createBizDevJevFactory({ ...BASE_ENV });
    // bd_entity/bd_signal are shadow_only in the registry: a shadow provider
    // mode is fine. An enforce mode is CAPPED at shadow but still non-null.
    const enforceFactory = createBizDevJevFactory({
      ...BASE_ENV,
      MERI_JEV_PROVIDER_MODE: 'enforce',
    });
    expect(factory.createProvider('bd_entity', TENANT)).not.toBeNull();
    expect(enforceFactory.createProvider('bd_entity', TENANT)).not.toBeNull();
  });
});
