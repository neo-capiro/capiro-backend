import {
  MAX_GEOCODE_ATTEMPTS,
  nextGeocodeAttempt,
  retryDelayMs,
  type GeocodeRetryStatus,
} from './geocode-retry.js';

describe('geocode retry policy', () => {
  test('transient failures are retryable with exponential backoff capped at 24 hours', () => {
    expect(retryDelayMs('error', 1)).toBe(5 * 60_000);
    expect(retryDelayMs('error', 2)).toBe(30 * 60_000);
    expect(retryDelayMs('error', 3)).toBe(2 * 60 * 60_000);
    expect(retryDelayMs('error', 4)).toBe(12 * 60 * 60_000);
    expect(retryDelayMs('error', 5)).toBe(24 * 60 * 60_000);
    expect(retryDelayMs('error', 99)).toBe(24 * 60 * 60_000);
  });

  test.each<GeocodeRetryStatus>(['no_match', 'ambiguous'])('%s becomes manual review after the retry cap', (status) => {
    expect(nextGeocodeAttempt(status, MAX_GEOCODE_ATTEMPTS - 1, true, new Date('2026-08-20T12:00:00Z'))).toEqual({
      status,
      nextAttemptAt: expect.any(Date),
    });
    expect(nextGeocodeAttempt(status, MAX_GEOCODE_ATTEMPTS, true, new Date('2026-08-20T12:00:00Z'))).toEqual({
      status: 'manual_review',
      nextAttemptAt: null,
    });
  });

  test('missing address does not schedule pointless retries', () => {
    expect(nextGeocodeAttempt('no_match', 1, false, new Date('2026-08-20T12:00:00Z'))).toEqual({
      status: 'no_match',
      nextAttemptAt: null,
    });
  });

  test('matched and manual review are terminal', () => {
    expect(nextGeocodeAttempt('matched', 1, true, new Date())).toEqual({ status: 'matched', nextAttemptAt: null });
    expect(nextGeocodeAttempt('manual_review', 1, true, new Date())).toEqual({ status: 'manual_review', nextAttemptAt: null });
  });
});

test('retry policy accepts only provider failure statuses', () => {
  expect(() => retryDelayMs('unexpected' as GeocodeRetryStatus, 1)).toThrow();
});
