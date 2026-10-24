import { harness, tenant } from './mailbox-oauth.a1-fixture.js';
import { GoogleSyncService } from './google/google-sync.service.js';
import { GoogleTokenService } from './google/google-token.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { GOOGLE_SCOPES } from './google/google-oauth.service.js';
import { MICROSOFT_SCOPES } from './microsoft/microsoft-oauth-constants.js';
import { MailboxClaimLostError } from './mailbox-sync-claim.js';

const complete = {
  scanned: 1,
  matched: 1,
  skipped: 0,
  removed: 0,
  held: 0,
  failed: 0,
  pages: 1,
  hasMore: false,
};
function setup(provider: 'google_workspace' | 'microsoft_365') {
  const h = harness(provider);
  const row = h.rows.get('connection-A');
  row.token.expiresAt = new Date(Date.now() + 3_600_000);
  const googleToken = Object.assign(Object.create(GoogleTokenService.prototype), {
    prisma: h.prisma,
    tokenCrypto: h.crypto,
    clientId: 'synthetic',
    clientSecret: 'synthetic',
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
      logger: { warn: jest.fn(), error: jest.fn() },
    },
  );
  service.syncCalendar = jest.fn(async (_t: string, _c: unknown, state: any) => {
    state.calendar = { cursor: 'new-calendar' };
    return complete;
  });
  service.syncMail = jest.fn(async (_t: string, _c: unknown, state: any) => {
    state.mail = { cursor: 'new-mail' };
    return { ALL: complete };
  });
  return {
    ...h,
    service,
    googleToken,
    row,
    run: () => service.syncConnectionByTenant(tenant, row.id),
  };
}
afterEach(() => jest.restoreAllMocks());

describe.each(['google_workspace', 'microsoft_365'] as const)(
  '%s resource health through actual claim orchestration',
  (provider) => {
    test('calendar failure still attempts mail and persists independent outcomes', async () => {
      const h = setup(provider);
      h.service.syncCalendar.mockRejectedValue(new Error('synthetic transient'));
      await expect(h.run()).resolves.toMatchObject({
        health: { calendar: { outcome: 'failed' }, mail: { outcome: 'complete' } },
      });
      expect(h.service.syncMail).toHaveBeenCalledTimes(1);
      expect(h.row.syncState).toMatchObject({
        calendar: { cursor: 'A-calendar' },
        mail: { cursor: 'new-mail' },
        health: { calendar: { outcome: 'failed' }, mail: { outcome: 'complete' } },
      });
    });
    test('pending mail remains partial, preserves its last complete timestamp and returns matching health', async () => {
      const h = setup(provider);
      const oldComplete = '2026-01-01T00:00:00.000Z';
      h.row.syncState.health = { mail: { lastCompleteAt: oldComplete } };
      h.service.syncMail.mockResolvedValue({ ALL: { ...complete, hasMore: true } });
      const result = await h.run();
      expect(result.health.mail).toMatchObject({
        outcome: 'partial',
        hasMore: true,
        lastCompleteAt: oldComplete,
      });
      expect(h.row.syncState.health).toEqual(result.health);
    });
    test('OAuth supersession blocks stale cursor and health commit after both resources return', async () => {
      const h = setup(provider);
      const old = structuredClone(h.row.syncState);
      h.service.syncMail.mockImplementation(async () => {
        const attempt = await h.start();
        await h.callback(attempt.state);
        return { ALL: complete };
      });
      await expect(h.run()).rejects.toBeInstanceOf(MailboxClaimLostError);
      expect(h.row.syncState).toMatchObject(old);
      expect(h.row.syncState.health).toBeUndefined();
      expect(h.row.status).toBe('connected');
    });
  },
);

test.each([
  { hasMore: true, configured: true, recoveryPending: true },
  { hasMore: false, configured: false, recoveryPending: true },
  { hasMore: false, configured: true, recoveryPending: false },
])('Microsoft recovery waits for complete resources and subscription repair: %j', async (input) => {
  const h = setup('microsoft_365');
  h.row.syncState.webhooks = { recoveryPending: true, configured: input.configured };
  h.service.syncMail.mockResolvedValue({ ALL: { ...complete, hasMore: input.hasMore } });
  await h.run();
  expect(h.row.syncState.webhooks.recoveryPending).toBe(input.recoveryPending);
  expect(h.row.nextSyncAt.getTime()).toBeLessThanOrEqual(Date.now() + 20 * 60_000);
});

test('Google refresh stamps actual returned scopes; omitted scopes retain last verified evidence', async () => {
  const h = setup('google_workspace');
  h.row.token.expiresAt = new Date(0);
  h.row.token.scopes = GOOGLE_SCOPES;
  const granted = [...GOOGLE_SCOPES, 'https://example.invalid/extra-grant'];
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'fresh', scope: granted.join(' ') })),
    );
  await h.googleToken.getValidAccessToken(tenant, h.row.id, structuredClone(h.row.token));
  expect(h.row.syncState.scopeVerification.grantedScopes).toEqual(granted);
  expect(h.row.token.scopes).toEqual(granted);
  const verified = structuredClone(h.row.syncState.scopeVerification);
  h.row.token.expiresAt = new Date(0);
  fetch.mockResolvedValue(new Response(JSON.stringify({ access_token: 'fresh-again' })));
  await h.googleToken.getValidAccessToken(tenant, h.row.id, structuredClone(h.row.token));
  expect(h.row.syncState.scopeVerification).toEqual(verified);
  expect(h.row.token.scopes).toEqual(granted);
});

test('Microsoft refresh persists and stamps returned resource grants without inventing offline_access', async () => {
  const h = setup('microsoft_365');
  h.row.token.expiresAt = new Date(0);
  const granted = MICROSOFT_SCOPES.filter((scope) => scope !== 'offline_access');
  h.service.assertTokenRefreshConfigured = () => {};
  h.service.buildMsalClient = () => ({
    acquireTokenByRefreshToken: async () => ({
      accessToken: 'fresh',
      scopes: granted,
      account: { homeAccountId: h.row.token.homeAccountId },
      expiresOn: new Date(Date.now() + 3_600_000),
    }),
    getTokenCache: () => ({ serialize: () => '{}' }),
  });
  await h.service.getValidAccessToken(tenant, h.row.id, structuredClone(h.row.token));
  expect(h.row.scopes).toEqual(granted);
  expect(h.row.token.scopes).toEqual(granted);
  expect(h.row.syncState.scopeVerification.grantedScopes).toEqual(granted);
});
