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
