// Phase H (completion plan §3.h2) — Microsoft provider contract tests.
// Fetch/network-free: configureSubscriptionsByTenant and handleNotifications
// are exercised by overriding the private loadConnection/getValidAccessToken/
// graphPost methods (and the public syncConnectionByTenant) directly on an
// Object.create-constructed instance, the same technique already used for
// MicrosoftOAuthService in microsoft-oauth.disconnect.spec.ts.
//
// selectRefreshTokenForAccount (the home_account_id-over-last-entry binding)
// is already covered exhaustively by microsoft-oauth.refresh-token.spec.ts,
// including the exact "matched account wins over a later, non-matching entry"
// case this phase would otherwise duplicate -- not repeated here.

import { describe, expect, test } from '@jest/globals';
import { MicrosoftOAuthService } from './microsoft-oauth.service.js';
import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';

function makeOAuthService(overrides: Record<string, unknown> = {}) {
  const service = Object.create(MicrosoftOAuthService.prototype) as MicrosoftOAuthService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.clientId = 'client-id';
  patch.tenantId = 'tenant-id';
  patch.thumbprint = 'thumbprint';
  patch.privateKey = 'private-key';
  patch.stateSecret = Buffer.from('state-secret', 'utf8');
  patch.tokenCrypto = { isConfigured: () => true };
  Object.assign(patch, overrides);
  return service;
}

describe('MicrosoftOAuthService.capabilities', () => {
  test('configured:true when all six required settings are present', () => {
    expect(makeOAuthService().capabilities().configured).toBe(true);
  });

  test.each([['clientId'], ['tenantId'], ['thumbprint'], ['privateKey'], ['stateSecret']])(
    'configured:false when %s is missing',
    (field) => {
      const service = makeOAuthService({ [field]: undefined });
      expect(service.capabilities().configured).toBe(false);
    },
  );

  test('configured:false when the token encryption key is not configured', () => {
    const service = makeOAuthService({ tokenCrypto: { isConfigured: () => false } });
    expect(service.capabilities().configured).toBe(false);
  });
});

const FAR_FUTURE = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

function subscriptionsFixture(overrides: Partial<Record<'me/events' | 'me/messages', string>> = {}) {
  return [
    {
      id: 'sub-events',
      resource: 'me/events' as const,
      clientState: 'cs-events',
      expirationDateTime: overrides['me/events'] ?? FAR_FUTURE,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'sub-messages',
      resource: 'me/messages' as const,
      clientState: 'cs-messages',
      expirationDateTime: overrides['me/messages'] ?? FAR_FUTURE,
      createdAt: new Date().toISOString(),
    },
  ];
}

function makeGraphSyncService(overrides: Record<string, unknown> = {}) {
  const service = Object.create(MicrosoftGraphSyncService.prototype) as MicrosoftGraphSyncService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.clientId = 'client-id';
  patch.tenantId = 'tenant-id';
  patch.thumbprint = 'thumbprint';
  patch.privateKey = 'private-key';
  patch.stateSecret = Buffer.from('state-secret', 'utf8');
  patch.notificationUrl = 'https://app.capiro.ai/api/engagement/integrations/microsoft/notifications';
  patch.tokenCrypto = { isConfigured: () => true };
  patch.prisma = {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({ integrationConnection: { update: async () => undefined } }),
    withSystem: async (fn: (tx: unknown) => unknown) =>
      fn({ integrationConnection: { findMany: async () => [] } }),
  };
  Object.assign(patch, overrides);
  return service;
}

describe('MicrosoftGraphSyncService.configureSubscriptionsByTenant', () => {
  test('reuses both subscriptions when each has more than 24h remaining', async () => {
    const graphPost = jest.fn(async () => ({
      id: 'should-not-be-created',
      resource: 'me/events',
      expirationDateTime: FAR_FUTURE,
    }));
    const service = makeGraphSyncService();
    const patch = service as unknown as Record<string, unknown>;
    patch.loadConnection = async () => ({
      connection: { syncState: { webhooks: { subscriptions: subscriptionsFixture() } } },
      token: {},
    });
    patch.getValidAccessToken = async () => 'access-token';
    patch.graphPost = graphPost;

    const result = await service.configureSubscriptionsByTenant('t1', 'conn-1');

    expect(graphPost).not.toHaveBeenCalled();
    expect(result.subscriptions.map((s) => s.id).sort()).toEqual(['sub-events', 'sub-messages']);
  });

  test('recreates only the subscription with less than 24h remaining, reusing the other unchanged', async () => {
    const nearExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h left, inside the 24h skew
    const graphPost = jest.fn(async (_url: string, _token: string, body: { resource: string }) => ({
      id: 'new-sub-events',
      resource: body.resource,
      expirationDateTime: FAR_FUTURE,
    }));
    const service = makeGraphSyncService();
    const patch = service as unknown as Record<string, unknown>;
    patch.loadConnection = async () => ({
      connection: {
        syncState: { webhooks: { subscriptions: subscriptionsFixture({ 'me/events': nearExpiry }) } },
      },
      token: {},
    });
    patch.getValidAccessToken = async () => 'access-token';
    patch.graphPost = graphPost;

    const result = await service.configureSubscriptionsByTenant('t1', 'conn-1');

    expect(graphPost).toHaveBeenCalledTimes(1);
    expect(graphPost.mock.calls[0]![2].resource).toBe('me/events');
    const byResource = Object.fromEntries(result.subscriptions.map((s) => [s.resource, s]));
    expect(byResource['me/events']!.id).toBe('new-sub-events');
    expect(byResource['me/messages']!.id).toBe('sub-messages');
  });
});

describe('MicrosoftGraphSyncService.handleNotifications', () => {
  const subscription = {
    id: 'sub-1',
    resource: 'me/messages' as const,
    clientState: 'correct-secret',
    expirationDateTime: FAR_FUTURE,
    createdAt: new Date().toISOString(),
  };

  function makeServiceWithConnection() {
    const syncSpy = jest.fn(async () => ({ connectionId: 'conn-1' }));
    const service = makeGraphSyncService({
      prisma: {
        withSystem: async (fn: (tx: unknown) => unknown) =>
          fn({
            integrationConnection: {
              findMany: async () => [
                {
                  id: 'conn-1',
                  tenantId: 't1',
                  syncState: { webhooks: { subscriptions: [subscription] } },
                },
              ],
            },
          }),
      },
    });
    (service as unknown as Record<string, unknown>).syncConnectionByTenant = syncSpy;
    return { service, syncSpy };
  }

  test('rejects a notification whose clientState does not match the subscription', async () => {
    const { service, syncSpy } = makeServiceWithConnection();
    const result = await service.handleNotifications({
      value: [
        {
          subscriptionId: 'sub-1',
          clientState: 'WRONG-SECRET',
          resource: 'me/messages',
          changeType: 'updated',
        },
      ],
    });
    expect(result).toEqual({ accepted: 0, scheduledSyncs: 0 });
    expect(syncSpy).not.toHaveBeenCalled();
  });

  test('coalesces N notifications for the same (connection, resource) into exactly one scheduled sync', async () => {
    const { service, syncSpy } = makeServiceWithConnection();
    const notification = {
      subscriptionId: 'sub-1',
      clientState: 'correct-secret',
      resource: 'me/messages',
      changeType: 'updated',
    };
    const result = await service.handleNotifications({
      value: [notification, notification, notification],
    });
    expect(result).toEqual({ accepted: 3, scheduledSyncs: 1 });
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });
});
