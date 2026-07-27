// Phase E (remediation plan §3.e3/e7) — Microsoft disconnect: tear down Graph
// subscriptions (best-effort), then delete the connection. Ownership-gated,
// works at any status, and NOT symmetric with Google (no reachable per-app
// grant-revoke endpoint for Microsoft with our scopes).

import { describe, expect, test } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EngagementProvider } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClientAssociationService } from '../client-association.service.js';
import { TokenCryptoService } from './token-crypto.service.js';
import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';
import { MicrosoftOAuthService } from './microsoft-oauth.service.js';

// MicrosoftOAuthService now injects MicrosoftGraphSyncService for the
// disconnect path. That import is one-directional at the module level (the
// reverse direction — graph-sync needing MICROSOFT_SCOPES/normalizePem — was
// rehomed to microsoft-oauth-constants.ts specifically to avoid a circular
// module load), so plain constructor injection resolves with no forwardRef.
// Object.create-based unit tests below never touch Nest's DI container, so
// they cannot catch a broken wiring; only compiling a real testing module
// can. This is the highest-risk edit in the whole remediation plan (an
// auth/OAuth-gating file) so it is verified here, not assumed.
describe('MicrosoftOAuthService / MicrosoftGraphSyncService DI wiring', () => {
  test('both services construct via Nest DI with the real class wiring', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MicrosoftOAuthService,
        MicrosoftGraphSyncService,
        { provide: PrismaService, useValue: {} },
        { provide: TokenCryptoService, useValue: { isConfigured: () => false } },
        { provide: ClientAssociationService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    const oauth = moduleRef.get(MicrosoftOAuthService);
    const graphSync = moduleRef.get(MicrosoftGraphSyncService);
    expect(oauth).toBeInstanceOf(MicrosoftOAuthService);
    expect(graphSync).toBeInstanceOf(MicrosoftGraphSyncService);
    // Prove the injected instance is the SAME singleton Nest manages, not an
    // undefined placeholder that happens not to throw until first use.
    expect((oauth as unknown as { graphSync: unknown }).graphSync).toBe(graphSync);
  });
});

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

function makeService(opts: {
  findUnique: (args: unknown) => Promise<unknown>;
  deleteImpl?: (args: unknown) => Promise<unknown>;
  deleteSubscriptionsByTenant?: (tenantId: string, connectionId: string) => Promise<number>;
}) {
  const service = Object.create(MicrosoftOAuthService.prototype) as MicrosoftOAuthService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {} };
  const deleteMock = opts.deleteImpl ?? (async () => undefined);
  patch.prisma = {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        integrationConnection: {
          findUnique: opts.findUnique,
          delete: deleteMock,
        },
      }),
  };
  patch.graphSync = {
    deleteSubscriptionsByTenant:
      opts.deleteSubscriptionsByTenant ?? (async () => 0),
  };
  return service;
}

describe('MicrosoftOAuthService.disconnect', () => {
  test('a connection owned by another user is rejected; delete is never called', async () => {
    const deleteImpl = jest.fn(async () => undefined);
    const service = makeService({
      findUnique: async () => ({
        id: 'conn-1',
        provider: EngagementProvider.microsoft_365,
        createdByUserId: 'someone-else',
      }),
      deleteImpl,
    });

    await expect(service.disconnect(ctx, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(deleteImpl).not.toHaveBeenCalled();
  });

  test('a google_workspace connection is rejected with BadRequestException', async () => {
    const service = makeService({
      findUnique: async () => ({
        id: 'conn-1',
        provider: EngagementProvider.google_workspace,
        createdByUserId: 'u1',
      }),
    });

    await expect(service.disconnect(ctx, 'conn-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  test('a missing connection is rejected with NotFoundException', async () => {
    const service = makeService({ findUnique: async () => null });

    await expect(service.disconnect(ctx, 'conn-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  test('happy path: deleteSubscriptionsByTenant then delete, returns subscriptionsDeleted', async () => {
    const deleteSubscriptionsByTenant = jest.fn(async () => 2);
    const deleteImpl = jest.fn(async () => undefined);
    const service = makeService({
      findUnique: async () => ({
        id: 'conn-1',
        provider: EngagementProvider.microsoft_365,
        createdByUserId: 'u1',
      }),
      deleteImpl,
      deleteSubscriptionsByTenant,
    });

    const result = await service.disconnect(ctx, 'conn-1');

    expect(deleteSubscriptionsByTenant).toHaveBeenCalledTimes(1);
    expect(deleteSubscriptionsByTenant).toHaveBeenCalledWith('t1', 'conn-1');
    expect(deleteImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ disconnected: true, connectionId: 'conn-1', subscriptionsDeleted: 2 });
  });

  test('deleteSubscriptionsByTenant throwing does not stop the connection from being deleted (best-effort teardown)', async () => {
    // deleteSubscriptionsByTenant swallows its own errors by design (it never
    // rejects in real code), so this test stubs it to throw explicitly to prove
    // disconnect() ALSO does not depend on that swallowing — defense in depth,
    // per edge case #12: never strand a local record on a remote failure.
    const deleteImpl = jest.fn(async () => undefined);
    const service = makeService({
      findUnique: async () => ({
        id: 'conn-1',
        provider: EngagementProvider.microsoft_365,
        createdByUserId: 'u1',
      }),
      deleteImpl,
      deleteSubscriptionsByTenant: async () => {
        throw new Error('Graph is down');
      },
    });

    const result = await service.disconnect(ctx, 'conn-1');

    expect(deleteImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ disconnected: true, connectionId: 'conn-1', subscriptionsDeleted: 0 });
  });
});
