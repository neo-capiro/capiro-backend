import {
  MERI_PERSISTED_POLICY_PACKS_DISABLED,
  disablePersistedMeriPolicyPackEnforcement,
} from './meri-policy-pack-runtime.js';

describe('Meri persisted policy-pack runtime switch', () => {
  test('overrides stale enforce and shadow deployment values', () => {
    const enforceEnv = { MERI_POLICY_PACK_SOURCE: 'enforce' } as NodeJS.ProcessEnv;
    const shadowEnv = { MERI_POLICY_PACK_SOURCE: 'shadow' } as NodeJS.ProcessEnv;

    disablePersistedMeriPolicyPackEnforcement(enforceEnv);
    disablePersistedMeriPolicyPackEnforcement(shadowEnv);

    expect(MERI_PERSISTED_POLICY_PACKS_DISABLED).toBe(true);
    expect(enforceEnv.MERI_POLICY_PACK_SOURCE).toBe('off');
    expect(shadowEnv.MERI_POLICY_PACK_SOURCE).toBe('off');
  });

  test('sets off when no deployment value exists', () => {
    const env = {} as NodeJS.ProcessEnv;

    disablePersistedMeriPolicyPackEnforcement(env);

    expect(env.MERI_POLICY_PACK_SOURCE).toBe('off');
  });
});
