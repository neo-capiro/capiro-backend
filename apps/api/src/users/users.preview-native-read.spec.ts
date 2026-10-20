import { describe, expect, it, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config/config.schema.js';
import type { PreviewNativeReadService } from '../auth/preview-native-read.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { UsersController } from './users.controller.js';

describe('UsersController preview native GET /me', () => {
  const ctx = {
    tenantId: 'tenant-1',
    tenantSlug: 'capiro-internal',
    userId: 'user-1',
    clerkUserId: 'clerk-1',
    role: 'standard_user',
  } as unknown as TenantContext;
  const req = { headers: { host: 'first-chat-preview.app-dev.capiro.ai' } } as Request;
  const res = { setHeader: jest.fn() } as unknown as Response;

  function make(enabled: boolean, previewMode: boolean) {
    const tx = {
      user: {
        findUnique: jest.fn(async () => ({
          email: 'member@capiro.ai',
          firstName: 'Member',
          lastName: 'One',
          title: 'Researcher',
          emailSignatureHtml: null,
          emailSignatureEnabled: false,
          tourCompletedAt: null,
          legiwatchIntroSeenAt: null,
          legiwatchPrefs: null,
        })),
      },
      tenant: {
        findUnique: jest.fn(async () => ({
          name: 'Capiro Internal',
          settings: {},
          planTier: 'starter',
        })),
      },
      tenantMembership: { findUnique: jest.fn(async () => ({ billingAdmin: false })) },
    };
    const withTenant = jest.fn(async (_tenantId: string, fn: (value: typeof tx) => unknown) => fn(tx));
    const prisma = { withTenant } as unknown as PrismaService;
    const config = {
      get: jest.fn((key: string) => key === 'PREVIEW_NATIVE_GETS_ENABLED' && enabled),
    } as unknown as ConfigService<AppConfig, true>;
    const mode = jest.fn(() => previewMode);
    const run = jest.fn(async (
      _request: Request,
      _response: Response,
      _context: TenantContext,
      read: (clientIds: readonly string[]) => Promise<unknown>,
    ) => read([]));
    const preview = { mode, run } as unknown as PreviewNativeReadService;
    return { controller: new UsersController(prisma, config, preview), withTenant, mode, run };
  }

  it('runs the existing DTO read inside the native preview authority boundary', async () => {
    const { controller, withTenant, mode, run } = make(true, true);
    const result = await controller.me(ctx, req, res);

    expect(mode).toHaveBeenCalledWith(req, res);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(req, res, ctx, expect.any(Function));
    expect(withTenant).toHaveBeenCalledTimes(1);
    expect(withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
    expect(result.user).toMatchObject({
      id: ctx.userId,
      clerkUserId: ctx.clerkUserId,
      email: 'member@capiro.ai',
      title: 'Researcher',
    });
    expect(result.tenant).toMatchObject({ id: ctx.tenantId, name: 'Capiro Internal' });
  });

  it('keeps the ordinary GET /me DTO unchanged when preview mode is off', async () => {
    const ordinary = make(false, false);
    const preview = make(true, true);
    const ordinaryResult = await ordinary.controller.me(ctx);
    const previewResult = await preview.controller.me(ctx, req, res);

    expect(ordinaryResult).toEqual(previewResult);
    expect(ordinary.run).not.toHaveBeenCalled();
    expect(ordinary.withTenant).toHaveBeenCalledTimes(1);
  });

  const missingTransportCases: Array<[string, Request | undefined, Response | undefined]> = [
    ['request', undefined, res],
    ['response', req, undefined],
    ['both', undefined, undefined],
  ];
  it.each(missingTransportCases)('fails closed before the DTO read when preview is enabled but %s is missing', async (_part, request, response) => {
    const { controller, withTenant, mode, run } = make(true, true);

    await expect(controller.me(ctx, request, response)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mode).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(withTenant).not.toHaveBeenCalled();
  });
});
