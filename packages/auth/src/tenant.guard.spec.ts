import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';
import type { ClerkService, ClerkSessionClaims } from './clerk.service';
import { normalizeClaims } from './clerk.service';

function ctxFor(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function guardWith(claims: ClerkSessionClaims | Error): TenantGuard {
  const clerk = {
    verifySessionToken: async () => {
      if (claims instanceof Error) throw claims;
      return claims;
    },
  } as unknown as ClerkService;
  return new TenantGuard(clerk);
}

const baseClaims: ClerkSessionClaims = {
  sub: 'user_abc',
  iss: 'https://clerk.app.capiro.ai',
  capiro_tenant_id: 'tenant-1',
  org_id: 'org_xyz',
  org_role: 'org:member',
};

describe('TenantGuard', () => {
  it('401s a missing or malformed Authorization header (never reaches Clerk)', async () => {
    const guard = guardWith(new Error('must not be called'));
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer ' }]) {
      await expect(guard.canActivate(ctxFor({ headers }))).rejects.toThrow(UnauthorizedException);
    }
  });

  it('401s an invalid session token', async () => {
    const guard = guardWith(new Error('bad token'));
    await expect(
      guard.canActivate(ctxFor({ headers: { authorization: 'Bearer not.a.jwt' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('403s a verified token with no tenant claim', async () => {
    const guard = guardWith({ ...baseClaims, capiro_tenant_id: undefined, org_id: undefined });
    await expect(
      guard.canActivate(ctxFor({ headers: { authorization: 'Bearer jwt' } })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('fails closed on a token missing sub (never synthesizes a placeholder)', async () => {
    const guard = guardWith({ ...baseClaims, sub: '' as never });
    await expect(
      guard.canActivate(ctxFor({ headers: { authorization: 'Bearer jwt' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the narrow context, preferring capiro_tenant_id over org_id', async () => {
    const guard = guardWith(baseClaims);
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer jwt' } };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(req.tenantContext).toEqual({
      tenantId: 'tenant-1',
      clerkUserId: 'user_abc',
      role: 'org:member',
    });
  });

  it('falls back to org_id when the capiro template claim is absent', async () => {
    const guard = guardWith({ ...baseClaims, capiro_tenant_id: undefined });
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer jwt' } };
    await guard.canActivate(ctxFor(req));
    expect((req.tenantContext as { tenantId: string }).tenantId).toBe('org_xyz');
  });

  it('role falls back org_role → capiro_org_role → null', async () => {
    const noRole = guardWith({ ...baseClaims, org_role: undefined, capiro_org_role: undefined });
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer jwt' } };
    await noRole.canActivate(ctxFor(req));
    expect((req.tenantContext as { role: string | null }).role).toBeNull();
  });
});

describe('normalizeClaims (Clerk v1/v2 token shapes)', () => {
  it('maps the v2 compact `o` object to flat org claims and prefixes the role', () => {
    const out = normalizeClaims({
      sub: 'u',
      iss: 'i',
      o: { id: 'org_v2', slg: 'capiro', rol: 'admin' },
    });
    expect(out.org_id).toBe('org_v2');
    expect(out.org_slug).toBe('capiro');
    expect(out.org_role).toBe('org:admin');
  });

  it('prefers explicit v1 flat claims over the v2 object', () => {
    const out = normalizeClaims({
      sub: 'u',
      iss: 'i',
      org_id: 'org_v1',
      org_role: 'org:member',
      o: { id: 'org_v2', rol: 'admin' },
    });
    expect(out.org_id).toBe('org_v1');
    expect(out.org_role).toBe('org:member');
  });

  it('passes an already-prefixed v2 role through unchanged', () => {
    const out = normalizeClaims({ sub: 'u', iss: 'i', o: { rol: 'org:member' } });
    expect(out.org_role).toBe('org:member');
  });
});
