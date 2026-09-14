import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { TenantGuard } from './tenant.guard.js';

jest.mock('./clerk.service.js', () => ({ ClerkService: class {} }));
jest.mock('./org-tenant-resolver.service.js', () => ({ OrgTenantResolverService: class {} }));

const TENANT = '00000000-0000-4000-8000-000000000001';
function setup(claims: Record<string, unknown> = {}) {
  const request: { headers: { authorization: string }; tenantContext?: { role: string | null } } = {
    headers: { authorization: 'Bearer verified-fixture' },
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
