import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config/config.schema.js';
import { GoogleTokenService } from './google/google-token.service.js';
import { harness, tenant } from './mailbox-oauth.a1-fixture.js';
import { MICROSOFT_SCOPES } from './microsoft/microsoft-oauth-constants.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { TokenCryptoService } from './microsoft/token-crypto.service.js';

/**
 * ML-25 (reviewer finding F1): a successful refresh advances the row's single
 * `key_version`, so every envelope in that row has to be rewritten from the active
 * key inside the same update. These cases drive the real owner refresh paths with the
 * real AES-256-GCM service configured for an active+previous-key window and then
 * decrypt BOTH persisted envelopes using only the version the row records - the
 * ciphertext is real, so nothing here can pass by echoing its arguments.
 *
 * Every key and token value is synthetic and generated in-process. No deployment key
 * is read or written, and nothing here performs a rotation.
 */
const ACTIVE_VERSION = 'v-active';
const PREVIOUS_VERSION = 'v-previous';
const syntheticKey = () => randomBytes(32).toString('base64');

const STORED_ACCESS = 'synthetic-stored-access-token';
const STORED_REFRESH = 'synthetic-stored-refresh-token';
const REFRESHED_ACCESS = 'synthetic-refreshed-access-token';
const ROTATED_REFRESH = 'synthetic-rotated-refresh-token';

const cryptoFrom = (env: Record<string, string | undefined>) =>
  new TokenCryptoService({ get: (key: string) => env[key] } as unknown as ConfigService<
    AppConfig,
    true
  >);

/** The deployment window under test: active key plus one explicitly configured previous key. */
const windowKeys = (previousKey: string, activeKey: string) =>
  cryptoFrom({
    OAUTH_TOKEN_ENCRYPTION_KEY: activeKey,
    OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: ACTIVE_VERSION,
    OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY: previousKey,
    OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION: PREVIOUS_VERSION,
  });

/** The same key material in its pre-rotation shape, used only to write the stored row. */
const previousKeyOnly = (previousKey: string) =>
  cryptoFrom({
    OAUTH_TOKEN_ENCRYPTION_KEY: previousKey,
    OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: PREVIOUS_VERSION,
  });

const envelope = (crypto: TokenCryptoService, value: string) => {
  const written = crypto.encrypt(value);
  return { ciphertext: written.ciphertext, iv: written.iv, authTag: written.authTag };
};

/** Stamp the fixture row as one written before the rotation: both envelopes under the previous key. */
function seedPreviousKeyRow(h: ReturnType<typeof harness>, previous: TokenCryptoService) {
  const access = envelope(previous, STORED_ACCESS);
  const refresh = envelope(previous, STORED_REFRESH);
  const row = h.rows.get('connection-A').token;
  Object.assign(row, {
    accessTokenCiphertext: access.ciphertext,
    accessTokenIv: access.iv,
    accessTokenAuthTag: access.authTag,
    refreshTokenCiphertext: refresh.ciphertext,
    refreshTokenIv: refresh.iv,
    refreshTokenAuthTag: refresh.authTag,
    keyVersion: PREVIOUS_VERSION,
    expiresAt: new Date(0),
  });
  return row;
}

/** The row's single recorded version must open both of its envelopes. */
function expectRowReadsUnderStampedVersion(
  crypto: TokenCryptoService,
  row: { [key: string]: any },
  expectedRefresh: string,
) {
  expect(row.keyVersion).toBe(ACTIVE_VERSION);
  expect(
    crypto.decrypt(
      {
        ciphertext: row.accessTokenCiphertext,
        iv: row.accessTokenIv,
        authTag: row.accessTokenAuthTag,
      },
      row.keyVersion,
    ),
  ).toBe(REFRESHED_ACCESS);
  expect(
    crypto.decrypt(
      {
        ciphertext: row.refreshTokenCiphertext,
        iv: row.refreshTokenIv,
        authTag: row.refreshTokenAuthTag,
      },
      row.keyVersion,
    ),
  ).toBe(expectedRefresh);
}

describe('refresh keeps a token row internally coherent across a key rotation', () => {
  test('a successful Google refresh rewrites the refresh envelope it kept under the stamped version', async () => {
    const h = harness('google_workspace');
    const previousKey = syntheticKey();
    const crypto = windowKeys(previousKey, syntheticKey());
    const stored = seedPreviousKeyRow(h, previousKeyOnly(previousKey));
    const snapshot = structuredClone(stored);

    const service: any = Object.create(GoogleTokenService.prototype);
    Object.assign(service, {
      prisma: h.prisma,
      tokenCrypto: crypto,
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-client-secret',
    });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: REFRESHED_ACCESS, expires_in: 3600 }),
    } as any);
    try {
      await expect(service.getValidAccessToken(tenant, 'connection-A', snapshot)).resolves.toBe(
        REFRESHED_ACCESS,
      );
    } finally {
      fetchSpy.mockRestore();
    }

    const row = h.rows.get('connection-A').token;
    expect(row.refreshTokenCiphertext).not.toBe(snapshot.refreshTokenCiphertext);
    // Google does not rotate on redemption, so the value that was redeemed is the one
    // that has to survive - re-encrypted here rather than left on the previous key.
    expectRowReadsUnderStampedVersion(crypto, row, STORED_REFRESH);
    // The previous key is no longer needed to read this row.
    expect(() =>
      previousKeyOnly(previousKey).decrypt(
        {
          ciphertext: row.refreshTokenCiphertext,
          iv: row.refreshTokenIv,
          authTag: row.refreshTokenAuthTag,
        },
        PREVIOUS_VERSION,
      ),
    ).toThrow();
  });

  test('a Microsoft refresh that produced no rotated token still rewrites both envelopes', async () => {
    const h = harness('microsoft_365');
    const previousKey = syntheticKey();
    const crypto = windowKeys(previousKey, syntheticKey());
    const stored = seedPreviousKeyRow(h, previousKeyOnly(previousKey));
    const snapshot = structuredClone(stored);

    const service: any = Object.create(MicrosoftGraphSyncService.prototype);
    Object.assign(service, {
      prisma: h.prisma,
      tokenCrypto: crypto,
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    service.assertTokenRefreshConfigured = () => {};
    service.buildMsalClient = () => ({
      acquireTokenByRefreshToken: async () => ({
        accessToken: REFRESHED_ACCESS,
        expiresOn: new Date(Date.now() + 3600_000),
        account: { homeAccountId: 'account-A' },
        scopes: MICROSOFT_SCOPES,
      }),
      // Azure rotation extraction is best-effort: no matching cache entry this time.
      getTokenCache: () => ({ serialize: () => JSON.stringify({ RefreshToken: {} }) }),
    });

    await expect(service.getValidAccessToken(tenant, 'connection-A', snapshot)).resolves.toBe(
      REFRESHED_ACCESS,
    );

    const row = h.rows.get('connection-A').token;
    expect(row.refreshTokenCiphertext).not.toBe(snapshot.refreshTokenCiphertext);
    // The redeemed refresh token is the fallback, so the row must not keep the
    // previous key's envelope behind an advanced key_version.
    expectRowReadsUnderStampedVersion(crypto, row, STORED_REFRESH);
  });

  test('a Microsoft refresh prefers the refresh token Azure actually issued', async () => {
    const h = harness('microsoft_365');
    const previousKey = syntheticKey();
    const crypto = windowKeys(previousKey, syntheticKey());
    const stored = seedPreviousKeyRow(h, previousKeyOnly(previousKey));
    const snapshot = structuredClone(stored);

    const service: any = Object.create(MicrosoftGraphSyncService.prototype);
    Object.assign(service, {
      prisma: h.prisma,
      tokenCrypto: crypto,
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    service.assertTokenRefreshConfigured = () => {};
    service.buildMsalClient = () => ({
      acquireTokenByRefreshToken: async () => ({
        accessToken: REFRESHED_ACCESS,
        expiresOn: new Date(Date.now() + 3600_000),
        account: { homeAccountId: 'account-A' },
        scopes: MICROSOFT_SCOPES,
      }),
      getTokenCache: () => ({
        serialize: () =>
          JSON.stringify({
            RefreshToken: { 'rt-1': { secret: ROTATED_REFRESH, home_account_id: 'account-A' } },
          }),
      }),
    });

    await expect(service.getValidAccessToken(tenant, 'connection-A', snapshot)).resolves.toBe(
      REFRESHED_ACCESS,
    );

    const row = h.rows.get('connection-A').token;
    expectRowReadsUnderStampedVersion(crypto, row, ROTATED_REFRESH);
  });
});
