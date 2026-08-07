import { describe, expect, test } from '@jest/globals';
import { configSchema } from './config.schema.js';

/**
 * Guards the Microsoft 365 OAuth authority configuration. Regression context:
 * the authority was hard-pinned to a single Azure AD tenant (the capiro.ai
 * tenant GUID via MICROSOFT_TENANT_ID), which rejected every customer on a
 * different M365 tenant (e.g. c2strategies.com) with AADSTS50020. It must
 * default to the shared multi-tenant endpoint.
 */
describe('configSchema — MICROSOFT_AUTHORITY', () => {
  const field = configSchema.shape.MICROSOFT_AUTHORITY;

  test('defaults to the shared multi-tenant /organizations authority', () => {
    expect(field.parse(undefined)).toBe('https://login.microsoftonline.com/organizations');
  });

  test('default is multi-tenant, never pinned to a single tenant GUID', () => {
    const value = field.parse(undefined);
    expect(value).toMatch(/\/(organizations|common)$/);
    // A single-tenant authority embeds a tenant GUID — that must never be the default.
    expect(value).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  test('is overridable for a deliberate single-tenant deployment, and must be a URL', () => {
    expect(field.parse('https://login.microsoftonline.com/common')).toBe(
      'https://login.microsoftonline.com/common',
    );
    expect(() => field.parse('organizations')).toThrow();
  });
});

describe('configSchema — LegiStorm directory refresh', () => {
  test('provides conservative client and pointer defaults', () => {
    expect(configSchema.shape.LEGISTORM_BASE_URL.parse(undefined)).toBe(
      'https://api.legistorm.com/v2.019.10/congress',
    );
    expect(configSchema.shape.LEGISTORM_PAGE_SIZE.parse(undefined)).toBe(100);
    expect(configSchema.shape.LEGISTORM_MAX_PAGES.parse(undefined)).toBe(10_000);
    expect(configSchema.shape.LEGISTORM_REQUEST_DELAY_MS.parse(undefined)).toBe(400);
    expect(configSchema.shape.LEGISTORM_REQUEST_TIMEOUT_MS.parse(undefined)).toBe(30_000);
    expect(configSchema.shape.LEGISTORM_MAX_RETRY_DELAY_MS.parse(undefined)).toBe(30_000);
    expect(configSchema.shape.LEGISTORM_OVERLAP_DAYS.parse(undefined)).toBe(2);
    expect(configSchema.shape.DIRECTORY_S3_LATEST_KEY.parse(undefined)).toBe(
      'UPDATED DIRECTORY/LATEST.json',
    );
  });

  test('keeps the API key optional at app boot while the sync script fails closed', () => {
    expect(configSchema.shape.LEGISTORM_API_KEY.parse(undefined)).toBeUndefined();
    expect(configSchema.shape.LEGISTORM_API_KEY.parse('test-key')).toBe('test-key');
  });

  test('rejects insecure URLs and invalid bounds', () => {
    expect(() => configSchema.shape.LEGISTORM_BASE_URL.parse('not-a-url')).toThrow();
    expect(() =>
      configSchema.shape.LEGISTORM_BASE_URL.parse('http://api.example.invalid'),
    ).toThrow();
    expect(() => configSchema.shape.LEGISTORM_PAGE_SIZE.parse('0')).toThrow();
    expect(() => configSchema.shape.LEGISTORM_PAGE_SIZE.parse('1.5')).toThrow();
    expect(() => configSchema.shape.LEGISTORM_MAX_PAGES.parse('0')).toThrow();
    expect(() => configSchema.shape.LEGISTORM_REQUEST_DELAY_MS.parse('-1')).toThrow();
    expect(() => configSchema.shape.LEGISTORM_REQUEST_TIMEOUT_MS.parse('0')).toThrow();
    expect(() => configSchema.shape.LEGISTORM_MAX_RETRY_DELAY_MS.parse('0')).toThrow();
    expect(() => configSchema.shape.LEGISTORM_OVERLAP_DAYS.parse('-1')).toThrow();
  });
});

describe('configSchema — MakeGov/Tango (P16)', () => {
  test('the key is optional at boot, matching every other provider key in this schema', () => {
    expect(configSchema.shape.TANGO_API_KEY.parse(undefined)).toBeUndefined();
    expect(configSchema.shape.TANGO_API_KEY.parse('sk_live_test')).toBe('sk_live_test');
  });

  test('an empty-string key is refused rather than silently accepted', () => {
    // `.min(1)`, not a bare `.optional()`: apps/external/tango/tango.client.ts
    // treats "" and undefined identically (both mean unconfigured), but a value
    // that PASSES validation and then gets silently treated as absent is worse
    // than a value that fails validation and says why.
    expect(() => configSchema.shape.TANGO_API_KEY.parse('')).toThrow();
  });

  test('the base URL defaults to the SDK’s own public endpoint', () => {
    expect(configSchema.shape.TANGO_API_BASE_URL.parse(undefined)).toBe('https://tango.makegov.com');
  });

  test('the base URL rejects HTTP, same enforcement as every other provider URL here', () => {
    expect(() => configSchema.shape.TANGO_API_BASE_URL.parse('http://tango.example.test')).toThrow();
    expect(configSchema.shape.TANGO_API_BASE_URL.parse('https://tango.example.test')).toBe(
      'https://tango.example.test',
    );
  });

  test('the base URL rejects a non-URL string outright', () => {
    expect(() => configSchema.shape.TANGO_API_BASE_URL.parse('not-a-url')).toThrow();
  });

  test('timeout defaults match the adapter’s own fallback (tango.client.ts)', () => {
    expect(configSchema.shape.TANGO_TIMEOUT_MS.parse(undefined)).toBe(30_000);
    expect(() => configSchema.shape.TANGO_TIMEOUT_MS.parse('0')).toThrow();
  });

  test('page size is capped at 100 — the SDK’s own hard limit, not a Capiro choice', () => {
    expect(configSchema.shape.TANGO_PAGE_SIZE.parse(undefined)).toBe(100);
    expect(configSchema.shape.TANGO_PAGE_SIZE.parse('50')).toBe(50);
    expect(() => configSchema.shape.TANGO_PAGE_SIZE.parse('101')).toThrow();
    expect(() => configSchema.shape.TANGO_PAGE_SIZE.parse('0')).toThrow();
  });

  test('P18’s request-ceiling and circuit-breaker values are declared, validated, and positive', () => {
    // Nothing reads these yet (P18 does); this only proves they exist as real,
    // bounded config rather than an unvalidated `process.env` access waiting to
    // happen in P18.
    expect(configSchema.shape.TANGO_REQUEST_CEILING_PER_RUN.parse(undefined)).toBe(5_000);
    expect(configSchema.shape.TANGO_CIRCUIT_BREAKER_THRESHOLD.parse(undefined)).toBe(5);
    expect(configSchema.shape.TANGO_CIRCUIT_BREAKER_COOLDOWN_MS.parse(undefined)).toBe(60_000);
    expect(() => configSchema.shape.TANGO_REQUEST_CEILING_PER_RUN.parse('0')).toThrow();
    expect(() => configSchema.shape.TANGO_CIRCUIT_BREAKER_THRESHOLD.parse('-1')).toThrow();
    expect(() => configSchema.shape.TANGO_CIRCUIT_BREAKER_COOLDOWN_MS.parse('0')).toThrow();
  });

  test('every Tango field parses cleanly through the FULL schema with no key set', () => {
    // The regression this guards: a required field added anywhere in this large
    // schema breaks app boot for every environment that hasn't set it.
    // TANGO_* must all be optional-or-defaulted, proven by parsing the whole
    // object with the other genuinely-required fields present and none of the
    // Tango keys set at all.
    const result = configSchema.safeParse({
      DATABASE_URL: 'postgresql://localhost:5432/capiro',
      CLERK_SECRET_KEY: 'sk_test',
      CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_test',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.TANGO_API_KEY).toBeUndefined();
      expect(result.data.TANGO_API_BASE_URL).toBe('https://tango.makegov.com');
    }
  });
});

describe('configSchema — LegiStorm Legislative Districts (WS-B)', () => {
  test('defaults to the Districts API base URL, NOT the Congressional API one', () => {
    const districts = configSchema.shape.LEGISTORM_DISTRICTS_BASE_URL.parse(undefined);
    const congress = configSchema.shape.LEGISTORM_BASE_URL.parse(undefined);
    expect(districts).toBe('https://api.legistorm.com/v2.023.07/legislative_districts');
    expect(districts).not.toBe(congress);
  });

  test('rejects insecure URLs', () => {
    expect(() => configSchema.shape.LEGISTORM_DISTRICTS_BASE_URL.parse('not-a-url')).toThrow();
    expect(() =>
      configSchema.shape.LEGISTORM_DISTRICTS_BASE_URL.parse('http://api.example.invalid'),
    ).toThrow();
  });
});
