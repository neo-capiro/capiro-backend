import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';
import type { ClerkService, ClerkSessionClaims } from './clerk.service';
import { normalizeClaims } from './clerk.service';
import type { OrgTenantResolver, ResolvedTenant } from './org-tenant-resolver';

function ctxFor(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** The canonical tenant row the fake resolver knows about. */
const TENANT: ResolvedTenant = {
  tenantId: 'tenant-1',
  slug: 'acmelobby',
  clerkOrgId: 'org_xyz',
};

interface ResolverOpts {
  /** Rows keyed by clerk org id. */
  byOrg?: Record<string, ResolvedTenant>;
  /** Rows keyed by tenant uuid. */
  byId?: Record<string, ResolvedTenant>;
  /** Default true. Set false to simulate a revoked/suspended membership. */
  active?: boolean;
  calls?: { membership: number };
}

function makeResolver(opts: ResolverOpts = {}): OrgTenantResolver {
  const byOrg = opts.byOrg ?? { [TENANT.clerkOrgId as string]: TENANT };
  const byId = opts.byId ?? { [TENANT.tenantId]: TENANT };
  return {
    resolveByClerkOrgId: async (orgId) => byOrg[orgId] ?? null,
    resolveByTenantId: async (tenantId) => byId[tenantId] ?? null,
    hasActiveMembership: async () => {
      if (opts.calls) opts.calls.membership += 1;
      return opts.active !== false;
    },
  };
}

function guardWith(claims: ClerkSessionClaims | Error, resolver?: OrgTenantResolver): TenantGuard {
  const clerk = {
    verifySessionToken: async () => {
      if (claims instanceof Error) throw claims;
      return claims;
    },
  } as unknown as ClerkService;
  return new TenantGuard(clerk, resolver ?? makeResolver());
}

const baseClaims: ClerkSessionClaims = {
  sub: 'user_abc',
  iss: 'https://clerk.app.capiro.ai',
  capiro_tenant_id: 'tenant-1',
  org_id: 'org_xyz',
  org_role: 'org:member',
};

const AUTHED = { headers: { authorization: 'Bearer jwt' } };

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
    await expect(guard.canActivate(ctxFor({ ...AUTHED }))).rejects.toThrow(ForbiddenException);
  });

  it('fails closed on a token missing sub (never synthesizes a placeholder)', async () => {
    const guard = guardWith({ ...baseClaims, sub: '' as never });
    await expect(guard.canActivate(ctxFor({ ...AUTHED }))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a subject-less token WITHOUT hitting the database', async () => {
    const calls = { membership: 0 };
    const guard = guardWith({ ...baseClaims, sub: '' as never }, makeResolver({ calls }));
    await expect(guard.canActivate(ctxFor({ ...AUTHED }))).rejects.toThrow(UnauthorizedException);
    expect(calls.membership).toBe(0);
  });

  it('attaches the CANONICAL tenant id resolved from the database', async () => {
    const guard = guardWith(baseClaims);
    const req: Record<string, unknown> = { ...AUTHED };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(req.tenantContext).toEqual({
      tenantId: 'tenant-1',
      clerkUserId: 'user_abc',
      role: 'org:member',
    });
  });

  // REGRESSION — this replaces "falls back to org_id as tenantId".
  // The guard used to put the raw `org_...` string into tenantContext when the
  // template claim was absent. That is not a UUID and matches no row, so every
  // downstream tenant predicate silently matched nothing.
  it('resolves org_id to the canonical UUID instead of using it as the tenant id', async () => {
    const guard = guardWith({ ...baseClaims, capiro_tenant_id: undefined });
    const req: Record<string, unknown> = { ...AUTHED };
    await guard.canActivate(ctxFor(req));
    const ctx = req.tenantContext as { tenantId: string };
    expect(ctx.tenantId).toBe('tenant-1');
    expect(ctx.tenantId).not.toBe('org_xyz');
  });

  it('403s when the org id resolves to no tenant', async () => {
    const guard = guardWith({ ...baseClaims, capiro_tenant_id: undefined, org_id: 'org_unknown' });
    await expect(guard.canActivate(ctxFor({ ...AUTHED }))).rejects.toThrow(ForbiddenException);
  });

  it('falls back to capiro_tenant_id when the tenant has no clerk_org_id linked', async () => {
    // Tenant row exists but was never linked to a Clerk org.
    const unlinked: ResolvedTenant = { tenantId: 'tenant-2', slug: 'newfirm', clerkOrgId: null };
    const guard = guardWith(
      { ...baseClaims, capiro_tenant_id: 'tenant-2', org_id: 'org_new' },
      makeResolver({ byOrg: {}, byId: { 'tenant-2': unlinked } }),
    );
    const req: Record<string, unknown> = { ...AUTHED };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect((req.tenantContext as { tenantId: string }).tenantId).toBe('tenant-2');
  });

  describe('claim cross-checks', () => {
    it('403s when capiro_tenant_id disagrees with the resolved tenant', async () => {
      const guard = guardWith({ ...baseClaims, capiro_tenant_id: 'tenant-OTHER' });
      await expect(guard.canActivate(ctxFor({ ...AUTHED }))).rejects.toThrow(ForbiddenException);
    });

    it('403s when the resolved tenant belongs to a different Clerk org', async () => {
      const guard = guardWith(
        { ...baseClaims, org_id: 'org_xyz' },
        // Resolution succeeds by tenant id, but the row points at another org.
        makeResolver({
          byOrg: {},
          byId: { 'tenant-1': { ...TENANT, clerkOrgId: 'org_SOMEONE_ELSE' } },
        }),
      );
      await expect(guard.canActivate(ctxFor({ ...AUTHED }))).rejects.toThrow(ForbiddenException);
    });

    it('403s when the slug claim disagrees with the resolved tenant', async () => {
      const guard = guardWith({ ...baseClaims, capiro_tenant_slug: 'someone-else' });
      await expect(guard.canActivate(ctxFor({ ...AUTHED }))).rejects.toThrow(ForbiddenException);
    });

    it('accepts a slug claim that differs only by case (slug is citext)', async () => {
      const guard = guardWith({ ...baseClaims, capiro_tenant_slug: 'AcmeLobby' });
      await expect(guard.canActivate(ctxFor({ ...AUTHED }))).resolves.toBe(true);
    });
  });

  describe('active membership', () => {
    // THE control finding #2 is really about: a valid Clerk token is no longer
    // sufficient. A user removed in Capiro but still in the Clerk org keeps
    // being issued org-bearing tokens — exactly the state a failed Clerk-side
    // delete leaves behind.
    it('403s a verified token whose local membership is not active', async () => {
      const guard = guardWith(baseClaims, makeResolver({ active: false }));
      await expect(guard.canActivate(ctxFor({ ...AUTHED }))).rejects.toThrow(ForbiddenException);
    });

    it('checks membership against the RESOLVED tenant, not the raw claim', async () => {
      const seen: Array<[string, string]> = [];
      const resolver: OrgTenantResolver = {
        ...makeResolver(),
        hasActiveMembership: async (tenantId, clerkUserId) => {
          seen.push([tenantId, clerkUserId]);
          return true;
        },
      };
      const guard = guardWith({ ...baseClaims, capiro_tenant_id: undefined }, resolver);
      await guard.canActivate(ctxFor({ ...AUTHED }));
      expect(seen).toEqual([['tenant-1', 'user_abc']]);
    });

    it('fails closed when the membership lookup itself reports false', async () => {
      const resolver: OrgTenantResolver = {
        ...makeResolver(),
        hasActiveMembership: async () => false,
      };
      const guard = guardWith(baseClaims, resolver);
      await expect(guard.canActivate(ctxFor({ ...AUTHED }))).rejects.toThrow(ForbiddenException);
    });
  });

  it('role falls back org_role → capiro_org_role → null', async () => {
    const noRole = guardWith({ ...baseClaims, org_role: undefined, capiro_org_role: undefined });
    const req: Record<string, unknown> = { ...AUTHED };
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
