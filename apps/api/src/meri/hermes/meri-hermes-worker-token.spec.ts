import {
  mintMeriHermesWorkerToken,
  privateExecutionScopeId,
  verifyMeriHermesWorkerToken,
} from './meri-hermes-worker-token.js';

const KEY = 'phase0-test-signing-key-0123456789abcdef';
const OTHER_KEY = 'another-signing-key-fedcba9876543210zz';
const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = {
  executionScopeId: privateExecutionScopeId(TENANT, USER),
  tenantId: TENANT,
  actorType: 'user' as const,
  actorId: USER,
  authorizationVersion: 'v1',
};

describe('Meri Hermes worker token', () => {
  test('round-trips its scope claims', () => {
    const now = new Date('2026-09-19T12:00:00Z');
    const { token, claims } = mintMeriHermesWorkerToken({ ...base, ttlSeconds: 600 }, KEY, now);
    const verified = verifyMeriHermesWorkerToken(token, KEY, new Date('2026-09-19T12:05:00Z'));
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims).toEqual(claims);
      expect(verified.claims.exp - verified.claims.iat).toBe(600);
    }
  });

  test('rejects a token signed with another key, a tampered payload, and garbage', () => {
    const { token } = mintMeriHermesWorkerToken(base, KEY);
    expect(verifyMeriHermesWorkerToken(token, OTHER_KEY)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const [p, payload, sig] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const tampered = Buffer.from(
      JSON.stringify({ ...decoded, tenantId: 'c60da102-8c0e-4590-a356-686784f7c51f' }),
    ).toString('base64url');
    expect(verifyMeriHermesWorkerToken(`${p}.${tampered}.${sig}`, KEY)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyMeriHermesWorkerToken('not-a-token', KEY)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyMeriHermesWorkerToken('', KEY)).toEqual({ ok: false, reason: 'malformed' });
  });

  test('expires and clamps TTL', () => {
    const now = new Date('2026-09-19T12:00:00Z');
    const { token } = mintMeriHermesWorkerToken({ ...base, ttlSeconds: 60 }, KEY, now);
    expect(verifyMeriHermesWorkerToken(token, KEY, new Date('2026-09-19T12:01:01Z'))).toEqual({
      ok: false,
      reason: 'expired',
    });
    const { claims } = mintMeriHermesWorkerToken({ ...base, ttlSeconds: 10 ** 9 }, KEY, now);
    expect(claims.exp - claims.iat).toBe(12 * 60 * 60);
  });

  test('refuses weak signing keys', () => {
    expect(() => mintMeriHermesWorkerToken(base, 'short')).toThrow(/32 characters/);
  });
});
