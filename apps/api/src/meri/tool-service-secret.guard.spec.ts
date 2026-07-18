import { describe, expect, it } from '@jest/globals';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';

function ctxWith(header?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: header === undefined ? {} : { 'x-internal-service-secret': header },
        params: { name: 'send_email' },
      }),
    }),
  } as unknown as ExecutionContext;
}

function cfg(values: Record<string, unknown>) {
  return { get: (k: string) => values[k] } as never;
}

describe('ToolServiceSecretGuard', () => {
  it('is a no-op (allows) when INTERNAL_SERVICE_SECRET is unset — never blocks on a config gap', () => {
    const g = new ToolServiceSecretGuard(cfg({}));
    expect(g.canActivate(ctxWith(undefined))).toBe(true);
    expect(g.canActivate(ctxWith('anything'))).toBe(true);
  });

  it('allows a request carrying the correct secret', () => {
    const g = new ToolServiceSecretGuard(cfg({ INTERNAL_SERVICE_SECRET: 's3cr3t' }));
    expect(g.canActivate(ctxWith('s3cr3t'))).toBe(true);
  });

  it('OBSERVE (flag off): allows a missing/wrong secret (logs, does not throw)', () => {
    const g = new ToolServiceSecretGuard(
      cfg({ INTERNAL_SERVICE_SECRET: 's3cr3t', MERI_TOOLS_REQUIRE_SERVICE_SECRET: false }),
    );
    expect(g.canActivate(ctxWith(undefined))).toBe(true);
    expect(g.canActivate(ctxWith('wrong'))).toBe(true);
  });

  it('ENFORCE (flag on): rejects missing/wrong secret with 403, allows the correct one', () => {
    const g = new ToolServiceSecretGuard(
      cfg({ INTERNAL_SERVICE_SECRET: 's3cr3t', MERI_TOOLS_REQUIRE_SERVICE_SECRET: true }),
    );
    expect(() => g.canActivate(ctxWith(undefined))).toThrow(ForbiddenException);
    expect(() => g.canActivate(ctxWith('wrong'))).toThrow(ForbiddenException);
    expect(g.canActivate(ctxWith('s3cr3t'))).toBe(true);
  });

  it('uses a length-safe constant-time compare (near-miss lengths never match)', () => {
    const g = new ToolServiceSecretGuard(
      cfg({ INTERNAL_SERVICE_SECRET: 's3cr3t', MERI_TOOLS_REQUIRE_SERVICE_SECRET: true }),
    );
    expect(() => g.canActivate(ctxWith('s3cr3'))).toThrow(ForbiddenException); // shorter
    expect(() => g.canActivate(ctxWith('s3cr3tt'))).toThrow(ForbiddenException); // longer
  });
});
