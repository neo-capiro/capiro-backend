import { describe, expect, test } from '@jest/globals';
import { selectRefreshTokenForAccount } from './microsoft-oauth.service.js';

/**
 * Guards the Microsoft OAuth callback's refresh-token selection.
 *
 * Regression context (cross-tenant token contamination): extractRefreshToken()
 * used to return the LAST entry of the MSAL RefreshToken cache with no account
 * matching, while the MSAL client was a shared singleton whose cache could be
 * populated by two tenants' callbacks concurrently. Tenant A's callback could
 * therefore persist tenant B's refresh token and later mint access tokens for
 * B's mailbox. The exchange now uses a fresh per-callback client AND selection is
 * bound to home_account_id — this spec locks in the binding.
 */
describe('selectRefreshTokenForAccount', () => {
  const cacheWith = (
    entries: Array<{ key: string; homeAccountId: string; secret: string }>,
  ): string =>
    JSON.stringify({
      RefreshToken: Object.fromEntries(
        entries.map((e) => [
          e.key,
          {
            home_account_id: e.homeAccountId,
            environment: 'login.microsoftonline.com',
            credential_type: 'RefreshToken',
            client_id: 'client-123',
            secret: e.secret,
          },
        ]),
      ),
    });

  test('returns the token bound to home_account_id, NOT the last cache entry', () => {
    // Cache holds two accounts (the cross-tenant contamination scenario). The
    // matched account's token must win even though it is not the last entry.
    const serialized = cacheWith([
      { key: 'a-key', homeAccountId: 'tenantA.userA', secret: 'RT_A' },
      { key: 'b-key', homeAccountId: 'tenantB.userB', secret: 'RT_B' },
    ]);
    expect(selectRefreshTokenForAccount(serialized, 'tenantA.userA')).toBe('RT_A');
    expect(selectRefreshTokenForAccount(serialized, 'tenantB.userB')).toBe('RT_B');
  });

  test('returns the single account token when there is exactly one entry', () => {
    const serialized = cacheWith([
      { key: 'a-key', homeAccountId: 'tenantA.userA', secret: 'RT_A' },
    ]);
    expect(selectRefreshTokenForAccount(serialized, 'tenantA.userA')).toBe('RT_A');
  });

  test('fails closed when no home_account_id is available', () => {
    const serialized = cacheWith([
      { key: 'only-key', homeAccountId: 'tenantA.userA', secret: 'RT_A' },
    ]);
    expect(selectRefreshTokenForAccount(serialized, null)).toBeUndefined();
  });

  test('fails closed when the requested account is not present', () => {
    const serialized = cacheWith([
      { key: 'a-key', homeAccountId: 'tenantA.userA', secret: 'RT_A' },
    ]);
    expect(selectRefreshTokenForAccount(serialized, 'someone.else')).toBeUndefined();
  });

  test('returns undefined for an empty or absent RefreshToken cache', () => {
    expect(selectRefreshTokenForAccount(JSON.stringify({ RefreshToken: {} }), 'x')).toBeUndefined();
    expect(selectRefreshTokenForAccount(JSON.stringify({}), 'x')).toBeUndefined();
  });
});
