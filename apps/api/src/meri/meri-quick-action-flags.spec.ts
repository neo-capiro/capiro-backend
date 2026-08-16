import {
  meriQuickActionSkillsEnvironmentEnabled,
  meriQuickActionSkillsTenantSlugs,
} from './meri-feature-flags.service.js';

describe('Meri Quick Action rollout helpers', () => {
  test('the global switch is default-off', () => {
    expect(meriQuickActionSkillsEnvironmentEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('the global switch requires the explicit true literal', () => {
    expect(
      meriQuickActionSkillsEnvironmentEnabled({
        MERI_QUICK_ACTION_SKILLS_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      meriQuickActionSkillsEnvironmentEnabled({
        MERI_QUICK_ACTION_SKILLS_ENABLED: 'TRUE',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  test('the rollout defaults to the internal Capiro tenant', () => {
    expect(meriQuickActionSkillsTenantSlugs({} as NodeJS.ProcessEnv)).toEqual(
      new Set(['capiro-internal']),
    );
  });

  test('tenant slugs are normalized and blank values are discarded', () => {
    expect(
      meriQuickActionSkillsTenantSlugs({
        MERI_QUICK_ACTION_SKILLS_TENANTS: ' Alpha, beta ,,ALPHA ',
      } as NodeJS.ProcessEnv),
    ).toEqual(new Set(['alpha', 'beta']));
  });
});
