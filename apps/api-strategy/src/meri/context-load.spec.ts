import { describe, expect, it, jest } from '@jest/globals';
import { isTransientLoadError, withContextRetry } from './context-load.js';
import type { ContextRetryRuntime } from './strategy-time.providers.js';

/*
 * Phase 5 §3.2 — bounded retry for transient draft-context loads. Injected delay
 * and randomness preserve the existing cases without waiting on real timers.
 */
function runtime(random: () => number = () => 0): ContextRetryRuntime {
  return { random, delay: async () => undefined };
}
describe('isTransientLoadError', () => {
  it.each([
    ['Prisma P1001 (cannot reach database)', { code: 'P1001' }],
    ['Prisma P1008 (operation timeout)', { code: 'P1008' }],
    ['Prisma P1017 (server closed the connection)', { code: 'P1017' }],
    ['Prisma P2024 (pool timeout)', { code: 'P2024' }],
    ['Prisma P2028 (transaction API error)', { code: 'P2028' }],
    ['AbortError', { name: 'AbortError' }],
    ['ECONNRESET', { message: 'read ECONNRESET' }],
    ['ECONNREFUSED', { message: 'connect ECONNREFUSED 127.0.0.1:5432' }],
    ['ETIMEDOUT', { message: 'connect ETIMEDOUT' }],
    ['EAI_AGAIN', { message: 'getaddrinfo EAI_AGAIN db.internal' }],
    ['EPIPE', { message: 'write EPIPE' }],
    ['socket hang up', { message: 'socket hang up' }],
    ['a bare "timeout" message', { message: 'Request timeout' }],
    ['a bare "timed out" message', { message: 'The operation timed out' }],
    ['HTTP 500', { status: 500 }],
    ['HTTP 503', { status: 503 }],
  ])('is transient: %s', (_label, err) => {
    expect(isTransientLoadError(err)).toBe(true);
  });

  it.each([
    ['a plain validation Error', new Error('goal must be at most 4000 characters')],
    ['HTTP 400', { status: 400 }],
    ['HTTP 404', { status: 404 }],
    ['a Prisma not-found code (not in the transient set)', { code: 'P2025' }],
    ['null', null],
    ['undefined', undefined],
    ['a string throw', 'boom'],
  ])('is NOT transient: %s', (_label, err) => {
    expect(isTransientLoadError(err)).toBe(false);
  });
});

describe('withContextRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const fn = jest.fn(async () => 'ok');

    await expect(withContextRetry('client-existence', fn, runtime())).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds on the third attempt (plan §9.1)', async () => {
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: 'P1001' })
      .mockRejectedValueOnce({ code: 'P2024' })
      .mockResolvedValueOnce('ok on the third try');

    await expect(withContextRetry('firm-phases', fn, runtime())).resolves.toBe('ok on the third try');

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient validation/auth failure (plan §9.2)', async () => {
    const err = new Error('Unknown client for this tenant');
    const fn = jest.fn(async () => {
      throw err;
    });

    await expect(withContextRetry('client-existence', fn, runtime())).rejects.toThrow(
      'Unknown client for this tenant',
    );
    // Final on attempt one — retrying a bad request would only delay the same answer.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts MAX_RETRIES (2) and rethrows the last transient error', async () => {
    const err = { code: 'P1017', message: 'server closed the connection' };
    const fn = jest.fn(async () => {
      throw err;
    });

    await expect(withContextRetry('reference-calendars', fn, runtime())).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries, never more
  });
});

describe('withContextRetry injected randomness and delay', () => {
  it('samples once per retry and retains the exact jitter floor and two backoff bases', async () => {
    const random = jest.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(0.999999);
    const delay = jest.fn<(ms: number) => Promise<void>>(async () => undefined);
    const fn = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: 'P1001' })
      .mockRejectedValueOnce({ code: 'P2024' })
      .mockResolvedValueOnce('recovered');

    await expect(withContextRetry('reference-calendars', fn, { random, delay })).resolves.toBe('recovered');
    expect(delay.mock.calls).toEqual([[200], [474]]);
    expect(random).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not sample randomness or wait on a successful or explicitly empty source', async () => {
    const random = jest.fn(() => 0.5);
    const delay = jest.fn<(ms: number) => Promise<void>>(async () => undefined);
    await expect(withContextRetry('empty-source', async () => [], { random, delay })).resolves.toEqual([]);
    expect(random).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
  });

  it('does not wait or sample for a non-transient denial', async () => {
    const error = { status: 403, message: 'Forbidden' };
    const random = jest.fn(() => 0.5);
    const delay = jest.fn<(ms: number) => Promise<void>>(async () => undefined);
    const fn = jest.fn(async () => { throw error; });
    await expect(withContextRetry('denied', fn, { random, delay })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(random).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
  });

  it('preserves the existing classifier ordering for contradictory timeout and status fields', () => {
    // Compatibility evidence only: tightening this is a separate behavior change.
    expect(isTransientLoadError({ status: 401, message: 'timeout' })).toBe(true);
    expect(isTransientLoadError({ status: 401, message: 'Unauthorized' })).toBe(false);
  });

  it('awaits the injected delay before starting the next attempt', async () => {
    let resume!: () => void;
    const delay = jest.fn(() => new Promise<void>((resolve) => { resume = resolve; }));
    const fn = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: 'P1001' }).mockResolvedValueOnce('ok');
    const result = withContextRetry('gated', fn, { random: () => 0.5, delay });
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(237);
    resume();
    await expect(result).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each(['random', 'delay'] as const)('propagates an injected %s failure without another source attempt', async (hook) => {
    const error = new Error(`${hook} unavailable`);
    const fn = jest.fn(async () => { throw { code: 'P1001' }; });
    const random = jest.fn(() => { if (hook === 'random') throw error; return 0; });
    const delay = jest.fn(async (_ms: number) => { if (hook === 'delay') throw error; });
    await expect(withContextRetry('hook-failure', fn, { random, delay })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not perform a final sleep or consume a third random sample when retries are exhausted', async () => {
    const errors = [{ code: 'P1001' }, { code: 'P2024' }, { code: 'P1017' }];
    const fn = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(errors[0]).mockRejectedValueOnce(errors[1]).mockRejectedValueOnce(errors[2]);
    const random = jest.fn(() => 0.5);
    const delay = jest.fn<(ms: number) => Promise<void>>(async () => undefined);
    await expect(withContextRetry('exhausted', fn, { random, delay })).rejects.toBe(errors[2]);
    expect(delay.mock.calls).toEqual([[237], [437]]);
    expect(random).toHaveBeenCalledTimes(2);
  });
});
