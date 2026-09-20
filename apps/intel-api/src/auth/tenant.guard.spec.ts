import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { TenantGuard } from './tenant.guard.js';

jest.mock('./clerk.service.js', () => ({ ClerkService: class {} }));
jest.mock('./org-tenant-resolver.service.js', () => ({ OrgTenantResolverService: class {} }));

const TENANT = '00000000-0000-4000-8000-000000000001';
const IMPERSONATED_TENANT = '00000000-0000-4000-8000-000000000002';
function setup(claims: Record<string, unknown> = {}) {
  const request: {
    headers: Record<string, string | undefined>;
    header: (name: string) => string | undefined;
    method: string;
    tenantContext?: { tenantId: string; clerkUserId: string; role: string | null };
  } = {
    headers: { authorization: 'Bearer verified-fixture' },
    method: 'GET',
    header(name: string) {
      return this.headers[name.toLowerCase()];
    },
  };
  const clerk = {
    verifySessionToken: jest
      .fn()
      .mockResolvedValue({ sub: 'user-one', org_id: 'org-one', ...claims }),
  };
  const tenants = {
    resolveByClerkOrgId: jest
      .fn()
      .mockResolvedValue({ tenantId: TENANT, slug: 'client', clerkOrgId: 'org-one' }),
    resolveByTenantId: jest.fn(),
    hasActiveMembership: jest.fn().mockResolvedValue(true),
    activeMembershipRole: jest.fn().mockResolvedValue({ role: 'user_admin' }),
    resolveActiveImpersonation: jest.fn().mockResolvedValue(null),
  };
  const guard = new TenantGuard(clerk as never, tenants as never);
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext;
  return { request, clerk, tenants, guard, context };
}

describe('verified tenant role resolution', () => {
  it.each([{}, { org_role: '', capiro_org_role: '  ' }])(
    'uses the current scoped membership only when role claims are absent: %j',
    async (claims) => {
      const { guard, context, request, tenants } = setup(claims);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(tenants.activeMembershipRole).toHaveBeenCalledWith(TENANT, 'user-one');
      expect(request.tenantContext).toEqual({
        tenantId: TENANT,
        clerkUserId: 'user-one',
        role: 'user_admin',
      });
    },
  );

  it.each(['org:member', 'org:billing-admin', 'org:admin_readonly'])(
    'does not promote an explicit signed role %s from the local mirror',
    async (role) => {
      const { guard, context, request, tenants } = setup({ org_role: role });
      await guard.canActivate(context);
      expect(request.tenantContext?.role).toBe(role);
      expect(tenants.activeMembershipRole).not.toHaveBeenCalled();
    },
  );

  it('honors a populated custom role when the standard placeholder is empty', async () => {
    const { guard, context, request, tenants } = setup({
      org_role: '',
      capiro_org_role: 'org:member',
    });
    await guard.canActivate(context);
    expect(request.tenantContext?.role).toBe('org:member');
    expect(tenants.activeMembershipRole).not.toHaveBeenCalled();
  });

  it('does not grant a role after removal even if the membership existence cache was positive', async () => {
    const { guard, context, request, tenants } = setup();
    tenants.activeMembershipRole.mockResolvedValue(null);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(request.tenantContext).toBeUndefined();
  });

  it('rejects tenant claim mismatches before reading a fallback role', async () => {
    const { guard, context, tenants } = setup({ capiro_tenant_id: 'another-tenant' });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tenants.activeMembershipRole).not.toHaveBeenCalled();
  });

  it('rejects invalid tokens before any membership lookup', async () => {
    const { guard, context, clerk, tenants } = setup();
    clerk.verifySessionToken.mockRejectedValue(new Error('invalid'));
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tenants.hasActiveMembership).not.toHaveBeenCalled();
    expect(tenants.activeMembershipRole).not.toHaveBeenCalled();
  });

  it('keeps ordinary active members ordinary', async () => {
    const { guard, context, request, tenants } = setup();
    tenants.activeMembershipRole.mockResolvedValue({ role: 'standard_user' });
    await guard.canActivate(context);
    expect(request.tenantContext?.role).toBe('standard_user');
  });
});

describe('impersonation parity', () => {
  it('switches a capiro_admin to the target tenant from a matching active session', async () => {
    const { guard, context, request, tenants } = setup({ org_role: 'org:admin' });
    request.headers['x-capiro-impersonate-tenant'] = ' Target-Tenant ';
    tenants.activeMembershipRole.mockResolvedValue({ role: 'capiro_admin' });
    tenants.resolveActiveImpersonation.mockResolvedValue({
      tenantId: IMPERSONATED_TENANT,
      slug: 'target-tenant',
      clerkOrgId: 'org-target',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(tenants.activeMembershipRole).toHaveBeenCalledWith(TENANT, 'user-one');
    expect(tenants.resolveActiveImpersonation).toHaveBeenCalledWith('user-one');
    expect(request.tenantContext).toEqual({
      tenantId: IMPERSONATED_TENANT,
      clerkUserId: 'user-one',
      role: 'capiro_admin',
    });
  });

  it('allows local-only capiro_admin proof when the signed role claim is absent', async () => {
    const { guard, context, request, tenants } = setup();
    request.headers['x-capiro-impersonate-tenant'] = 'target-tenant';
    tenants.activeMembershipRole.mockResolvedValue({ role: 'capiro_admin' });
    tenants.resolveActiveImpersonation.mockResolvedValue({
      tenantId: IMPERSONATED_TENANT,
      slug: 'target-tenant',
      clerkOrgId: 'org-target',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.tenantContext?.tenantId).toBe(IMPERSONATED_TENANT);
    expect(request.tenantContext?.role).toBe('capiro_admin');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rejects impersonated %s mutations instead of executing in either tenant',
    async (method) => {
      const { guard, context, request, tenants } = setup({ org_role: 'org:admin' });
      request.method = method;
      request.headers['x-capiro-impersonate-tenant'] = 'target-tenant';
      tenants.activeMembershipRole.mockResolvedValue({ role: 'capiro_admin' });
      tenants.resolveActiveImpersonation.mockResolvedValue({
        tenantId: IMPERSONATED_TENANT,
        slug: 'target-tenant',
        clerkOrgId: 'org-target',
      });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);

      expect(tenants.resolveActiveImpersonation).toHaveBeenCalledWith('user-one');
      expect(request.tenantContext).toBeUndefined();
    },
  );

  it.each(['HEAD', 'OPTIONS'])('allows impersonated %s reads', async (method) => {
    const { guard, context, request, tenants } = setup({ org_role: 'org:admin' });
    request.method = method;
    request.headers['x-capiro-impersonate-tenant'] = 'target-tenant';
    tenants.activeMembershipRole.mockResolvedValue({ role: 'capiro_admin' });
    tenants.resolveActiveImpersonation.mockResolvedValue({
      tenantId: IMPERSONATED_TENANT,
      slug: 'target-tenant',
      clerkOrgId: 'org-target',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.tenantContext?.tenantId).toBe(IMPERSONATED_TENANT);
  });

  it('rejects a stale local capiro_admin when the signed role is a member', async () => {
    const { guard, context, request, tenants } = setup({ org_role: 'org:member' });
    request.headers['x-capiro-impersonate-tenant'] = 'target-tenant';
    tenants.activeMembershipRole.mockResolvedValue({ role: 'capiro_admin' });
    tenants.resolveActiveImpersonation.mockResolvedValue({
      tenantId: IMPERSONATED_TENANT,
      slug: 'target-tenant',
      clerkOrgId: 'org-target',
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);

    expect(tenants.activeMembershipRole).toHaveBeenCalledWith(TENANT, 'user-one');
    expect(tenants.resolveActiveImpersonation).not.toHaveBeenCalled();
    expect(request.tenantContext).toBeUndefined();
  });

  it('rejects a capiro_admin impersonation header when no active session exists', async () => {
    const { guard, context, request, tenants } = setup({ org_role: 'org:admin' });
    request.headers['x-capiro-impersonate-tenant'] = 'target-tenant';
    tenants.activeMembershipRole.mockResolvedValue({ role: 'capiro_admin' });
    tenants.resolveActiveImpersonation.mockResolvedValue(null);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);

    expect(tenants.activeMembershipRole).toHaveBeenCalledWith(TENANT, 'user-one');
    expect(tenants.resolveActiveImpersonation).toHaveBeenCalledWith('user-one');
    expect(request.tenantContext).toBeUndefined();
  });

  it('rejects a capiro_admin header that does not match the active session target', async () => {
    const { guard, context, request, tenants } = setup({ org_role: 'org:admin' });
    request.headers['x-capiro-impersonate-tenant'] = 'requested-tenant';
    tenants.activeMembershipRole.mockResolvedValue({ role: 'capiro_admin' });
    tenants.resolveActiveImpersonation.mockResolvedValue({
      tenantId: IMPERSONATED_TENANT,
      slug: 'different-tenant',
      clerkOrgId: 'org-target',
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);

    expect(tenants.activeMembershipRole).toHaveBeenCalledWith(TENANT, 'user-one');
    expect(request.tenantContext).toBeUndefined();
  });

  it('does not let a non-admin impersonation header switch tenants', async () => {
    const { guard, context, request, tenants } = setup({ org_role: 'org:admin' });
    request.headers['x-capiro-impersonate-tenant'] = 'target-tenant';
    tenants.activeMembershipRole.mockResolvedValue({ role: 'standard_user' });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(tenants.activeMembershipRole).toHaveBeenCalledWith(TENANT, 'user-one');
    expect(tenants.resolveActiveImpersonation).not.toHaveBeenCalled();
    expect(request.tenantContext).toEqual({
      tenantId: TENANT,
      clerkUserId: 'user-one',
      role: 'org:admin',
    });
  });

  it('fails closed when the authoritative membership disappears before impersonation', async () => {
    const { guard, context, request, tenants } = setup({ org_role: 'org:admin' });
    request.headers['x-capiro-impersonate-tenant'] = 'target-tenant';
    tenants.activeMembershipRole.mockResolvedValue(null);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);

    expect(tenants.activeMembershipRole).toHaveBeenCalledWith(TENANT, 'user-one');
    expect(tenants.resolveActiveImpersonation).not.toHaveBeenCalled();
    expect(request.tenantContext).toBeUndefined();
  });
});
