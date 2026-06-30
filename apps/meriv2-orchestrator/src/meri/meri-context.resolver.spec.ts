import { UnauthorizedException } from '@nestjs/common';
import { MeriContextResolver } from './meri-context.resolver';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrchestratorTenantContext } from '../auth/tenant-context';

function prismaWithUser(user: { id: string } | null): PrismaService {
  return { user: { findUnique: async () => user } } as unknown as PrismaService;
}

const tc: OrchestratorTenantContext = { tenantId: 't1', clerkUserId: 'clerk_1', role: 'org:member' };

describe('MeriContextResolver', () => {
  it('resolves the Capiro userId and builds a full MeriContext', async () => {
    const r = new MeriContextResolver(prismaWithUser({ id: 'user-9' }));
    const ctx = await r.resolve(tc);
    expect(ctx).toEqual({
      tenantId: 't1',
      userId: 'user-9',
      clerkUserId: 'clerk_1',
      role: 'standard_user',
    });
  });

  it('maps an admin org role to user_admin (conservative, never escalates)', async () => {
    const r = new MeriContextResolver(prismaWithUser({ id: 'u' }));
    expect((await r.resolve({ ...tc, role: 'org:admin' })).role).toBe('user_admin');
    expect((await r.resolve({ ...tc, role: null })).role).toBe('standard_user');
  });

  it('fails closed (401) when the verified identity has no Capiro user', async () => {
    const r = new MeriContextResolver(prismaWithUser(null));
    await expect(r.resolve(tc)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
