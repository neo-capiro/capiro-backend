import { OrgTenantResolverService } from './org-tenant-resolver.service.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

describe('uncached role fallback', () => {
  it('binds both the verified tenant and subject and requires an active membership', async () => {
    const query = jest.fn().mockResolvedValue([{ role: 'user_admin' }]);
    const service = new OrgTenantResolverService({
      withSystem: (fn: (tx: unknown) => unknown) => fn({ $queryRaw: query }),
    } as never);
    expect(await service.activeMembershipRole('tenant-a', 'user-a')).toEqual({
      role: 'user_admin',
    });
    const [sql, tenant, user] = query.mock.calls[0];
    expect(sql.join('?')).toMatch(/tm\.tenant_id = \?::uuid/);
    expect(sql.join('?')).toMatch(/u\.clerk_user_id = \?/);
    expect(sql.join('?')).toMatch(/tm\.status::text = 'active'/);
    expect([tenant, user]).toEqual(['tenant-a', 'user-a']);
    query.mockResolvedValue([{ role: 'standard_user' }]);
    expect(await service.activeMembershipRole('tenant-a', 'user-a')).toEqual({
      role: 'standard_user',
    });
    query.mockResolvedValue([]);
    expect(await service.activeMembershipRole('tenant-a', 'user-a')).toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the authoritative membership store is unavailable', async () => {
    const service = new OrgTenantResolverService({
      withSystem: jest.fn().mockRejectedValue(new Error('offline')),
    } as never);
    expect(await service.activeMembershipRole('tenant-a', 'user-a')).toBeNull();
  });
});

describe('uncached active impersonation resolution', () => {
  it('joins the actor, active session, and target tenant and returns the current target', async () => {
    const firstTarget = {
      id: '00000000-0000-4000-8000-000000000002',
      slug: 'target-one',
      clerkOrgId: 'org-target-one',
    };
    const secondTarget = {
      id: '00000000-0000-4000-8000-000000000003',
      slug: 'target-two',
      clerkOrgId: null,
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce([firstTarget])
      .mockResolvedValueOnce([secondTarget])
      .mockResolvedValueOnce([]);
    const service = new OrgTenantResolverService({
      withSystem: (fn: (tx: unknown) => unknown) => fn({ $queryRaw: query }),
    } as never);

    await expect(service.resolveActiveImpersonation('user-a')).resolves.toEqual({
      tenantId: firstTarget.id,
      slug: firstTarget.slug,
      clerkOrgId: firstTarget.clerkOrgId,
    });

    const [sql, clerkUserId] = query.mock.calls[0];
    const statement = sql.join('?');
    expect(statement).toMatch(/FROM impersonation_sessions/i);
    expect(statement).toMatch(/JOIN users u ON u\.id = .*actor_user_id/i);
    expect(statement).toMatch(/JOIN tenants t ON t\.id = .*tenant_id/i);
    expect(statement).toMatch(/u\.clerk_user_id = \?/i);
    expect(statement).toMatch(/ended_at IS NULL/i);
    expect(statement).toMatch(/expires_at > (?:CURRENT_TIMESTAMP|NOW\(\))/i);
    expect(clerkUserId).toBe('user-a');

    // Session creation/end is security-sensitive, so this lookup must not cache
    // either a positive result or a miss.
    await expect(service.resolveActiveImpersonation('user-a')).resolves.toEqual({
      tenantId: secondTarget.id,
      slug: secondTarget.slug,
      clerkOrgId: secondTarget.clerkOrgId,
    });
    await expect(service.resolveActiveImpersonation('user-a')).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the impersonation store is unavailable', async () => {
    const service = new OrgTenantResolverService({
      withSystem: jest.fn().mockRejectedValue(new Error('offline')),
    } as never);

    await expect(service.resolveActiveImpersonation('user-a')).resolves.toBeNull();
  });
});
