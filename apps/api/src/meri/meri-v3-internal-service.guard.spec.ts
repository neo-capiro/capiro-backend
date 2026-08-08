import {
  ForbiddenException,
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { MeriV3InternalServiceGuard } from './meri-v3-internal-service.guard.js';

function context(header?: string | string[]): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: header === undefined ? {} : { 'x-internal-service-secret': header },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('MeriV3InternalServiceGuard', () => {
  test('accepts the exact configured secret', () => {
    const guard = new MeriV3InternalServiceGuard({
      get: jest.fn(() => 'service-secret'),
    } as never);
    expect(guard.canActivate(context('service-secret'))).toBe(true);
  });

  test.each([undefined, '', 'wrong-secret', 'service-secret-extra'])(
    'rejects a missing or incorrect service identity: %p',
    (value) => {
      const guard = new MeriV3InternalServiceGuard({
        get: jest.fn(() => 'service-secret'),
      } as never);
      expect(() => guard.canActivate(context(value))).toThrow(ForbiddenException);
    },
  );

  test('uses only the first value when a proxy supplies a repeated header', () => {
    const guard = new MeriV3InternalServiceGuard({
      get: jest.fn(() => 'service-secret'),
    } as never);
    expect(guard.canActivate(context(['service-secret', 'untrusted-second']))).toBe(true);
  });

  test('fails closed when the deployment omitted the shared secret', () => {
    const guard = new MeriV3InternalServiceGuard({ get: jest.fn(() => undefined) } as never);
    expect(() => guard.canActivate(context('anything'))).toThrow(ServiceUnavailableException);
  });
});
