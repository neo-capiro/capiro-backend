import { validateConfig } from './config.schema.js';

/**
 * CLERK_JWT_ISSUER boot guard.
 *
 * Context: passing `issuer` to @clerk/backend's verifyToken pinned NOTHING —
 * `issuer` is not a VerifyJwtOptions field in v1.34.0 (the runtime destructures
 * exactly { audience, authorizedParties, clockSkewInMs, key }), so the value
 * was silently discarded. ClerkService now enforces `iss` explicitly, which
 * only helps if the variable is actually set — hence this guard.
 */
const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/capiro?schema=public',
  CLERK_SECRET_KEY: 'sk_test_x',
  CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_x',
};

describe('validateConfig — CLERK_JWT_ISSUER', () => {
  it('accepts a config that pins the issuer', () => {
    const cfg = validateConfig({
      ...BASE,
      NODE_ENV: 'production',
      CLERK_JWT_ISSUER: 'https://clerk.app.capiro.ai',
    });
    expect(cfg.CLERK_JWT_ISSUER).toBe('https://clerk.app.capiro.ai');
  });

  it('REFUSES TO START in production when the issuer is unset', () => {
    expect(() => validateConfig({ ...BASE, NODE_ENV: 'production' })).toThrow(
      /CLERK_JWT_ISSUER is required/,
    );
  });

  it('REFUSES TO START in staging when the issuer is unset', () => {
    expect(() => validateConfig({ ...BASE, NODE_ENV: 'staging' })).toThrow(
      /CLERK_JWT_ISSUER is required/,
    );
  });

  // The live capiro-dev deployment — which IS production — runs with
  // NODE_ENV=development. A production-only gate would be a silent no-op
  // exactly where the control matters, so 'development' must also be enforced.
  it('REFUSES TO START in development when the issuer is unset', () => {
    expect(() => validateConfig({ ...BASE, NODE_ENV: 'development' })).toThrow(
      /CLERK_JWT_ISSUER is required/,
    );
  });

  it('defaults NODE_ENV to development and still enforces the issuer', () => {
    expect(() => validateConfig({ ...BASE })).toThrow(/CLERK_JWT_ISSUER is required/);
  });

  // Unit tests build config objects without an issuer; requiring one there
  // would break the suite for no security benefit.
  it('exempts NODE_ENV=test', () => {
    const cfg = validateConfig({ ...BASE, NODE_ENV: 'test' });
    expect(cfg.CLERK_JWT_ISSUER).toBeUndefined();
  });

  it('still applies the underlying schema validation', () => {
    expect(() =>
      validateConfig({ ...BASE, NODE_ENV: 'test', CLERK_JWT_ISSUER: 'not-a-url' }),
    ).toThrow();
  });
});
