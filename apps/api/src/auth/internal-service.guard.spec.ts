import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { InternalServiceGuard } from './internal-service.guard.js';
import type { AppConfig } from '../config/config.schema.js';

function makeCtx(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function makeConfig(secret: string | undefined): ConfigService<AppConfig, true> {
  return { get: () => secret } as unknown as ConfigService<AppConfig, true>;
}

describe('InternalServiceGuard', () => {
  it('fails closed when INTERNAL_SERVICE_SECRET is not configured, regardless of header', () => {
    const guard = new InternalServiceGuard(makeConfig(undefined));
    expect(() => guard.canActivate(makeCtx({ 'x-internal-service-secret': 'anything' }))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects a missing header', () => {
    const guard = new InternalServiceGuard(makeConfig('shh'));
    expect(() => guard.canActivate(makeCtx({}))).toThrow(ForbiddenException);
  });

  it('rejects a wrong secret', () => {
    const guard = new InternalServiceGuard(makeConfig('shh'));
    expect(() => guard.canActivate(makeCtx({ 'x-internal-service-secret': 'wrong' }))).toThrow(
      ForbiddenException,
    );
  });

  it('allows the exact configured secret', () => {
    const guard = new InternalServiceGuard(makeConfig('shh'));
    expect(guard.canActivate(makeCtx({ 'x-internal-service-secret': 'shh' }))).toBe(true);
  });
});
