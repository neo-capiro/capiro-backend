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
import { harness, tenant } from '../mailbox-oauth.a1-fixture.js';

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

function subscriptionsFixture(
  overrides: Partial<Record<'me/events' | 'me/messages', string>> = {},
) {
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

function makeGraphSyncService(
  overrides: Record<string, unknown> = {},
  subscriptions = subscriptionsFixture(),
) {
  const h = harness();
  const row = h.rows.get('connection-A');
  h.rows.delete('connection-A');
  row.id = 'conn-1';
  row.syncState.webhooks = { subscriptions };
  h.rows.set(row.id, row);
  const service = Object.create(MicrosoftGraphSyncService.prototype) as MicrosoftGraphSyncService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.clientId = 'client-id';
  patch.tenantId = 'tenant-id';
  patch.thumbprint = 'thumbprint';
  patch.privateKey = 'private-key';
  patch.stateSecret = Buffer.from('state-secret', 'utf8');
  patch.notificationUrl =
    'https://app.capiro.ai/api/engagement/integrations/microsoft/notifications';
  patch.tokenCrypto = { isConfigured: () => true };
  patch.prisma = {
    ...h.prisma,
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
    patch.getValidAccessToken = async () => 'access-token';
    patch.graphPost = graphPost;

    const result = await service.configureSubscriptionsByTenant(tenant, 'conn-1');

    expect(graphPost).not.toHaveBeenCalled();
    expect(result.subscriptions.map((s) => s.id).sort()).toEqual(['sub-events', 'sub-messages']);
  });

  test('renews only the subscription with less than 24h remaining, retaining both identities', async () => {
    const nearExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h left, inside the 24h skew
    const graphPost = jest.fn();
    const graphFetch = jest.fn(async () => ({
      id: 'sub-events',
      expirationDateTime: FAR_FUTURE,
    }));
    const service = makeGraphSyncService({}, subscriptionsFixture({ 'me/events': nearExpiry }));
    const patch = service as unknown as Record<string, unknown>;
    patch.getValidAccessToken = async () => 'access-token';
    patch.graphPost = graphPost;
    patch.graphFetch = graphFetch;

    const result = await service.configureSubscriptionsByTenant(tenant, 'conn-1');

    expect(graphPost).not.toHaveBeenCalled();
    expect(graphFetch).toHaveBeenCalledTimes(1);
    expect(graphFetch).toHaveBeenCalledWith('PATCH', '/subscriptions/sub-events', 'access-token', {
      expirationDateTime: expect.any(String),
    });
    const byResource = Object.fromEntries(result.subscriptions.map((s) => [s.resource, s]));
    expect(byResource['me/events']!.id).toBe('sub-events');
    expect(byResource['me/events']!.expirationDateTime).toBe(FAR_FUTURE);
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
