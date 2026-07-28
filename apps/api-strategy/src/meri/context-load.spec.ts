import { describe, expect, it, jest } from '@jest/globals';
import { isTransientLoadError, withContextRetry } from './context-load.js';

/*
 * Phase 5 §3.2 — bounded retry for transient draft-context loads. Real timers
 * throughout: the bounded delays here are small (base 200ms, ≤2 retries, ≤75ms
 * jitter), so coordinating fake-timer/microtask interleaving would add
 * complexity for no benefit — every assertion below is on call COUNTS and
 * outcomes, never on wall-clock timing.
 */
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

    await expect(withContextRetry('client-existence', fn)).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds on the third attempt (plan §9.1)', async () => {
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: 'P1001' })
      .mockRejectedValueOnce({ code: 'P2024' })
      .mockResolvedValueOnce('ok on the third try');

    await expect(withContextRetry('firm-phases', fn)).resolves.toBe('ok on the third try');

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient validation/auth failure (plan §9.2)', async () => {
    const err = new Error('Unknown client for this tenant');
    const fn = jest.fn(async () => {
      throw err;
    });

    await expect(withContextRetry('client-existence', fn)).rejects.toThrow(
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

    await expect(withContextRetry('reference-calendars', fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries, never more
  });
});
