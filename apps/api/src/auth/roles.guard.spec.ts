import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { TenantContext, TenantRole } from '@capiro/shared';
import { RolesGuard } from './roles.guard.js';

function makeCtx(tenantContext: Partial<TenantContext> | undefined): ExecutionContext {
  const req = tenantContext ? { tenantContext } : {};
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function makeReflector(required: TenantRole[] | undefined): Reflector {
  return { getAllAndOverride: () => required } as unknown as Reflector;
}

function ctxWithRole(role: string): Partial<TenantContext> {
  return {
    tenantId: 't-1',
    tenantSlug: 'acmelobby',
    userId: 'u-1',
    clerkUserId: 'user_clerk_1',
    // Deliberately widened: the real middleware casts a DB string with
    // `as TenantRole`, so any value can arrive here at runtime.
    role: role as TenantRole,
  };
}

describe('RolesGuard', () => {
  it('allows a route with no @Roles() requirement', () => {
    const guard = new RolesGuard(makeReflector(undefined));
    expect(guard.canActivate(makeCtx(ctxWithRole('standard_user')))).toBe(true);
  });

  it('fails closed when the tenant context is missing entirely', () => {
    const guard = new RolesGuard(makeReflector(['standard_user']));
    expect(() => guard.canActivate(makeCtx(undefined))).toThrow(ForbiddenException);
  });

  it('allows a caller whose rank meets the requirement', () => {
    const guard = new RolesGuard(makeReflector(['standard_user']));
    expect(guard.canActivate(makeCtx(ctxWithRole('user_admin')))).toBe(true);
  });

  it('rejects a caller ranked below the requirement', () => {
    const guard = new RolesGuard(makeReflector(['user_admin']));
    expect(() => guard.canActivate(makeCtx(ctxWithRole('standard_user')))).toThrow(
      ForbiddenException,
    );
  });

  // REGRESSION: ROLE_RANK[unknown] is undefined, and `undefined < n` is false,
  // so before this guard's explicit check an unmapped role PASSED every
  // @Roles()-gated route instead of being rejected.
  it.each(['', 'bogus_role', 'ADMIN', 'org:admin', 'tenant_admin', 'undefined'])(
    'fails closed on the unmapped role %p rather than granting access',
    (role) => {
      const guard = new RolesGuard(makeReflector(['standard_user']));
      expect(() => guard.canActivate(makeCtx(ctxWithRole(role)))).toThrow(ForbiddenException);
    },
  );

  it('fails closed when the ROUTE declares an unrecognized required role', () => {
    const guard = new RolesGuard(makeReflector(['not_a_real_role' as TenantRole]));
    expect(() => guard.canActivate(makeCtx(ctxWithRole('capiro_admin')))).toThrow(
      ForbiddenException,
    );
  });

  it('lets capiro_admin through the highest requirement', () => {
    const guard = new RolesGuard(makeReflector(['capiro_admin']));
    expect(guard.canActivate(makeCtx(ctxWithRole('capiro_admin')))).toBe(true);
  });
});
