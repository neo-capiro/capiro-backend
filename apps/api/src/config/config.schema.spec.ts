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
