import { describe, expect, test } from 'vitest';
import { httpErrorStatus, isAuthenticationOrAccessError, shouldRetryQuery } from './query-retry.js';

describe('query retry policy', () => {
  test.each([401, 403])('does not retry HTTP %s failures', (status) => {
    const error = { response: { status } };

    expect(httpErrorStatus(error)).toBe(status);
    expect(isAuthenticationOrAccessError(error)).toBe(true);
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  test('keeps the existing single retry for a transient failure', () => {
    const error = { response: { status: 503 } };

    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(1, error)).toBe(false);
  });

  test('also recognizes errors that expose status directly', () => {
    expect(isAuthenticationOrAccessError({ status: 401 })).toBe(true);
  });
});
