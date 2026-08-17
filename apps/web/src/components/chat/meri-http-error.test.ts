import { describe, expect, test } from 'vitest';
import { formatMeriHttpError } from './meri-http-error.js';

describe('formatMeriHttpError', () => {
  test('does not display Nest generic 500 JSON verbatim', () => {
    expect(
      formatMeriHttpError(500, '{"statusCode":500,"message":"Internal server error"}'),
    ).toBe('Meri could not start this turn (HTTP 500).');
    expect(
      formatMeriHttpError(500, '{"statusCode":500,"message":"Internal server error"}'),
    ).not.toContain('statusCode');
  });

  test('surfaces a classified provider-configuration failure', () => {
    expect(
      formatMeriHttpError(
        503,
        JSON.stringify({
          statusCode: 503,
          code: 'MERI_PROVIDER_CONFIGURATION_ERROR',
          message: 'Meri is missing a usable AI provider configuration for this tenant.',
        }),
      ),
    ).toBe('Meri is missing a usable AI provider configuration for this tenant.');
  });

  test('keeps a plain non-JSON error body', () => {
    expect(formatMeriHttpError(502, 'upstream timeout')).toBe('Error 502: upstream timeout');
  });
});
