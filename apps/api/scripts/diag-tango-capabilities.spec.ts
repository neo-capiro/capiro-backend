import { describe, expect, test } from '@jest/globals';
import { parseArgs, formatSummary } from './diag-tango-capabilities.js';
import type { CapabilityReport } from '../src/external/tango/tango-capability-probe.service.js';

describe('CLI parsing', () => {
  test('with no flags and no env, there is no key and the ceiling defaults to 25', () => {
    expect(parseArgs([], {})).toEqual({
      apiKey: undefined,
      baseUrl: undefined,
      timeoutMs: undefined,
      uei: undefined,
      vehicleUuid: undefined,
      requestCeiling: 25,
    });
  });

  test('TANGO_API_KEY from the environment is picked up', () => {
    expect(parseArgs([], { TANGO_API_KEY: 'sk_live_abc' }).apiKey).toBe('sk_live_abc');
  });

  test('--api-key overrides the environment, for a one-off local run', () => {
    expect(parseArgs(['--api-key=sk_cli_override'], { TANGO_API_KEY: 'sk_live_abc' }).apiKey).toBe(
      'sk_cli_override',
    );
  });

  test('a blank or whitespace-only key is treated as absent, not as a credential', () => {
    // Mirrors the product gateway's own "empty string is UNCONFIGURED, not a
    // key" rule (tango.client.spec.ts) — an all-whitespace TANGO_API_KEY must
    // not read as "a key is present".
    expect(parseArgs([], { TANGO_API_KEY: '   ' }).apiKey).toBeUndefined();
    expect(parseArgs(['--api-key=   '], {}).apiKey).toBeUndefined();
  });

  test('base URL and timeout fall back to the environment, then to undefined', () => {
    expect(parseArgs([], { TANGO_API_BASE_URL: 'https://tango.example.test' }).baseUrl).toBe(
      'https://tango.example.test',
    );
    expect(parseArgs([], {}).baseUrl).toBeUndefined();
    expect(parseArgs([], { TANGO_TIMEOUT_MS: '5000' }).timeoutMs).toBe(5000);
    expect(parseArgs([], {}).timeoutMs).toBeUndefined();
  });

  test('--base-url and --timeout-ms override the environment', () => {
    const args = parseArgs(
      ['--base-url=https://override.example.test', '--timeout-ms=1234'],
      { TANGO_API_BASE_URL: 'https://tango.example.test', TANGO_TIMEOUT_MS: '5000' },
    );
    expect(args.baseUrl).toBe('https://override.example.test');
    expect(args.timeoutMs).toBe(1234);
  });

  test('a non-numeric or non-positive timeout falls back to undefined, not NaN or zero', () => {
    expect(parseArgs(['--timeout-ms=nonsense'], {}).timeoutMs).toBeUndefined();
    expect(parseArgs(['--timeout-ms=0'], {}).timeoutMs).toBeUndefined();
    expect(parseArgs(['--timeout-ms=-5'], {}).timeoutMs).toBeUndefined();
  });

  test('uei and vehicle-uuid pass through verbatim, undefined when absent', () => {
    const args = parseArgs(['--uei=ZZTESTUEI001', '--vehicle-uuid=11111111-1111-1111-1111-111111111111'], {});
    expect(args.uei).toBe('ZZTESTUEI001');
    expect(args.vehicleUuid).toBe('11111111-1111-1111-1111-111111111111');
    expect(parseArgs([], {}).uei).toBeUndefined();
    expect(parseArgs([], {}).vehicleUuid).toBeUndefined();
  });

  test('the request ceiling is configurable and clamped at both ends', () => {
    expect(parseArgs(['--request-ceiling=10'], {}).requestCeiling).toBe(10);
    expect(parseArgs(['--request-ceiling=99999'], {}).requestCeiling).toBe(200);
    // Default is 25: the account's MEASURED per-window rate limit (2026-08-08,
    // `x-ratelimit-limit: 25`). It was 30, which sat above the provider's own
    // limit and so could never bind — the provider always ran out first.
    expect(parseArgs(['--request-ceiling=-5'], {}).requestCeiling).toBe(25);
    expect(parseArgs(['--request-ceiling=nonsense'], {}).requestCeiling).toBe(25);
  });
});

describe('formatSummary', () => {
  function report(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
    return {
      generatedAt: '2026-08-06T00:00:00.000Z',
      requestsIssued: 2,
      requestCeiling: 30,
      authenticationFailed: false,
      probes: [
        { key: 'version', usedByPhases: [], status: 'supported', reason: 'Call succeeded.', rate: null, durationMs: 12 },
        {
          key: 'dibbs',
          usedByPhases: ['P40', 'P41'],
          status: 'unsupported',
          reason: 'No method with "dibbs" in its name exists.',
          rate: null,
          durationMs: 0,
        },
      ],
      ...overrides,
    };
  }

  test('prints one aligned row per probe with its phases', () => {
    const out = formatSummary(report());
    expect(out).toContain('requestsIssued=2/30');
    expect(out).toContain('authenticationFailed=false');
    expect(out).toContain('version');
    expect(out).toContain('supported');
    expect(out).toContain('dibbs');
    expect(out).toContain('[P40,P41]');
  });

  test('a probe with no dependent phases prints no bracket suffix', () => {
    const out = formatSummary(report());
    const versionLine = out.split('\n').find((l) => l.trim().startsWith('version'));
    expect(versionLine).toBeDefined();
    expect(versionLine).not.toContain('[');
  });

  test('does not throw on an empty probes list', () => {
    expect(() => formatSummary(report({ probes: [] }))).not.toThrow();
  });
});
