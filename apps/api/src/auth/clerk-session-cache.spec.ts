import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { ClerkService, type ClerkSessionClaims } from './clerk.service.js';
import { ApplicationAuthorityUnavailableException } from './application-authority-unavailable.js';

const NOW = 1_800_000_000_000;
const SUB = 'user_PRIVATE_SUB';
const SID = 'sess_PRIVATE_SID';
const JTI = 'credential_PRIVATE_JTI';
const mockGetSession = jest.fn<(id: string) => Promise<any>>();
const mockGetSessionList = jest.fn<(query: unknown) => Promise<any>>();

// Exercise the real owner, including deadlines and response validation. Only
// the external SDK transport is replaced; no session-cache internals are mocked.
jest.mock('@clerk/backend', () => ({
  createClerkClient: () => ({ sessions: {
    getSession: (id: string) => mockGetSession(id),
    getSessionList: (query: unknown) => mockGetSessionList(query),
  } }),
  verifyToken: async () => { throw new Error('PRIVATE_TOKEN must never be logged'); },
}));

function owner() {
  return new ClerkService({ get: () => 'synthetic-test-key' } as unknown as ConfigService<AppConfig, true>);
}
function native(delta: Partial<ClerkSessionClaims> = {}): ClerkSessionClaims {
  return { sub: SUB, sid: SID, iss: 'issuer', exp: NOW / 1000 + 120, ...delta };
}
function control(delta: Partial<ClerkSessionClaims> = {}): ClerkSessionClaims {
  return { sub: SUB, iss: 'issuer', jti: JTI, iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 120, meri_control_credential: true, ...delta };
}
function session(delta: Record<string, unknown> = {}) {
  return { id: SID, userId: SUB, status: 'active', createdAt: NOW - 1000,
    expireAt: NOW + 100_000, abandonAt: NOW + 90_000, actor: null, ...delta };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const kinds = ['native', 'control'] as const;
type Kind = typeof kinds[number];
function check(service: ClerkService, kind: Kind) {
  return kind === 'native'
    ? service.assertActiveApplicationAuthoritySession(native())
    : service.assertActiveMeriControlCredentialSession(control());
}
function transport(kind: Kind) { return kind === 'native' ? mockGetSession : mockGetSessionList; }
function answer(kind: Kind, row = session()) { return kind === 'native' ? row : { data: [row] }; }

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  mockGetSession.mockReset().mockImplementation(async () => session());
  mockGetSessionList.mockReset().mockImplementation(async () => ({ data: [session()] }));
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe.each(kinds)('positive-only %s Clerk authority cache', (kind) => {
  it('returns equal, distinct frozen proofs and hits before, but not at, the 5 second boundary', async () => {
    const service = owner();
    const first = await check(service, kind);
    jest.setSystemTime(NOW + 4999);
    const hit = await check(service, kind);
    expect(hit).toEqual(first); expect(hit).not.toBe(first);
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(hit)).toBe(true);
    expect(transport(kind)).toHaveBeenCalledTimes(1);
    jest.setSystemTime(NOW + 5000);
    await check(service, kind);
    expect(transport(kind)).toHaveBeenCalledTimes(2);
  });

  it('accepts the documented 4.9s revocation window, then refuses and never caches that refusal', async () => {
    const service = owner();
    await check(service, kind);
    transport(kind).mockResolvedValue(answer(kind, session({ status: 'revoked' })));
    jest.setSystemTime(NOW + 4900);
    await expect(check(service, kind)).resolves.toMatchObject({ status: 'active' });
    jest.setSystemTime(NOW + 5000);
    await expect(check(service, kind)).rejects.toMatchObject({ status: 401 });
    await expect(check(service, kind)).rejects.toMatchObject({ status: 401 });
    expect(transport(kind)).toHaveBeenCalledTimes(3);
  });

  it.each(['expireAt', 'abandonAt'])('expires a cached proof at its earlier %s', async (field) => {
    const service = owner();
    transport(kind).mockResolvedValue(answer(kind, session({ [field]: NOW + 2000 })));
    await check(service, kind);
    jest.setSystemTime(NOW + 2000);
    await expect(check(service, kind)).rejects.toMatchObject({ status: 401 });
    expect(transport(kind)).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['inactive', { status: 'ended' }], ['mismatched user', { userId: 'someone_else' }],
    ['malformed expiry', { expireAt: 'invalid' }], ['fractional abandonment', { abandonAt: NOW + 0.5 }],
  ])('does not cache an answered %s refusal', async (_name, delta) => {
    const service = owner();
    transport(kind).mockResolvedValue(answer(kind, session(delta as Record<string, unknown>)));
    for (let n = 0; n < 2; n++) await expect(check(service, kind)).rejects.toMatchObject({ status: 401 });
    expect(transport(kind)).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 422])('preserves an answered SDK %i as 401 without caching it', async (status) => {
    const service = owner(); transport(kind).mockRejectedValue({ status, message: 'PRIVATE_PROVIDER' });
    for (let n = 0; n < 2; n++) await expect(check(service, kind)).rejects.toMatchObject({ status: 401 });
    expect(transport(kind)).toHaveBeenCalledTimes(2);
  });

  it.each([new Error('PRIVATE_PROVIDER'), { status: 429 }, { status: 500 }, { status: 503 }])(
    'preserves unanswered SDK failure as 503, with one shared rejection and a fresh retry', async (error) => {
      const service = owner(); const io = deferred<any>(); transport(kind).mockReturnValue(io.promise);
      const requests = Array.from({ length: 8 }, () => check(service, kind));
      const outcomes = Promise.allSettled(requests);
      await Promise.resolve(); expect(transport(kind)).toHaveBeenCalledTimes(1);
      io.reject(error);
      const failures = (await outcomes).map((result) => {
        expect(result.status).toBe('rejected');
        return (result as PromiseRejectedResult).reason;
      });
      expect(failures[0]).toBeInstanceOf(ApplicationAuthorityUnavailableException);
      expect(failures.every((failure) => failure === failures[0])).toBe(true);
      expect(failures[0].getStatus()).toBe(503);
      transport(kind).mockResolvedValue(answer(kind));
      await check(service, kind); expect(transport(kind)).toHaveBeenCalledTimes(2);
    },
  );

  it('shares one answered 401 rejection, then allows a subsequent successful online check', async () => {
    const service = owner(); const io = deferred<any>(); transport(kind).mockReturnValue(io.promise);
    const outcomes = Promise.allSettled(Array.from({ length: 6 }, () => check(service, kind)));
    io.resolve(answer(kind, session({ status: 'ended' })));
    const failures = (await outcomes).map((result) => (result as PromiseRejectedResult).reason);
    expect(failures[0].getStatus()).toBe(401);
    expect(failures.every((failure) => failure === failures[0])).toBe(true);
    expect(transport(kind)).toHaveBeenCalledTimes(1);
    transport(kind).mockResolvedValue(answer(kind));
    await check(service, kind); expect(transport(kind)).toHaveBeenCalledTimes(2);
  });

  it('coalesces successful concurrent checks and returns a fresh frozen proof to each caller', async () => {
    const service = owner(); const io = deferred<any>(); transport(kind).mockReturnValue(io.promise);
    const waiting = Promise.all(Array.from({ length: 12 }, () => check(service, kind)));
    await Promise.resolve(); expect(transport(kind)).toHaveBeenCalledTimes(1);
    io.resolve(answer(kind));
    const results = await waiting;
    expect(new Set(results).size).toBe(12);
    results.forEach((result) => { expect(result).toEqual(results[0]); expect(Object.isFrozen(result)).toBe(true); });
    await check(service, kind); expect(transport(kind)).toHaveBeenCalledTimes(1);
  });

  it('gives a late follower only the leader deadline and ignores late success after timeout', async () => {
    const service = owner(); const io = deferred<any>(); transport(kind).mockReturnValue(io.promise);
    const leader = check(service, kind);
    // Attach handlers before advancing timers so a deliberate deadline rejection
    // cannot become an unhandled rejection in the test process.
    const leaderOutcome = leader.catch((error) => error);
    await jest.advanceTimersByTimeAsync(1000);
    const followerOutcome = check(service, kind).catch((error) => error);
    await jest.advanceTimersByTimeAsync(999);
    expect(transport(kind)).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    const failure = await leaderOutcome;
    expect(failure).toBeInstanceOf(ApplicationAuthorityUnavailableException);
    expect(await followerOutcome).toBe(failure);
    io.resolve(answer(kind)); await Promise.resolve(); await Promise.resolve();
    transport(kind).mockResolvedValue(answer(kind));
    await check(service, kind); expect(transport(kind)).toHaveBeenCalledTimes(2);
  });
});

describe('cache claims, ownership and bounds', () => {
  it('deep-copies and freezes actor facts so neither provider nor caller can mutate a future hit', async () => {
    const actor = { sub: 'actor_original', detail: { roles: ['admin'] } };
    mockGetSession.mockResolvedValue(session({ actor }));
    const service = owner(); const first = await service.assertActiveApplicationAuthoritySession(native());
    actor.sub = 'actor_changed'; actor.detail.roles.push('unexpected');
    expect(Object.isFrozen(first.actor)).toBe(true);
    expect(Object.isFrozen((first.actor as any).detail)).toBe(true);
    expect(Object.isFrozen((first.actor as any).detail.roles)).toBe(true);
    expect(() => { (first.actor as any).detail.roles.push('tamper'); }).toThrow();
    const hit = await service.assertActiveApplicationAuthoritySession(native());
    expect(hit.actor).toEqual({ sub: 'actor_original', detail: { roles: ['admin'] } });
    expect(hit.actor).not.toBe(first.actor);
    expect((hit.actor as any).detail).not.toBe((first.actor as any).detail);
  });

  it('refuses malformed actor prototypes without caching them and recovers on a valid provider response', async () => {
    class UnexpectedActor { sub = 'unexpected'; }
    mockGetSession.mockResolvedValue(session({ actor: new UnexpectedActor() }));
    const service = owner();
    for (let n = 0; n < 2; n++) await expect(service.assertActiveApplicationAuthoritySession(native())).rejects.toMatchObject({ status: 401 });
    expect(mockGetSession).toHaveBeenCalledTimes(2);
    mockGetSession.mockResolvedValue(session({ actor: { sub: 'valid_actor' } }));
    await expect(service.assertActiveApplicationAuthoritySession(native())).resolves.toMatchObject({ actor: { sub: 'valid_actor' } });
    await service.assertActiveApplicationAuthoritySession(native());
    expect(mockGetSession).toHaveBeenCalledTimes(3);
  });

  it('refuses proxy actor facts without invoking traps, normalizing the proxy, or caching the failure', async () => {
    const trap = jest.fn(() => { throw new Error('Proxy trap must not execute'); });
    const actor = new Proxy({ sub: 'actor' }, { ownKeys: trap, getPrototypeOf: trap });
    mockGetSession.mockResolvedValue(session({ actor }));
    const service = owner();
    for (let n = 0; n < 2; n++) {
      await expect(service.assertActiveApplicationAuthoritySession(native())).rejects.toMatchObject({ status: 401 });
    }
    expect(trap).not.toHaveBeenCalled(); expect(mockGetSession).toHaveBeenCalledTimes(2);
  });

  it('refuses accessor actor facts without invocation and shares that same 401 among followers', async () => {
    const getter = jest.fn(() => 'never read');
    const actor = Object.defineProperty({}, 'sub', { enumerable: true, get: getter });
    const service = owner(); const io = deferred<any>(); mockGetSession.mockReturnValue(io.promise);
    const outcomes = Promise.allSettled(Array.from({ length: 4 }, () => service.assertActiveApplicationAuthoritySession(native())));
    io.resolve(session({ actor }));
    const failures = (await outcomes).map((result) => (result as PromiseRejectedResult).reason);
    expect(failures[0].getStatus()).toBe(401);
    expect(failures.every((failure) => failure === failures[0])).toBe(true);
    await expect(service.assertActiveApplicationAuthoritySession(native())).rejects.toMatchObject({ status: 401 });
    expect(getter).not.toHaveBeenCalled(); expect(mockGetSession).toHaveBeenCalledTimes(2);
  });

  it('refuses cyclic actor facts but permits shared references and null-prototype records', async () => {
    const actor: Record<string, unknown> = {}; actor.self = actor;
    const service = owner(); mockGetSession.mockResolvedValue(session({ actor }));
    for (let n = 0; n < 2; n++) await expect(service.assertActiveApplicationAuthoritySession(native())).rejects.toMatchObject({ status: 401 });
    expect(mockGetSession).toHaveBeenCalledTimes(2);
    const shared = Object.assign(Object.create(null), { sub: 'shared_actor' });
    mockGetSession.mockResolvedValue(session({ actor: { first: shared, second: shared } }));
    const valid = await service.assertActiveApplicationAuthoritySession(native());
    expect(valid.actor).toEqual({ first: { sub: 'shared_actor' }, second: { sub: 'shared_actor' } });
    expect(Object.getPrototypeOf((valid.actor as any).first)).toBeNull();
    expect(Object.isFrozen((valid.actor as any).first)).toBe(true);
    await service.assertActiveApplicationAuthoritySession(native()); expect(mockGetSession).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['undefined', { sub: undefined }], ['function', { sub: () => 'actor' }],
    ['symbol value', { sub: Symbol('actor') }], ['symbol key', { [Symbol('actor')]: 'value' }],
    ['nonfinite', { value: Number.POSITIVE_INFINITY }], ['bigint', { value: BigInt(1) }],
    ['null-prototype array', { values: Object.setPrototypeOf([1], null) }],
    ['custom-prototype array', { values: Object.setPrototypeOf([1], {}) }],
    ['overlong string', { sub: 'x'.repeat(4097) }],
    ['overlong array', { values: Array.from({ length: 129 }, () => 1) }],
    ['too many keys', Object.fromEntries(Array.from({ length: 129 }, (_, n) => [`key_${n}`, n]))],
    ['too deep', Array.from({ length: 12 }).reduce<Record<string, unknown>>((child) => ({ child }), {})],
  ])('does not cache %s actor facts refused by the identity grammar', async (_name, actor) => {
    const service = owner(); mockGetSession.mockResolvedValue(session({ actor }));
    for (let n = 0; n < 2; n++) await expect(service.assertActiveApplicationAuthoritySession(native())).rejects.toMatchObject({ status: 401 });
    expect(mockGetSession).toHaveBeenCalledTimes(2);
  });

  it('caps both a positive hit and a single-flight follower at their own shorter JWT expiry', async () => {
    const service = owner(); const io = deferred<any>(); mockGetSession.mockReturnValue(io.promise);
    const leader = service.assertActiveApplicationAuthoritySession(native());
    const follower = service.assertActiveApplicationAuthoritySession(native({ exp: NOW / 1000 + 2 }));
    io.resolve(session());
    expect((await leader).expiresAtMs).toBe(NOW + 90_000);
    expect((await follower).expiresAtMs).toBe(NOW + 2000);
    expect((await service.assertActiveApplicationAuthoritySession(native({ exp: NOW / 1000 + 1 }))).expiresAtMs).toBe(NOW + 1000);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a follower whose own JWT expired while waiting, without invalidating the leader proof', async () => {
    const service = owner(); const io = deferred<any>(); mockGetSession.mockReturnValue(io.promise);
    const leader = service.assertActiveApplicationAuthoritySession(native());
    const follower = service.assertActiveApplicationAuthoritySession(native({ exp: NOW / 1000 + 1 }));
    const outcome = follower.catch((error) => error);
    jest.setSystemTime(NOW + 1000); io.resolve(session());
    await leader; expect((await outcome).getStatus()).toBe(401);
    await service.assertActiveApplicationAuthoritySession(native());
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('never extends a cached short leader JWT; the longer JWT must reread when that entry expires', async () => {
    const service = owner();
    await service.assertActiveApplicationAuthoritySession(native({ exp: NOW / 1000 + 1 }));
    jest.setSystemTime(NOW + 1000);
    await expect(service.assertActiveApplicationAuthoritySession(native({ exp: NOW / 1000 + 1 }))).rejects.toMatchObject({ status: 401 });
    expect(mockGetSession).toHaveBeenCalledTimes(1); // Expired claims fail before any cache lookup.
    await service.assertActiveApplicationAuthoritySession(native());
    expect(mockGetSession).toHaveBeenCalledTimes(2);
  });

  it('separates sid/sub and all control instance fields and never shares across credential kinds', async () => {
    const service = owner();
    await service.assertActiveApplicationAuthoritySession(native());
    await expect(service.assertActiveApplicationAuthoritySession(native({ sub: 'other_user' }))).rejects.toMatchObject({ status: 401 });
    mockGetSession.mockImplementation(async (id) => session({ id }));
    await service.assertActiveApplicationAuthoritySession(native({ sid: 'other_session' }));
    for (const delta of [{}, { jti: 'other_jti' }, { iat: NOW / 1000 - 11 }, { exp: NOW / 1000 + 121 }]) {
      await service.assertActiveMeriControlCredentialSession(control(delta));
    }
    await expect(service.assertActiveMeriControlCredentialSession(control({ sub: 'other_user' }))).rejects.toMatchObject({ status: 401 });
    expect(mockGetSession).toHaveBeenCalledTimes(3); expect(mockGetSessionList).toHaveBeenCalledTimes(5);
  });

  it('rechecks malformed native and control claims before an otherwise positive cache hit', async () => {
    const service = owner();
    await service.assertActiveApplicationAuthoritySession(native());
    await service.assertActiveMeriControlCredentialSession(control());
    for (const delta of [{ exp: 1 }, { exp: Number.MAX_SAFE_INTEGER }, { meri_control_credential: true }, { sid: '../bad' }]) {
      await expect(service.assertActiveApplicationAuthoritySession(native(delta))).rejects.toMatchObject({ status: 401 });
    }
    for (const delta of [{ meri_control_credential: false }, { sid: SID }, { exp: 1 }, { jti: '../bad' }, { iat: NOW / 1000 + 6 }]) {
      await expect(service.assertActiveMeriControlCredentialSession(control(delta))).rejects.toMatchObject({ status: 401 });
    }
    expect(mockGetSession).toHaveBeenCalledTimes(1); expect(mockGetSessionList).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { data: null }, { data: [] }])('never caches malformed or empty list %j', async (response) => {
    const service = owner(); mockGetSessionList.mockResolvedValue(response);
    for (let n = 0; n < 2; n++) await expect(service.assertActiveMeriControlCredentialSession(control())).rejects.toMatchObject({ status: 401 });
    expect(mockGetSessionList).toHaveBeenCalledTimes(2);
  });

  it('caps entries at 10000, evicts oldest insertion, and drops expired entries on insertion', async () => {
    const service = owner(); mockGetSession.mockImplementation(async (id) => session({ id }));
    for (let n = 0; n <= 10_000; n++) {
      await service.assertActiveApplicationAuthoritySession(native({ sid: `session_${n}` }));
      expect((service as any).applicationSessionCache.size).toBeLessThanOrEqual(10_000);
    }
    const count = mockGetSession.mock.calls.length;
    await service.assertActiveApplicationAuthoritySession(native({ sid: 'session_1' }));
    expect(mockGetSession).toHaveBeenCalledTimes(count);
    await service.assertActiveApplicationAuthoritySession(native({ sid: 'session_0' }));
    expect(mockGetSession).toHaveBeenCalledTimes(count + 1);
    jest.setSystemTime(NOW + 5000);
    await service.assertActiveApplicationAuthoritySession(native({ sid: 'after_expiry' }));
    expect((service as any).applicationSessionCache.size).toBe(1);
    expect(jest.getTimerCount()).toBe(0); // No maintenance or refresh timers.
  }, 30_000);

  it('emits only aggregate counters once per traffic window, separating refused and unavailable', async () => {
    const service = owner(); const io = deferred<any>(); mockGetSession.mockReturnValue(io.promise);
    const first = service.assertActiveApplicationAuthoritySession(native());
    const join = service.assertActiveApplicationAuthoritySession(native());
    io.resolve(session()); await Promise.all([first, join]);
    await service.assertActiveApplicationAuthoritySession(native());
    await expect(service.assertActiveApplicationAuthoritySession(native({ exp: 1 }))).rejects.toMatchObject({ status: 401 });
    mockGetSessionList.mockRejectedValue({ status: 503, message: 'PRIVATE_TOKEN' });
    await expect(service.assertActiveMeriControlCredentialSession(control())).rejects.toBeInstanceOf(ApplicationAuthorityUnavailableException);
    jest.setSystemTime(NOW + 59_999); expect(Logger.prototype.log).not.toHaveBeenCalled();
    jest.setSystemTime(NOW + 60_000);
    mockGetSession.mockResolvedValue(session());
    await service.assertActiveApplicationAuthoritySession(native());
    expect(Logger.prototype.log).toHaveBeenCalledTimes(1);
    const line = (Logger.prototype.log as jest.Mock).mock.calls[0]![0] as string;
    expect(JSON.parse(line)).toEqual({ event: 'auth.clerk_session_cache', hits: 1, misses: 2,
      joins: 1, refused: 1, unavailable: 1, entries: 1 });
    for (const marker of [SID, SUB, JTI, 'PRIVATE_TOKEN', 'PRIVATE_PROVIDER', 'sid', 'sub', 'jti', 'token']) expect(line).not.toContain(marker);
    await service.assertActiveApplicationAuthoritySession(native());
    expect(Logger.prototype.log).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not emit a zero-traffic cache line after an idle first minute', async () => {
    const service = owner(); jest.setSystemTime(NOW + 60_000);
    await service.assertActiveApplicationAuthoritySession(native());
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });
});
