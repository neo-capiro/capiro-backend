jest.mock('../prisma/prisma.service.js', () => ({
  PrismaService: class PrismaService {},
}));

import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  meriQuickActionSkillsEnvironmentEnabled,
  meriQuickActionSkillsTenantEnabled,
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

  test('the rollout defaults to every tenant when no carve-out is configured', () => {
    expect(meriQuickActionSkillsTenantSlugs({} as NodeJS.ProcessEnv)).toEqual(
      new Set(['*']),
    );
  });

  test('tenant slugs are normalized and blank values are discarded', () => {
    expect(
      meriQuickActionSkillsTenantSlugs({
        MERI_QUICK_ACTION_SKILLS_TENANTS: ' Alpha, beta ,,ALPHA ',
      } as NodeJS.ProcessEnv),
    ).toEqual(new Set(['alpha', 'beta']));
  });

  test('the wildcard cohort admits every non-empty tenant slug', () => {
    expect(meriQuickActionSkillsTenantEnabled('maven', new Set(['*']))).toBe(true);
    expect(meriQuickActionSkillsTenantEnabled('new-design-partner', new Set(['*']))).toBe(true);
    expect(meriQuickActionSkillsTenantEnabled('', new Set(['*']))).toBe(false);
  });

  test('an explicit cohort remains an available rollback carve-out', () => {
    const cohort = new Set(['capiro-internal', 'maven']);
    expect(meriQuickActionSkillsTenantEnabled('MAVEN', cohort)).toBe(true);
    expect(meriQuickActionSkillsTenantEnabled('revere', cohort)).toBe(false);
  });

  test('the service fails closed when tenant settings cannot be read', async () => {
    const priorEnabled = process.env.MERI_QUICK_ACTION_SKILLS_ENABLED;
    const priorTenants = process.env.MERI_QUICK_ACTION_SKILLS_TENANTS;
    process.env.MERI_QUICK_ACTION_SKILLS_ENABLED = 'true';
    process.env.MERI_QUICK_ACTION_SKILLS_TENANTS = '*';
    const prisma = {
      withTenant: async () => {
        throw new Error('database unavailable');
      },
    } as unknown as PrismaService;

    try {
      await expect(
        new MeriFeatureFlagsService(prisma).isMeriQuickActionSkillsEnabled('tenant-1', 'maven'),
      ).resolves.toBe(false);
    } finally {
      if (priorEnabled === undefined) delete process.env.MERI_QUICK_ACTION_SKILLS_ENABLED;
      else process.env.MERI_QUICK_ACTION_SKILLS_ENABLED = priorEnabled;
      if (priorTenants === undefined) delete process.env.MERI_QUICK_ACTION_SKILLS_TENANTS;
      else process.env.MERI_QUICK_ACTION_SKILLS_TENANTS = priorTenants;
    }
  });
});
