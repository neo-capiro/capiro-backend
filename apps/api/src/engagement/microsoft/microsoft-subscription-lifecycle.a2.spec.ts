import { harness, tenant } from '../mailbox-oauth.a1-fixture.js';
import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';
import { withMailboxSyncClaim } from '../mailbox-sync-claim.js';

function setup() {
  const h = harness();
  const row = h.rows.get('connection-A');
  row.token.expiresAt = new Date(Date.now() + 3_600_000);
  const subscription = (resource: string, id: string) => ({
    id,
    resource,
    clientState: `signed-${id}`,
    expirationDateTime: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
  });
  row.syncState.webhooks = {
    configured: true,
    subscriptions: [subscription('me/events', 'events'), subscription('me/messages', 'mail')],
  };
  const service = Object.assign(Object.create(MicrosoftGraphSyncService.prototype), {
    prisma: {
      ...h.prisma,
      withSystem: async (run: any) =>
        run({
          integrationConnection: {
            findMany: async () => [structuredClone(row)],
          },
        }),
    },
    tokenCrypto: h.crypto,
    notificationUrl: 'https://example.invalid/webhook',
    stateSecret: 'synthetic-secret',
    logger: { warn: jest.fn(), error: jest.fn() },
  }) as any;
  service.assertTokenRefreshConfigured = () => {};
  const queued = jest.fn().mockReturnValue(true);
  service.enqueueNotificationSync = queued;
  return { ...h, row, service, queued };
}
afterEach(() => jest.restoreAllMocks());

test('removed-but-unexpired invalidates only its exact ID durably; duplicate/forged callbacks do not erase the other resource', async () => {
  const h = setup();
  h.row.syncState.syncClaim = {
    token: 'running',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const input = {
    subscriptionId: 'mail',
    clientState: 'signed-mail',
    lifecycleEvent: 'subscriptionRemoved',
  };
  await h.service.handleNotifications({ value: [{ ...input, clientState: 'forged' }] });
  expect(h.row.syncState.webhooks.subscriptions).toHaveLength(2);
  await h.service.handleNotifications({ value: [input] });
  expect(h.row.syncState.webhooks).toMatchObject({
    configured: false,
    recoveryPending: true,
    subscriptions: [{ id: 'events' }],
  });
  expect(h.row.syncState.syncClaim).toBeUndefined();
  expect(h.row.nextSyncAt.getTime()).toBeLessThanOrEqual(Date.now());
  await h.service.handleNotifications({ value: [input] });
  expect(h.queued).toHaveBeenCalledTimes(1);
  expect(h.row.syncState.mail.cursor).toBe('A-cursor');
});

test('reauthorization PATCH renews the existing resource and retains clientState', async () => {
  const h = setup();
  const before = h.row.syncState.webhooks.subscriptions[1];
  await h.service.handleNotifications({
    value: [
      {
        subscriptionId: 'mail',
        clientState: 'signed-mail',
        lifecycleEvent: 'reauthorizationRequired',
      },
    ],
  });
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(
    async (_url, init) =>
      new Response(
        JSON.stringify({
          id: 'mail',
          expirationDateTime: JSON.parse(String(init?.body)).expirationDateTime,
        }),
      ),
  );
  await h.service.configureSubscriptionsByTenant(tenant, h.row.id);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe('https://graph.microsoft.com/v1.0/subscriptions/mail');
  expect(fetch.mock.calls[0]?.[1]?.method).toBe('PATCH');
  expect(
    h.row.syncState.webhooks.subscriptions.find((item: any) => item.id === 'mail'),
  ).toMatchObject({
    clientState: before.clientState,
    needsReauthorization: false,
    lastRenewedAt: expect.any(String),
  });
});

test('each successful resource survives another resource failure; retry reuses its identity', async () => {
  const h = setup();
  h.row.syncState.webhooks.subscriptions = [];
  h.row.syncState.webhooks.configured = false;
  let failMail = true;
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.resource === 'me/messages' && failMail) return new Response('{}', { status: 503 });
    return new Response(
      JSON.stringify({
        id: body.resource === 'me/events' ? 'events-new' : 'mail-new',
        expirationDateTime: body.expirationDateTime,
      }),
      { status: 201 },
    );
  });
  await expect(h.service.configureSubscriptionsByTenant(tenant, h.row.id)).rejects.toThrow();
  expect(h.row.syncState.webhooks.subscriptions).toHaveLength(1);
  const clientState = h.row.syncState.webhooks.subscriptions[0].clientState;
  failMail = false;
  await h.service.configureSubscriptionsByTenant(tenant, h.row.id);
  expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).resource)).toEqual([
    'me/events',
    'me/messages',
    'me/messages',
  ]);
  expect(h.row.syncState.webhooks.subscriptions[0].clientState).toBe(clientState);
  expect(h.row.syncState.webhooks.configured).toBe(true);
});

test('a removed event during renewal fences its late PATCH response and retains durable recovery', async () => {
  const h = setup();
  h.row.syncState.webhooks.subscriptions[1].needsReauthorization = true;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    await h.service.handleNotifications({
      value: [
        {
          subscriptionId: 'mail',
          clientState: 'signed-mail',
          lifecycleEvent: 'subscriptionRemoved',
        },
      ],
    });
    return new Response(
      JSON.stringify({
        id: 'mail',
        expirationDateTime: JSON.parse(String(init?.body)).expirationDateTime,
      }),
    );
  });
  await expect(h.service.configureSubscriptionsByTenant(tenant, h.row.id)).rejects.toThrow(
    'superseded',
  );
  expect(h.row.syncState.webhooks.subscriptions.map((item: any) => item.id)).toEqual(['events']);
  expect(h.row.syncState.webhooks.recoveryPending).toBe(true);
});

test('caught renewal failure inside the scheduler claim retains short recovery retry and resource health', async () => {
  const h = setup();
  h.row.syncState.webhooks.subscriptions[1].needsReauthorization = true;
  const health = { mail: { outcome: 'complete', lastCompleteAt: '2026-01-01T00:00:00.000Z' } };
  h.row.syncState.health = structuredClone(health);
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
  await withMailboxSyncClaim(
    h.prisma as never,
    tenant,
    h.row.id,
    async () => {
      await expect(h.service.configureSubscriptionsByTenant(tenant, h.row.id)).rejects.toThrow();
    },
    { successIntervalMinutes: 1440 },
  );
  expect(h.row.syncState.webhooks).toMatchObject({ configured: false, recoveryPending: true });
  expect(h.row.syncState.webhooks.subscriptions).toHaveLength(2);
  expect(h.row.syncState.health).toEqual(health);
  expect(h.row.nextSyncAt.getTime()).toBeLessThanOrEqual(Date.now() + 20 * 60_000);
});
