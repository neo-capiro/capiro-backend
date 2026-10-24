import { GoogleSyncService } from './google/google-sync.service.js';
import { GoogleTokenService } from './google/google-token.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { EngagementSyncSchedulerService } from './engagement-sync-scheduler.service.js';
import { MailboxClaimLostError } from './mailbox-sync-claim.js';
import { MailboxDeadlineError } from './mailbox-provider-transport.js';
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
      expect(h.row().syncState).toMatchObject(oldState);
      expect(h.row().syncState.syncClaim).toBeUndefined();
      expect(h.service.syncCalendar).not.toHaveBeenCalled();
      expect(h.service.syncMail).not.toHaveBeenCalled();
      expect(h.tx.integrationConnectionToken.update).not.toHaveBeenCalled();
      await expect(h.run()).rejects.toBeInstanceOf(MailboxClaimLostError);
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
      expect(h.row().nextSyncAt.getTime()).toBeLessThanOrEqual(Date.now() + 20 * 60 * 1000);
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
      expect(h.row().syncState).toMatchObject(oldState);
      expect(h.row().syncState.syncClaim).toBeUndefined();
      await expect(h.run()).resolves.toMatchObject({ connectionId: 'connection-A' });
      expect(h.row().lastError).toBeNull();
      expect(h.service.syncCalendar).toHaveBeenCalledTimes(1);
      expect(h.service.syncMail).toHaveBeenCalledTimes(1);
    });

    test('a failed reconnect-hold write is surfaced rather than claiming durable reconnect state', async () => {
      const h = syncHarness(provider);
      const update = h.tx.integrationConnection.update.getMockImplementation();
      h.tx.integrationConnection.update.mockImplementation((args: any) => {
        if (args.data.status === 'needs_configuration')
          throw new Error('synthetic persistence failure');
        return update(args);
      });
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
        await expect(h.run()).rejects.toBeInstanceOf(MailboxClaimLostError);
        if (status === 'deleted') expect(h.rows.has('connection-A')).toBe(false);
        else
          expect(h.row()).toMatchObject({
            status,
            lastError: 'synthetic existing hold',
            nextSyncAt: null,
          });
      },
    );

    test('resource permission denial is surfaced without preventing a later retry', async () => {
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
      expect(h.row().status).toBe('error');
      expect(h.row().nextSyncAt).toBeInstanceOf(Date);
      expect(h.row().lastError).toContain('denied a sync request');
      expect(h.row().lastError).not.toContain('ErrorAccessDenied');
    });

    test('late resource permission refusal cannot permanently hold a successful OAuth reconnect', async () => {
      const h = syncHarness(provider);
      h.row().token.expiresAt = new Date(Date.now() + 3_600_000);
      const oldState = structuredClone(h.row().syncState);
      h.service.syncCalendar.mockImplementationOnce(async () => {
        const attempt = await h.start();
        await h.callback(attempt.state);
        expect(h.row().status).toBe('connected');
        expect(h.row().token.accessTokenCiphertext).toBe('returned-access');
        throw new Error('Synthetic obsolete-token request failed (403): access denied');
      });
      await expect(h.run()).rejects.toBeInstanceOf(MailboxClaimLostError);
      expect(h.row().token.accessTokenCiphertext).toBe('returned-access');
      expect(h.row().syncState).toMatchObject(oldState);
      expect(h.row().syncState.syncClaim).toBeUndefined();
      // ML-16: the obsolete run cannot change successful reconnect state.
      expect(h.row().status).toBe('connected');
      expect(h.row().lastError).toBeNull();
      await expect(h.run()).resolves.toMatchObject({ connectionId: 'connection-A' });
      expect(h.row()).toMatchObject({ status: 'connected', lastError: null });
      expect(h.service.syncCalendar).toHaveBeenLastCalledWith(
        tenant,
        expect.anything(),
        expect.anything(),
        'returned-access',
        expect.anything(),
        expect.any(Function),
      );
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.exchange).not.toHaveBeenCalled();
    });

    test('access-token expiry during sync preserves the next invocation refresh and recovery', async () => {
      const h = syncHarness(provider);
      const now = Date.now();
      h.row().token.expiresAt = new Date(now + 6 * 60_000);
      h.service.syncCalendar.mockImplementationOnce(async () => {
        jest.spyOn(Date, 'now').mockReturnValue(now + 7 * 60_000);
        throw new Error('Synthetic resource request failed (401): access token expired');
      });
      await expect(h.run()).rejects.toBeInstanceOf(MailboxDeadlineError);
      expect(h.row().status).toBe('error');
      expect(h.row().nextSyncAt).toBeInstanceOf(Date);
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.exchange).not.toHaveBeenCalled();
      h.fetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'synthetic-refreshed-access',
            expires_in: 3600,
          }),
        ),
      );
      h.exchange.mockResolvedValue({
        accessToken: 'synthetic-refreshed-access',
        expiresOn: new Date(now + 67 * 60_000),
        account: { homeAccountId: 'account-A' },
        scopes: h.row().token.scopes,
      } as never);
      await expect(h.run()).resolves.toMatchObject({ connectionId: 'connection-A' });
      expect(h.row()).toMatchObject({ status: 'connected', lastError: null });
      expect(h.row().token.accessTokenCiphertext).toBe('synthetic-refreshed-access');
      expect(h.tx.integrationConnectionToken.update).toHaveBeenCalledTimes(1);
      expect(h.service.syncCalendar).toHaveBeenLastCalledWith(
        tenant,
        expect.anything(),
        expect.anything(),
        'synthetic-refreshed-access',
        expect.anything(),
        expect.any(Function),
      );
      expect(h.fetch).toHaveBeenCalledTimes(provider === 'google_workspace' ? 1 : 0);
      expect(h.exchange).toHaveBeenCalledTimes(provider === 'microsoft_365' ? 1 : 0);
    });

    test('held connections are excluded by the scheduler claim and OAuth reconnect re-enables eligibility', async () => {
      const h = syncHarness(provider);
      await expect(h.run()).rejects.toThrow();
      const queries: string[] = [];
      const scheduled = jest.fn();
      const scheduler = Object.assign(Object.create(EngagementSyncSchedulerService.prototype), {
        prisma: {
          ...h.prisma,
          withSystem: async (run: (tx: unknown) => Promise<unknown>) =>
            run({
              $queryRaw: async (query: { sql: string }) => {
                queries.push(query.sql);
                // Interpret the status predicate at the persistence seam; the real SQL
                // execution/locking remains a PostgreSQL 16 gate, not a mocked pass.
                const statuses = /AND connection.status IN \(([^)]+)\)/
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
      expect(queries[0]).toContain("AND connection.status IN ('connected', 'error')");
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
  await expect(h.run()).resolves.toMatchObject({
    health: { calendar: { outcome: 'failed' }, mail: { outcome: 'complete' } },
  });
  expect(h.row().status).toBe('connected');
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

test.each([false, true])(
  'Microsoft calendar-window mailbox absence stays retryable (reconnected: %s)',
  async (reconnected) => {
    const h = syncHarness('microsoft_365');
    h.row().token.expiresAt = new Date(Date.now() + 3_600_000);
    const oldState = structuredClone(h.row().syncState);
    h.service.graphGet = jest.fn().mockResolvedValue({ value: [] });
    h.service.graphGet.mockImplementationOnce(async () => {
      if (reconnected) {
        const attempt = await h.start();
        await h.callback(attempt.state);
        expect(h.row().status).toBe('connected');
      }
      throw new Error('MailboxNotEnabledForRESTAPI synthetic obsolete calendar-window request');
    });
    const runWindow = () =>
      h.service.syncCalendarWindow(
        { tenantId: tenant, userId: h.row().createdByUserId },
        'connection-A',
        { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' },
      );
    await expect(runWindow()).rejects.toThrow('MailboxNotEnabledForRESTAPI');
    const currentAccess = reconnected ? 'returned-access' : 'access-account-A';
    expect(h.row().token.accessTokenCiphertext).toBe(currentAccess);
    expect(h.row().syncState).toMatchObject(oldState);
    expect(h.row().syncState.syncClaim).toBeUndefined();
    expect(h.row().status).toBe(reconnected ? 'connected' : 'error');
    expect(h.row().nextSyncAt).toBeInstanceOf(Date);
    await expect(runWindow()).resolves.toMatchObject({ scanned: 0, pages: 1, hasMore: false });
    expect(h.row()).toMatchObject({ status: 'connected', lastError: null });
    expect(h.service.graphGet).toHaveBeenLastCalledWith(
      expect.any(String),
      currentAccess,
      expect.anything(),
    );
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.exchange).not.toHaveBeenCalled();
  },
);

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
