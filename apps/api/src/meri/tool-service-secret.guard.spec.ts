import { describe, expect, it } from '@jest/globals';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';

function ctxWith(header?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: header === undefined ? {} : { 'x-internal-service-secret': header },
        method: 'POST',
        path: '/api/clio/tools/send_email',
        url: '/api/clio/tools/send_email',
      }),
    }),
  } as unknown as ExecutionContext;
}

function cfg(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as never;
}

describe('ToolServiceSecretGuard', () => {
  it.each(['staging', 'production'])('%s fails closed when the configured secret is missing', (env) => {
    const guard = new ToolServiceSecretGuard(cfg({ NODE_ENV: env }));
    expect(() => guard.canActivate(ctxWith(undefined))).toThrow(ForbiddenException);
  });

  it.each(['staging', 'production'])('%s rejects a user bearer path without service identity', (env) => {
    const guard = new ToolServiceSecretGuard(
      cfg({ NODE_ENV: env, INTERNAL_SERVICE_SECRET: 's3cr3t' }),
    );
    expect(() => guard.canActivate(ctxWith(undefined))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxWith('wrong'))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctxWith('s3cr3t'))).toBe(true);
  });

  it('development/test observe mode must be explicit and never applies in production-like envs', () => {
    const guard = new ToolServiceSecretGuard(
      cfg({
        NODE_ENV: 'development',
        INTERNAL_SERVICE_SECRET: 's3cr3t',
        MERI_TOOLS_REQUIRE_SERVICE_SECRET: false,
      }),
    );
    expect(guard.canActivate(ctxWith(undefined))).toBe(true);
    expect(guard.canActivate(ctxWith('wrong'))).toBe(true);
  });

  it('development enforcement rejects missing/wrong identity', () => {
    const guard = new ToolServiceSecretGuard(
      cfg({
        NODE_ENV: 'development',
        INTERNAL_SERVICE_SECRET: 's3cr3t',
        MERI_TOOLS_REQUIRE_SERVICE_SECRET: true,
      }),
    );
    expect(() => guard.canActivate(ctxWith(undefined))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxWith('wrong'))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctxWith('s3cr3t'))).toBe(true);
  });

  it('uses a fixed-length constant-time comparison for near misses', () => {
    const guard = new ToolServiceSecretGuard(
      cfg({ NODE_ENV: 'production', INTERNAL_SERVICE_SECRET: 's3cr3t' }),
    );
    expect(() => guard.canActivate(ctxWith('s3cr3'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxWith('s3cr3tt'))).toThrow(ForbiddenException);
  });
});
