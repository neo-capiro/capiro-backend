import { ConfidentialClientApplication } from '@azure/msal-node';
import { GOOGLE_SCOPES, GoogleOAuthService } from './google/google-oauth.service.js';
import { GoogleTokenService } from './google/google-token.service.js';
import {
  MicrosoftOAuthService,
  selectRefreshTokenForAccount,
} from './microsoft/microsoft-oauth.service.js';
import { MICROSOFT_SCOPES } from './microsoft/microsoft-oauth-constants.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';

jest.mock('@azure/msal-node', () => ({ ConfidentialClientApplication: jest.fn() }));

import { harness, tenant, freshToken } from './mailbox-oauth.a1-fixture.js';

describe.each(['microsoft_365', 'google_workspace'] as const)('ML-08 %s', (provider) => {
  test('empty Connect adds an independent mailbox and preserves existing history', async () => {
    const h = harness(provider);
    const old = structuredClone(h.rows.get('connection-A'));
    h.setReturned({ id: 'account-B', email: 'b@example.invalid', refresh: 'refresh-B' });
    const attempt = await h.start({});
    expect(attempt.connectionId).not.toBe('connection-A');
    await h.callback(attempt.state);
    expect(h.rows.get('connection-A')).toEqual(old);
    expect(h.rows.get(attempt.connectionId).token.homeAccountId).toBe('account-B');
  });

  test('same-account reconnect preserves refresh token/cursors and consumes callback once', async () => {
    const h = harness(provider);
    const old = structuredClone(h.rows.get('connection-A'));
    const attempt = await h.start();
    await h.callback(attempt.state);
    expect(h.rows.get('connection-A').token.refreshTokenCiphertext).toBe(
      old.token.refreshTokenCiphertext,
    );
    expect(h.rows.get('connection-A').syncState).toMatchObject(old.syncState);
    expect(h.rows.get('connection-A').syncState.scopeVerification.grantedScopes).toEqual(
      h.rows.get('connection-A').scopes,
    );
    await expect(h.callback(attempt.state)).rejects.toThrow();
    expect(h.exchange).toHaveBeenCalledTimes(1);
  });

  test.each(['different-email', 'same-email'] as const)(
    'rejects a changed stable identity with %s before token writes',
    async (mode) => {
      const h = harness(provider);
      const attempt = await h.start();
      h.setReturned({
        id: 'account-B',
        email: mode === 'same-email' ? 'a@example.invalid' : 'b@example.invalid',
        refresh: 'B-secret',
      });
      await expect(h.callback(attempt.state)).rejects.toThrow('Selected account');
      expect(h.tx.integrationConnectionToken.upsert).not.toHaveBeenCalled();
      expect(h.rows.get('connection-A').token.homeAccountId).toBe('account-A');
    },
  );

  test('registered email mismatch and duplicate existing mailbox both refuse token writes', async () => {
    const h = harness(provider);
    Object.assign(h.rows.get('connection-A'), {
      token: null,
      status: 'needs_configuration',
      syncState: {},
    });
    const registered = await h.start();
    h.setReturned({ id: 'account-B', email: 'b@example.invalid', refresh: 'B-secret' });
    await expect(h.callback(registered.state)).rejects.toThrow('Selected account');
    const duplicateHarness = harness(provider);
    const duplicate = await duplicateHarness.start({});
    duplicateHarness.setReturned({
      id: 'account-A',
      email: 'a@example.invalid',
      refresh: 'A-secret',
    });
    await expect(duplicateHarness.callback(duplicate.state)).rejects.toThrow('already connected');
    expect(duplicateHarness.tx.integrationConnectionToken.upsert).not.toHaveBeenCalled();
    expect(h.tx.integrationConnectionToken.upsert).not.toHaveBeenCalled();
  });

  test('a missing token cannot rebind historical mailbox data', async () => {
    for (const cause of ['status', 'cursor', 'history'] as const) {
      const h = harness(provider);
      Object.assign(h.rows.get('connection-A'), {
        token: null,
        status: 'needs_configuration',
        syncState: {},
      });
      if (cause === 'status') h.rows.get('connection-A').status = 'connected';
      if (cause === 'cursor')
        h.rows.get('connection-A').syncState = { mail: { cursor: 'prior-account' } };
      if (cause === 'history') h.tx.mailMessage.count.mockResolvedValue(1);
      await expect(h.start()).rejects.toThrow('history');
      expect(h.exchange).not.toHaveBeenCalled();
      expect(h.tx.integrationConnection.update).not.toHaveBeenCalled();
    }
  });

  test('newer start invalidates an older callback before exchange', async () => {
    const h = harness(provider);
    const old = await h.start();
    const current = await h.start();
    await expect(h.callback(old.state)).rejects.toThrow('replaced or consumed');
    expect(h.exchange).not.toHaveBeenCalled();
    await h.callback(current.state);
  });

  test.each([
    'wrong-owner',
    'wrong-tenant',
    'wrong-provider',
    'removed-member',
    'deleted',
  ] as const)('rejects %s before the provider exchange', async (scenario) => {
    const h = harness(provider);
    const attempt = await h.start();
    const row = h.rows.get('connection-A');
    if (scenario === 'wrong-owner') row.createdByUserId = 'someone-else';
    if (scenario === 'wrong-tenant') row.tenantId = 'other-tenant';
    if (scenario === 'wrong-provider') row.provider = 'other-provider';
    if (scenario === 'removed-member') h.setActive(false);
    if (scenario === 'deleted') h.rows.delete('connection-A');
    await expect(h.callback(attempt.state)).rejects.toThrow();
    expect(h.exchange).not.toHaveBeenCalled();
    expect(h.tx.integrationConnectionToken.upsert).not.toHaveBeenCalled();
  });

  test('replacement start during exchange denies the older finalization', async () => {
    const h = harness(provider);
    const attempt = await h.start();
    h.afterExchange(async () => {
      await h.start();
    });
    await expect(h.callback(attempt.state)).rejects.toThrow('replaced or consumed');
    expect(h.tx.integrationConnectionToken.upsert).not.toHaveBeenCalled();
  });

  test('membership revoked during exchange denies finalization', async () => {
    const h = harness(provider);
    const attempt = await h.start();
    h.afterExchange(() => h.setActive(false));
    await expect(h.callback(attempt.state)).rejects.toThrow('membership');
    expect(h.tx.integrationConnectionToken.upsert).not.toHaveBeenCalled();
  });

  test('obsolete, expired, wrong-provider and suffix-appended state cannot reach exchange', async () => {
    const h = harness(provider);
    const attempt = await h.start();
    const payload = JSON.parse(Buffer.from(attempt.state.split('.')[0], 'base64url').toString());
    for (const invalid of [
      { c: payload.c, t: payload.t, n: payload.n, e: payload.e },
      { ...payload, e: 0 },
      { ...payload, p: 'other-provider' },
    ])
      await expect(h.callback(h.service.signState(invalid))).rejects.toThrow();
    await expect(h.callback(`${attempt.state}.extra`)).rejects.toThrow();
    expect(h.exchange).not.toHaveBeenCalled();
  });
});

describe('ML-10 refresh isolation and durable stale-response fence', () => {
  test('both selectors require an exact expected account, including absent and unmatched IDs', () => {
    const serialized = JSON.stringify({
      RefreshToken: {
        a: { home_account_id: 'A', secret: 'a' },
        b: { home_account_id: 'B', secret: 'b' },
      },
    });
    const graph: any = Object.create(MicrosoftGraphSyncService.prototype);
    const cache = { getTokenCache: () => ({ serialize: () => serialized }) };
    for (const identity of [null, 'missing']) {
      expect(selectRefreshTokenForAccount(serialized, identity)).toBeUndefined();
      expect(graph.extractRotatedRefreshToken(cache, identity)).toBeUndefined();
    }
    expect(selectRefreshTokenForAccount(serialized, 'A')).toBe('a');
    expect(graph.extractRotatedRefreshToken(cache, 'B')).toBe('b');
  });

  test('each Microsoft exchange owns a fresh MSAL client', () => {
    (ConfidentialClientApplication as jest.Mock).mockImplementation(() => ({ marker: {} }));
    const service: any = Object.create(MicrosoftGraphSyncService.prototype);
    expect(service.buildMsalClient()).not.toBe(service.buildMsalClient());
  });

  function refreshHarness() {
    const h = harness();
    const service: any = Object.create(MicrosoftGraphSyncService.prototype);
    Object.assign(service, {
      prisma: h.prisma,
      tokenCrypto: h.crypto,
      logger: { warn: jest.fn() },
    });
    service.assertTokenRefreshConfigured = () => {};
    let after: (() => void) | undefined;
    let result = {
      accessToken: 'new-access',
      account: { homeAccountId: 'account-A' },
      scopes: MICROSOFT_SCOPES,
    };
    const exchange = jest.fn(async () => {
      after?.();
      return result;
    });
    service.buildMsalClient = () => ({
      acquireTokenByRefreshToken: exchange,
      getTokenCache: () => ({
        serialize: () =>
          JSON.stringify({
            RefreshToken: {
              a: { home_account_id: result.account.homeAccountId, secret: 'rotated' },
            },
          }),
      }),
    });
    const run = () =>
      service.getValidAccessToken(
        tenant,
        'connection-A',
        structuredClone(h.rows.get('connection-A').token),
      );
    return {
      ...h,
      service,
      run,
      exchange,
      after: (hook: () => void) => {
        after = hook;
      },
      result: (value: typeof result) => {
        result = value;
      },
    };
  }

  test.each([
    'wrong-account',
    'missing-scope',
    'rotated',
    'disconnected',
    'removed-member',
  ] as const)(
    'rejects %s after exchange without persisting or returning the response token',
    async (scenario) => {
      const h = refreshHarness();
      if (scenario === 'wrong-account')
        h.result({ accessToken: 'B', account: { homeAccountId: 'B' }, scopes: MICROSOFT_SCOPES });
      if (scenario === 'missing-scope')
        h.result({ accessToken: 'reduced', account: { homeAccountId: 'account-A' }, scopes: [] });
      if (scenario === 'rotated')
        h.after(() => {
          h.rows.get('connection-A').token = freshToken('account-A');
          h.rows.get('connection-A').token.refreshTokenCiphertext = 'newer-rotation';
        });
      if (scenario === 'disconnected')
        h.after(() => {
          h.rows.delete('connection-A');
        });
      if (scenario === 'removed-member') h.after(() => h.setActive(false));
      await expect(h.run()).rejects.toThrow();
      expect(h.tx.integrationConnectionToken.update).not.toHaveBeenCalled();
    },
  );

  test('transient sync error allows recovery while reconnect-required status stays blocked', async () => {
    const h = refreshHarness();
    h.rows.get('connection-A').status = 'error';
    await expect(h.run()).resolves.toBe('new-access');
    h.rows.get('connection-A').status = 'needs_configuration';
    await expect(h.run()).rejects.toThrow('credentials changed');
    expect(h.exchange).toHaveBeenCalledTimes(1);
  });

  test('removed actor and active reconnect deny even a cached token; expired attempt does not block refresh', async () => {
    const h = refreshHarness();
    h.rows.get('connection-A').token.expiresAt = new Date(Date.now() + 3600000);
    h.setActive(false);
    await expect(h.run()).rejects.toThrow('membership');
    h.setActive(true);
    h.rows.get('connection-A').syncState.oauthAttempt = {
      phase: 'pending',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    };
    await expect(h.run()).rejects.toThrow('credentials changed');
    expect(h.exchange).not.toHaveBeenCalled();
    h.rows.get('connection-A').syncState.oauthAttempt.expiresAt = 0;
    await expect(h.run()).resolves.toBe('access-account-A');
  });

  test('successful refresh advances only the bound mailbox token', async () => {
    const h = refreshHarness();
    await expect(h.run()).resolves.toBe('new-access');
    expect(h.rows.get('connection-A').token.refreshTokenCiphertext).toBe('rotated');
    expect(h.tx.integrationConnectionToken.update).toHaveBeenCalledTimes(1);
  });

  test('concurrent Microsoft account refreshes keep separate caches and rotated tokens', async () => {
    const h = harness();
    h.rows.set('connection-B', {
      ...structuredClone(h.rows.get('connection-A')),
      id: 'connection-B',
      accountEmail: 'b@example.invalid',
      token: freshToken('account-B'),
    });
    const service: any = Object.create(MicrosoftGraphSyncService.prototype);
    Object.assign(service, {
      prisma: h.prisma,
      tokenCrypto: h.crypto,
      logger: { warn: jest.fn() },
    });
    service.assertTokenRefreshConfigured = () => {};
    let release!: () => void;
    let entered = 0;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    (ConfidentialClientApplication as jest.Mock).mockImplementation(() => {
      let account: string;
      return {
        acquireTokenByRefreshToken: async ({ refreshToken }: any) => {
          account = refreshToken.replace('refresh-', '');
          if (++entered === 2) release();
          await bothEntered;
          return {
            accessToken: `new-${account}`,
            account: { homeAccountId: account },
            scopes: MICROSOFT_SCOPES,
          };
        },
        getTokenCache: () => ({
          serialize: () =>
            JSON.stringify({
              RefreshToken: { entry: { home_account_id: account, secret: `rotated-${account}` } },
            }),
        }),
      };
    });
    const results = await Promise.all(
      ['A', 'B'].map((key) =>
        service.getValidAccessToken(
          tenant,
          `connection-${key}`,
          structuredClone(h.rows.get(`connection-${key}`).token),
        ),
      ),
    );
    expect(results).toEqual(['new-account-A', 'new-account-B']);
    expect(h.rows.get('connection-A').token.refreshTokenCiphertext).toBe('rotated-account-A');
    expect(h.rows.get('connection-B').token.refreshTokenCiphertext).toBe('rotated-account-B');
  });

  test('partial Google consent cannot revoke a grant for an unadmitted account', async () => {
    const h = harness('google_workspace');
    const attempt = await h.start();
    h.service.exchangeCode = async () => ({
      access_token: 'wrong-account-access',
      scope: 'openid',
    });
    await expect(h.callback(attempt.state)).rejects.toThrow('Selected account');
    expect(h.rows.get('connection-A').status).toBe('connected');
    expect(h.service.revokeGoogleGrant).not.toHaveBeenCalled();
    expect(h.tx.integrationConnectionToken.upsert).not.toHaveBeenCalled();
  });

  test('Google late refresh cannot overwrite a newer reconnect', async () => {
    const h = harness('google_workspace');
    const service: any = Object.create(GoogleTokenService.prototype);
    Object.assign(service, {
      prisma: h.prisma,
      tokenCrypto: h.crypto,
      clientId: 'fake',
      clientSecret: 'fake',
    });
    const snapshot = structuredClone(h.rows.get('connection-A').token);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      h.rows.get('connection-A').token = { ...snapshot, accessTokenCiphertext: 'new-reconnect' };
      return { ok: true, json: async () => ({ access_token: 'old-late-refresh' }) } as any;
    });
    try {
      await expect(service.getValidAccessToken(tenant, 'connection-A', snapshot)).rejects.toThrow(
        'credentials changed',
      );
      expect(h.tx.integrationConnectionToken.update).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
