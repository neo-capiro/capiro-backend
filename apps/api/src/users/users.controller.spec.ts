import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { ConfigService } from '@nestjs/config';
import { UsersController } from './users.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AppConfig } from '../config/config.schema.js';

/**
 * Controller-level coverage for GET/PATCH `/me`'s `features.engagementVNext`
 * bit — the Engagement vNext tenant-access gate (dogfood canary,
 * capiro-internal only for now; see tenant-flags.ts's engagementVNextEnabled
 * for the boolean logic itself, which is covered in tenant-flags.spec.ts).
 * None of the sibling flags (strategyPlanner, meetingsV2, ...) have
 * controller-level coverage today either — this locks in the one thing the
 * pure-function test cannot: that the real endpoint actually plumbs the
 * tenant's settings into the helper and surfaces the result under the right
 * key in BOTH handlers that build a `features` object.
 */
describe('UsersController — /me features.engagementVNext', () => {
  const ctx = {
    tenantId: 't1',
    tenantSlug: 'capiro-internal',
    userId: 'u1',
    clerkUserId: 'clerk_1',
    role: 'standard_user',
  } as unknown as TenantContext;

  const USER_ROW = {
    email: 'neo@capiro.ai',
    firstName: 'Neo',
    lastName: 'M',
    title: null,
    emailSignatureHtml: null,
    emailSignatureEnabled: false,
    tourCompletedAt: null,
    legiwatchIntroSeenAt: null,
  };

  function make(settings: unknown) {
    const tx = {
      user: {
        findUnique: jest.fn(async () => USER_ROW),
        update: jest.fn(async () => USER_ROW),
      },
      tenant: {
        findUnique: jest.fn(async () => ({
          name: 'Capiro Internal',
          settings,
          planTier: 'starter',
        })),
      },
      tenantMembership: {
        findUnique: jest.fn(async () => ({ billingAdmin: false })),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (value: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const config = { get: jest.fn(() => false) } as unknown as ConfigService<AppConfig, true>;
    const controller = new UsersController(prisma, config);
    return { controller, tx };
  }

  it('GET /me reports engagementVNext=true once the tenant flag is set', async () => {
    const { controller } = make({ clioFeatureFlags: { 'engagementVNext.enabled': true } });
    const result = await controller.me(ctx);
    expect(result.features.engagementVNext).toBe(true);
  });

  it('GET /me defaults engagementVNext to false — fails closed for a tenant with no flag at all', async () => {
    const { controller } = make({});
    const result = await controller.me(ctx);
    expect(result.features.engagementVNext).toBe(false);
  });

  it('GET /me keeps engagementVNext false when the flag is explicitly false', async () => {
    const { controller } = make({ clioFeatureFlags: { 'engagementVNext.enabled': false } });
    const result = await controller.me(ctx);
    expect(result.features.engagementVNext).toBe(false);
  });

  it('PATCH /me reports the same engagementVNext value as GET /me — both build the same features object', async () => {
    const { controller } = make({ clioFeatureFlags: { 'engagementVNext.enabled': true } });
    const result = await controller.updateMe(ctx, { title: 'VP' });
    expect(result.features.engagementVNext).toBe(true);
  });
});

describe('UsersController — /me features.businessDevelopmentDossier', () => {
  const ctx = {
    tenantId: 't1',
    tenantSlug: 'capiro-internal',
    userId: 'u1',
    clerkUserId: 'clerk_1',
    role: 'standard_user',
  } as unknown as TenantContext;

  const USER_ROW = {
    email: 'neo@capiro.ai',
    firstName: 'Neo',
    lastName: 'M',
    title: null,
    emailSignatureHtml: null,
    emailSignatureEnabled: false,
    tourCompletedAt: null,
    legiwatchIntroSeenAt: null,
  };

  function make(settings: unknown) {
    const tx = {
      user: {
        findUnique: jest.fn(async () => USER_ROW),
        update: jest.fn(async () => USER_ROW),
      },
      tenant: {
        findUnique: jest.fn(async () => ({
          name: 'Capiro Internal',
          settings,
          planTier: 'starter',
        })),
      },
      tenantMembership: {
        findUnique: jest.fn(async () => ({ billingAdmin: false })),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (value: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const config = { get: jest.fn(() => false) } as unknown as ConfigService<AppConfig, true>;
    const controller = new UsersController(prisma, config);
    return { controller, tx };
  }

  it('GET /me reports businessDevelopmentDossier=true when the tenant flag is set', async () => {
    const { controller } = make({
      clioFeatureFlags: { 'businessDevelopment.dossier.enabled': true },
    });
    const result = await controller.me(ctx);
    expect(result.features.businessDevelopmentDossier).toBe(true);
  });

  it('GET /me defaults businessDevelopmentDossier to false (no flag at all)', async () => {
    const { controller } = make({});
    const result = await controller.me(ctx);
    expect(result.features.businessDevelopmentDossier).toBe(false);
  });

  it('GET /me keeps businessDevelopmentDossier false when explicitly false', async () => {
    const { controller } = make({
      clioFeatureFlags: { 'businessDevelopment.dossier.enabled': false },
    });
    const result = await controller.me(ctx);
    expect(result.features.businessDevelopmentDossier).toBe(false);
  });

  it('PATCH /me reports the same businessDevelopmentDossier value as GET /me', async () => {
    const on = make({ clioFeatureFlags: { 'businessDevelopment.dossier.enabled': true } });
    expect((await on.controller.updateMe(ctx, { title: 'VP' })).features.businessDevelopmentDossier).toBe(true);
    const off = make({});
    expect((await off.controller.updateMe(ctx, { title: 'VP' })).features.businessDevelopmentDossier).toBe(false);
  });
});

describe('UsersController — /me features.businessDevelopmentWatch', () => {
  const ctx = {
    tenantId: 't1',
    tenantSlug: 'capiro-internal',
    userId: 'u1',
    clerkUserId: 'clerk_1',
    role: 'standard_user',
  } as unknown as TenantContext;

  const USER_ROW = {
    email: 'neo@capiro.ai',
    firstName: 'Neo',
    lastName: 'M',
    title: null,
    emailSignatureHtml: null,
    emailSignatureEnabled: false,
    tourCompletedAt: null,
    legiwatchIntroSeenAt: null,
  };

  function make(settings: unknown, globalEnabled: boolean) {
    const tx = {
      user: {
        findUnique: jest.fn(async () => USER_ROW),
        update: jest.fn(async () => USER_ROW),
      },
      tenant: {
        findUnique: jest.fn(async () => ({
          name: 'Capiro Internal',
          settings,
          planTier: 'starter',
        })),
      },
      tenantMembership: {
        findUnique: jest.fn(async () => ({ billingAdmin: false })),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (value: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const config = {
      get: jest.fn((key: string) => (key === 'BIZDEV_WATCH_ENABLED' ? globalEnabled : false)),
    } as unknown as ConfigService<AppConfig, true>;
    return new UsersController(prisma, config);
  }

  const settings = (base: boolean, watch: boolean) => ({
    clioFeatureFlags: {
      'businessDevelopment.enabled': base,
      'businessDevelopment.watch.enabled': watch,
    },
  });

  it.each([
    ['global kill switch off', false, true, true],
    ['base tenant gate off', true, false, true],
    ['watch tenant gate off', true, true, false],
  ])('GET /me fails closed when %s', async (_label, global, base, watch) => {
    const result = await make(settings(base, watch), global).me(ctx);
    expect(result.features.businessDevelopmentWatch).toBe(false);
  });

  it('GET and PATCH expose the watch only when all three gates are on', async () => {
    const controller = make(settings(true, true), true);
    expect((await controller.me(ctx)).features.businessDevelopmentWatch).toBe(true);
    expect((await controller.updateMe(ctx, { title: 'VP' })).features.businessDevelopmentWatch).toBe(
      true,
    );
  });
});
