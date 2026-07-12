import { UnauthorizedException } from '@nestjs/common';
import { MeriContextResolver } from './meri-context.resolver';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrchestratorTenantContext } from '../auth/tenant-context';

function prismaWithUser(user: { id: string } | null): PrismaService {
  return { user: { findUnique: async () => user } } as unknown as PrismaService;
}

const tc: OrchestratorTenantContext = {
  tenantId: 't1',
  clerkUserId: 'clerk_1',
  role: 'org:member',
};

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

  // Regression (Phase 2 audit, 2026-07-12): loadUserVoice used plain withTenant,
  // which never sets `app.current_user` — the Phase 1 owner-aware RLS policy on
  // memory_items then hides every `visibility='user'` row, silently zeroing out
  // the user-voice block on every GA-chat turn. Must go through withTenantUser.
  it("loads the caller's private user-voice file via withTenantUser (not withTenant)", async () => {
    const calls: Array<{ tenantId: string; userId: string }> = [];
    // withTenant is exercised too (firm-soul/compass, in parallel via
    // Promise.all) — resolves empty rather than throwing.
    const prisma = {
      user: { findUnique: async () => ({ id: 'user-9' }) },
      withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
        fn({ $queryRaw: async () => [] }),
      withTenantUser: async (tenantId: string, userId: string, fn: (tx: unknown) => unknown) => {
        calls.push({ tenantId, userId });
        return fn({
          $queryRaw: async () => [
            { sections: [{ owner: 'human', heading: 'Tone', body: 'Direct and concise.' }] },
          ],
        });
      },
    } as unknown as PrismaService;

    const r = new MeriContextResolver(prisma);
    const ctx = await r.resolve(tc);

    expect(calls).toEqual([{ tenantId: 't1', userId: 'user-9' }]);
    expect(ctx.userVoice).toContain('Direct and concise.');
  });
});
