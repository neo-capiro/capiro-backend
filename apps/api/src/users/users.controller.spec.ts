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
