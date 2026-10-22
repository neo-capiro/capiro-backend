import { GoogleSyncService } from './google/google-sync.service.js';
import { GoogleTokenService } from './google/google-token.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { EngagementSyncSchedulerService } from './engagement-sync-scheduler.service.js';
import { MailboxReconnectRequiredError } from './mail-sync-failure.js';
import { harness, tenant } from './mailbox-oauth.a1-fixture.js';

type Provider = 'google_workspace' | 'microsoft_365';

// All identifiers, credentials and provider responses are synthetic. No database,
// provider, configured runtime or application bootstrap is started by these tests.
function syncHarness(provider: Provider) {
  const h = harness(provider);
  const row = () => h.rows.get('connection-A');
  h.tx.integrationConnection.findUnique = jest.fn(async ({ where }: { where: { id: string } }) =>
    structuredClone(h.rows.get(where.id) ?? null),
  );
  h.tx.integrationConnection.updateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string; status?: { in: string[] } };
      data: Record<string, unknown>;
    }) => {
      const current = h.rows.get(where.id);
      if (!current || (where.status && !where.status.in.includes(current.status)))
        return { count: 0 };
      Object.assign(current, data);
      return { count: 1 };
    },
  );
  const googleToken = Object.assign(Object.create(GoogleTokenService.prototype), {
    prisma: h.prisma,
    tokenCrypto: h.crypto,
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-client-secret',
  });
  const service = Object.assign(
    Object.create(
      provider === 'google_workspace'
        ? GoogleSyncService.prototype
        : MicrosoftGraphSyncService.prototype,
    ),
    {
      prisma: h.prisma,
      googleToken,
      tokenCrypto: h.crypto,
      logger: { warn: jest.fn(), log: jest.fn() },
    },
  );
  service.assertTokenRefreshConfigured = () => {};
  const exchange = jest.fn(async () => {
    throw new Error('invalid_grant synthetic-provider-detail');
  });
  service.buildMsalClient = () => ({ acquireTokenByRefreshToken: exchange });
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url) !== 'https://oauth2.googleapis.com/token')
      throw new Error('Unexpected provider URL');
    await exchange();
    return new Response('{}');
  });
  if (provider === 'google_workspace') {
    exchange.mockImplementation(async () => undefined as never);
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'synthetic-provider-detail',
        }),
        { status: 400 },
      ),
    );
  }
  service.syncCalendar = jest.fn().mockResolvedValue({ scanned: 0 });
  service.syncMail = jest.fn().mockResolvedValue({ scanned: 0 });
  const run = () => service.syncConnectionByTenant(tenant, 'connection-A');
  return { ...h, row, service, fetch, exchange, run };
}

afterEach(() => jest.restoreAllMocks());

describe.each(['google_workspace', 'microsoft_365'] as const)(
  'ML-13 %s top-level sync',
  (provider) => {
    test('invalid grant remains held after the outer catch and repeated sync cannot redeem again', async () => {
      const h = syncHarness(provider);
      const oldState = structuredClone(h.row().syncState);
      h.row().nextSyncAt = new Date();
      await expect(h.run()).rejects.toThrow('Reconnect');
      expect(h.row()).toMatchObject({ status: 'needs_configuration', nextSyncAt: null });
      expect(h.row().lastError).toContain('Reconnect');
      expect(h.row().lastError).not.toContain('synthetic-provider-detail');
      expect(h.row().syncState).toEqual(oldState);
      expect(h.service.syncCalendar).not.toHaveBeenCalled();
      expect(h.service.syncMail).not.toHaveBeenCalled();
      expect(h.tx.integrationConnectionToken.update).not.toHaveBeenCalled();
      await expect(h.run()).rejects.toThrow('credentials changed');
      expect(h.row().status).toBe('needs_configuration');
      expect(h.fetch).toHaveBeenCalledTimes(provider === 'google_workspace' ? 1 : 0);
      expect(h.exchange).toHaveBeenCalledTimes(provider === 'microsoft_365' ? 1 : 0);
    });

    test('missing refresh material requires reconnect without attempting provider redemption', async () => {
      const h = syncHarness(provider);
      h.row().token.refreshTokenCiphertext = null;
      await expect(h.run()).rejects.toBeInstanceOf(MailboxReconnectRequiredError);
      expect(h.row()).toMatchObject({ status: 'needs_configuration', nextSyncAt: null });
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.exchange).not.toHaveBeenCalled();
    });

    test('transient exchange failure remains eligible for a later retry', async () => {
      const h = syncHarness(provider);
      h.fetch.mockRejectedValue(new Error('synthetic network failure'));
      h.exchange.mockRejectedValue(new Error('synthetic network failure'));
      const before = Date.now();
      await expect(h.run()).rejects.toThrow('synthetic network failure');
      expect(h.row().status).toBe('error');
      expect(h.row().nextSyncAt.getTime()).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
      expect(h.row().nextSyncAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
      h.row().token.expiresAt = new Date(Date.now() + 3_600_000);
      await expect(h.run()).resolves.toMatchObject({ connectionId: 'connection-A' });
      expect(h.row()).toMatchObject({ status: 'connected', lastError: null });
    });

    test('successful owned OAuth reconnect restores normal sync and retains cursors', async () => {
      const h = syncHarness(provider);
      await expect(h.run()).rejects.toBeInstanceOf(MailboxReconnectRequiredError);
      const oldState = structuredClone(h.row().syncState);
      const attempt = await h.start();
      await h.callback(attempt.state);
      expect(h.row().status).toBe('connected');
      expect(h.row().syncState).toEqual(oldState);
      await expect(h.run()).resolves.toMatchObject({ connectionId: 'connection-A' });
      expect(h.row().lastError).toBeNull();
      expect(h.service.syncCalendar).toHaveBeenCalledTimes(1);
      expect(h.service.syncMail).toHaveBeenCalledTimes(1);
    });

    test('a failed reconnect-hold write is surfaced rather than claiming durable reconnect state', async () => {
      const h = syncHarness(provider);
      h.tx.integrationConnection.update.mockRejectedValue(
        new Error('synthetic persistence failure'),
      );
      await expect(h.run()).rejects.toThrow('synthetic persistence failure');
      expect(h.row().status).toBe('error');
      expect(h.service.syncCalendar).not.toHaveBeenCalled();
    });

    test.each(['needs_configuration', 'disabled', 'deleted'])(
      'a late transient failure cannot overwrite %s',
      async (status) => {
        const h = syncHarness(provider);
        h.row().token.expiresAt = new Date(Date.now() + 3_600_000);
        h.service.syncCalendar.mockImplementation(async () => {
          if (status === 'deleted') h.rows.delete('connection-A');
          else
            Object.assign(h.row(), {
              status,
              lastError: 'synthetic existing hold',
              nextSyncAt: null,
            });
          throw new Error('synthetic read timeout');
        });
        await expect(h.run()).rejects.toThrow('synthetic read timeout');
        if (status === 'deleted') expect(h.rows.has('connection-A')).toBe(false);
        else
          expect(h.row()).toMatchObject({
            status,
            lastError: 'synthetic existing hold',
            nextSyncAt: null,
          });
      },
    );

    test('provider permission denial holds sync without a retry hint', async () => {
      const h = syncHarness(provider);
      h.row().token.expiresAt = new Date(Date.now() + 3_600_000);
      h.fetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'ErrorAccessDenied',
              errors: [{ reason: 'insufficientPermissions' }],
            },
          }),
          { status: 403 },
        ),
      );
      h.service.syncCalendar.mockImplementation(() =>
        provider === 'google_workspace'
          ? h.service.googleGet(
              'https://www.googleapis.com/calendar/v3/calendars/primary/events',
              'synthetic-access',
            )
          : h.service.graphFetch('GET', '/me/calendar/events', 'synthetic-access'),
      );
      await expect(h.run()).rejects.toThrow();
      expect(h.row()).toMatchObject({ status: 'needs_configuration', nextSyncAt: null });
      expect(h.row().lastError).toContain('denied the required mailbox permissions');
    });

    test('held connections are excluded by the scheduler claim and OAuth reconnect re-enables eligibility', async () => {
      const h = syncHarness(provider);
      await expect(h.run()).rejects.toThrow();
      const queries: string[] = [];
      const scheduled = jest.fn();
      const scheduler = Object.assign(Object.create(EngagementSyncSchedulerService.prototype), {
        prisma: {
          withSystem: async (run: (tx: unknown) => Promise<unknown>) =>
            run({
              $queryRaw: async (query: { sql: string }) => {
                queries.push(query.sql);
                // Interpret the status predicate at the persistence seam; the real SQL
                // execution/locking remains a PostgreSQL 16 gate, not a mocked pass.
                const statuses = /AND status IN \(([^)]+)\)/
                  .exec(query.sql)![1]!
                  .match(/'([^']+)'/g)!;
                return statuses.includes(`'${h.row().status}'`)
                  ? [{ id: 'connection-A', tenant_id: tenant, provider }]
                  : [];
              },
            }),
        },
        intervalMinutes: 20,
        tickCount: 1,
        runtimePolicy: { assertBackgroundOwner: () => {} },
        microsoft: { syncConnectionByTenant: scheduled, subscriptionsConfigurable: false },
        google: { syncConnectionByTenant: scheduled },
        logger: { log: jest.fn(), warn: jest.fn() },
      });
      await scheduler.tick();
      expect(scheduled).not.toHaveBeenCalled();
      expect(queries[0]).toContain("AND status IN ('connected', 'error')");
      const attempt = await h.start();
      await h.callback(attempt.state);
      await scheduler.tick();
      expect(scheduled).toHaveBeenCalledTimes(1);
    });
  },
);

test('Google quota 403 remains transient rather than requiring new OAuth', async () => {
  const h = syncHarness('google_workspace');
  h.row().token.expiresAt = new Date(Date.now() + 3_600_000);
  h.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        error: {
          errors: [{ reason: 'rateLimitExceeded' }],
        },
      }),
      { status: 403 },
    ),
  );
  h.service.syncCalendar.mockImplementation(() =>
    h.service.googleGet(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      'synthetic-access',
    ),
  );
  await expect(h.run()).rejects.toThrow();
  expect(h.row().status).toBe('error');
  expect(h.row().nextSyncAt).toBeInstanceOf(Date);
});

test('Microsoft mailbox-not-enabled remains held with a specific safe diagnosis', async () => {
  const h = syncHarness('microsoft_365');
  h.row().token.expiresAt = new Date(Date.now() + 3_600_000);
  h.service.syncCalendar.mockRejectedValue(
    new Error('MailboxNotEnabledForRESTAPI synthetic-provider-detail'),
  );
  await expect(h.run()).rejects.toThrow();
  expect(h.row()).toMatchObject({ status: 'needs_configuration', nextSyncAt: null });
  expect(h.row().lastError).toContain('no Exchange Online mailbox');
  expect(h.row().lastError).not.toContain('synthetic-provider-detail');
});

test.each(['interaction_required', 'consent_required', 'login_required'])(
  'Microsoft typed %s error requires reconnect even without matching error prose',
  async (errorCode) => {
    const h = syncHarness('microsoft_365');
    h.exchange.mockRejectedValue(
      Object.assign(new Error('synthetic-provider-detail'), { errorCode }),
    );
    await expect(h.run()).rejects.toBeInstanceOf(MailboxReconnectRequiredError);
    expect(h.row()).toMatchObject({ status: 'needs_configuration', nextSyncAt: null });
  },
);

test.each(['missing-identity', 'wrong-identity', 'missing-scopes'])(
  'Microsoft %s remains held without accepting the returned token',
  async (scenario) => {
    const h = syncHarness('microsoft_365');
    if (scenario === 'missing-identity') h.row().token.homeAccountId = null;
    else
      h.exchange.mockResolvedValue({
        accessToken: 'synthetic-returned-token',
        account: { homeAccountId: scenario === 'wrong-identity' ? 'synthetic-other' : 'account-A' },
        scopes: scenario === 'missing-scopes' ? [] : h.row().token.scopes,
      } as never);
    await expect(h.run()).rejects.toBeInstanceOf(MailboxReconnectRequiredError);
    expect(h.row()).toMatchObject({ status: 'needs_configuration', nextSyncAt: null });
    expect(h.tx.integrationConnectionToken.update).not.toHaveBeenCalled();
  },
);
