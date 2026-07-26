import { describe, expect, jest, test } from '@jest/globals';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { ClerkService, ClerkSessionClaims } from '../src/auth/clerk.service.js';
import { TenantGuard } from '../src/auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../src/auth/tenant-context.js';

type GuardRequest = Request & { tenantContext?: WorkspaceTenantContext };

function makeContext(req: Partial<Request>): ExecutionContext {
  const httpReq = req as Request;
  return {
    switchToHttp: () => ({
      getRequest: <T = unknown>() => httpReq as T,
      getResponse: <T = unknown>() => ({}) as T,
      getNext: <T = unknown>() => ({}) as T,
    }),
    // The guard only touches switchToHttp(); the rest of the surface is
    // returned as no-ops so the cast remains accurate.
  } as unknown as ExecutionContext;
}

// NOTE: `jest.Mock` from @jest/globals (jest-mock) takes a SINGLE function-type
// argument, unlike @types/jest's two-argument `Mock<Return, Args>` form.
type Spy = jest.Mock<(token: string) => Promise<ClerkSessionClaims>>;

function makeClerk(
  impl: (token: string) => Promise<ClerkSessionClaims>,
): { service: ClerkService; spy: Spy } {
  const spy = jest.fn(impl) as unknown as Spy;
  // Cast through unknown — the guard only depends on verifySessionToken; we
  // intentionally do not stub the rest of the surface.
  const service = { verifySessionToken: spy } as unknown as ClerkService;
  return { service, spy };
}

describe('TenantGuard', () => {
  test('missing Authorization header → 401', async () => {
    const { service } = makeClerk(async () => {
      throw new Error('should not be called');
    });
    const guard = new TenantGuard(service);
    const ctx = makeContext({ headers: {} } as Partial<Request>);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  test('malformed Authorization header → 401', async () => {
    const { service } = makeClerk(async () => {
      throw new Error('should not be called');
    });
    const guard = new TenantGuard(service);
    const ctx = makeContext({ headers: { authorization: 'Token abc' } } as Partial<Request>);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  test('Clerk verification failure → 401 Invalid session token', async () => {
    const { service, spy } = makeClerk(async () => {
      throw new Error('signature mismatch');
    });
    const guard = new TenantGuard(service);
    const ctx = makeContext({
      headers: { authorization: 'Bearer not-a-real-token' },
    } as Partial<Request>);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      message: 'Invalid session token',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('not-a-real-token');
  });

  test('valid token with capiro_tenant_id resolves tenantId + attaches context', async () => {
    const claims: ClerkSessionClaims = {
      sub: 'user_clerk_123',
      iss: 'https://clerk.example/issuer',
      capiro_tenant_id: 'tenant-uuid-from-template',
      org_id: 'org_clerk_456',
      org_role: 'org:admin',
    };
    const { service } = makeClerk(async () => claims);
    const guard = new TenantGuard(service);

    const req: Partial<Request> = {
      headers: { authorization: 'Bearer valid.jwt.token' },
    };
    const ctx = makeContext(req);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    const tenantContext = (req as GuardRequest).tenantContext;
    expect(tenantContext).toEqual({
      tenantId: 'tenant-uuid-from-template',
      clerkUserId: 'user_clerk_123',
      role: 'org:admin',
    });
  });

  test('valid token with only org_id falls back to org_id as tenantId', async () => {
    const claims: ClerkSessionClaims = {
      sub: 'user_clerk_789',
      iss: 'https://clerk.example/issuer',
      org_id: 'org_clerk_only',
    };
    const { service } = makeClerk(async () => claims);
    const guard = new TenantGuard(service);

    const req: Partial<Request> = {
      headers: { authorization: 'Bearer valid.jwt.token' },
    };
    const ctx = makeContext(req);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const tenantContext = (req as GuardRequest).tenantContext;
    expect(tenantContext).toEqual({
      tenantId: 'org_clerk_only',
      clerkUserId: 'user_clerk_789',
      role: null,
    });
  });

  test('valid token with neither tenant claim → 403 No tenant in token', async () => {
    const claims: ClerkSessionClaims = {
      sub: 'user_clerk_no_tenant',
      iss: 'https://clerk.example/issuer',
    };
    const { service } = makeClerk(async () => claims);
    const guard = new TenantGuard(service);

    const ctx = makeContext({
      headers: { authorization: 'Bearer valid.jwt.token' },
    } as Partial<Request>);

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      message: 'No tenant in token',
    });
  });
});
