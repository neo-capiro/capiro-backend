import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { ClerkService, type ClerkSessionClaims } from './clerk.service.js';

const userId = 'user_control';
const sessionId = 'sess_native';

function activeSession() {
  const now = Date.now();
  return {
    id: sessionId, userId, status: 'active',
    createdAt: now - 60_000, expireAt: now + 120_000,
    abandonAt: now + 90_000, actor: null,
  };
}

const mockGetSession = jest.fn(async (_id: string) => activeSession());
const mockGetSessionList = jest.fn(async (_query: { userId: string; status: string }) => ({
  data: [activeSession()],
}));

// The Clerk SDK's runtime #crypto import is not resolved by Jest. Exercise the
// actual ClerkService methods with only its online SDK reads replaced.
jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({
    sessions: {
      getSession: (id: string) => mockGetSession(id),
      getSessionList: (query: { userId: string; status: string }) => mockGetSessionList(query),
    },
  }),
  verifyToken: async () => { throw new Error('Token verification is outside this assertion test'); },
}));

function owner(): ClerkService {
  const config = {
    get: (key: string) => key === 'CLERK_SECRET_KEY' ? 'synthetic-test-key' : undefined,
  } as unknown as ConfigService<AppConfig, true>;
  return new ClerkService(config);
}

function nativeClaims(): ClerkSessionClaims {
  return { sub: userId, iss: 'https://clerk.test', sid: sessionId,
    exp: Math.floor(Date.now() / 1000) + 60 };
}

function controlClaims(): ClerkSessionClaims {
  const iat = Math.floor(Date.now() / 1000) - 10;
  return { sub: userId, iss: 'https://clerk.test', iat, exp: iat + 60,
    jti: 'control_jti', meri_control_credential: true } as ClerkSessionClaims;
}

beforeEach(() => {
  mockGetSession.mockReset();
  mockGetSession.mockImplementation(async () => activeSession());
  mockGetSessionList.mockReset();
  mockGetSessionList.mockImplementation(async () => ({ data: [activeSession()] }));
});

describe('ClerkService native session and named Meri control assertion', () => {
  it('keeps ordinary native sid authority on the single-session read', async () => {
    const claims = nativeClaims();
    const row = activeSession();
    mockGetSession.mockResolvedValue(row);
    const receipt = await owner().assertActiveApplicationAuthoritySession(claims);
    expect(mockGetSession).toHaveBeenCalledWith(sessionId);
    expect(mockGetSessionList).not.toHaveBeenCalled();
    expect(receipt.id).toBe(sessionId);
    expect(receipt.userId).toBe(userId);
    expect(receipt.expiresAtMs).toBe(Math.min(
      claims.exp! * 1000, row.expireAt, row.abandonAt,
    ));
  });

  it('refuses the marked sidless credential on the native-only assertion before SDK work', async () => {
    await expect(owner().assertActiveApplicationAuthoritySession(controlClaims()))
      .rejects.toThrow('Application authority unavailable');
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetSessionList).not.toHaveBeenCalled();
  });

  it('allows the marked credential only through the named control assertion and a current user session', async () => {
    const claims = controlClaims();
    const row = activeSession();
    mockGetSessionList.mockResolvedValue({ data: [row] });
    const receipt = await owner().assertActiveMeriControlCredentialSession(claims);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetSessionList).toHaveBeenCalledWith({ userId, status: 'active' });
    expect(receipt.id).toBe('meri-template:control_jti');
    expect(receipt.userId).toBe(userId);
    expect(receipt.expiresAtMs).toBe(Math.min(claims.exp! * 1000, row.abandonAt));
  });

  it('reuses only the same control credential instance and returns fresh frozen receipts', async () => {
    const service = owner();
    const claims = controlClaims();
    const first = await service.assertActiveMeriControlCredentialSession(claims);
    const second = await service.assertActiveMeriControlCredentialSession(claims);
    expect(second).toEqual(first); expect(second).not.toBe(first);
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(second)).toBe(true);
    expect(mockGetSessionList).toHaveBeenCalledTimes(1);
    await service.assertActiveMeriControlCredentialSession({ ...claims, jti: 'next_control_jti' });
    expect(mockGetSessionList).toHaveBeenCalledTimes(2);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('never lets a positive control cache entry admit the same marked token through the native assertion', async () => {
    const service = owner(); const claims = controlClaims();
    await service.assertActiveMeriControlCredentialSession(claims);
    await expect(service.assertActiveApplicationAuthoritySession(claims)).rejects.toMatchObject({ status: 401 });
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetSessionList).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'unmarked token', delta: { meri_control_credential: undefined } },
    { name: 'false marker', delta: { meri_control_credential: false } },
    { name: 'native sid on marked credential', delta: { sid: sessionId } },
    { name: 'missing jti', delta: { jti: undefined } },
    { name: 'path-shaped jti', delta: { jti: '../escape' } },
    { name: 'future issue time', delta: { iat: Math.floor(Date.now() / 1000) + 60,
      exp: Math.floor(Date.now() / 1000) + 120 } },
    { name: 'expired token', delta: { exp: 1 } },
    { name: 'overlong lifetime', delta: { exp: Math.floor(Date.now() / 1000) + 604_801 } },
  ])('refuses $name before online list access', async ({ delta }) => {
    const claims = { ...controlClaims(), ...delta } as ClerkSessionClaims;
    await expect(owner().assertActiveMeriControlCredentialSession(claims))
      .rejects.toThrow('Application authority unavailable');
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetSessionList).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'no active session', response: { data: [] } },
    { name: 'different actor', response: { data: [{ ...activeSession(), userId: 'user_other' }] } },
    { name: 'expired session', response: { data: [{ ...activeSession(), abandonAt: 1 }] } },
    { name: 'unexpected response', response: { data: null } },
  ])('refuses $name after the online list read', async ({ response }) => {
    mockGetSessionList.mockImplementation(async () => response as unknown as { data: ReturnType<typeof activeSession>[] });
    await expect(owner().assertActiveMeriControlCredentialSession(controlClaims()))
      .rejects.toThrow('Application authority unavailable');
    expect(mockGetSessionList).toHaveBeenCalledTimes(1);
  });

  it('refuses an online provider failure without exposing its error', async () => {
    mockGetSessionList.mockImplementation(async () => { throw new Error('private provider detail'); });
    await expect(owner().assertActiveMeriControlCredentialSession(controlClaims()))
      .rejects.toThrow('Application authority unavailable');
  });
});
