import { beforeEach, describe, expect, it, jest } from '@jest/globals';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../auth/clerk.service.js', () => ({ ClerkService: class {} }));
jest.mock('../auth/clerk-provisioning.service.js', () => ({ ClerkProvisioningService: class {} }));
jest.mock('../auth/identity-outbox.service.js', () => ({ IdentityOutboxService: class {} }));
import { TenantAdminService } from './tenant-admin.service.js';

const ctx = {
  tenantId: 'tenant-a',
  tenantSlug: 'a',
  userId: 'actor',
  clerkUserId: 'clerk-a',
  role: 'user_admin' as const,
};
function fixture() {
  const actor = {
    id: 'actor-member',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    role: 'user_admin',
    status: 'active',
  };
  const target = {
    id: 'target-member',
    tenantId: ctx.tenantId,
    userId: 'target',
    role: 'standard_user',
    status: 'active',
    user: { clerkUserId: 'clerk-target' },
    tenant: { clerkOrgId: 'org-a' },
  };
  const row = { id: ctx.tenantId, name: 'Before', clerkOrgId: 'org-a', status: 'active' };
  let inTransaction = false;
  const tx = {
    $queryRaw: jest.fn(async () => [{ actor: '' }]),
    $executeRaw: jest.fn(async () => 0),
    tenantMembership: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          [actor, target].find(
            (m) =>
              m.tenantId === where.tenantId_userId.tenantId &&
              m.userId === where.tenantId_userId.userId,
          ) ?? null,
      ),
      update: jest.fn(async ({ data }: any) => Object.assign(target, data)),
    },
    tenant: {
      update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
      findUnique: jest.fn(async () => ({ ...row })),
    },
  };
  const outbox = {
    enqueueClerkMembershipDelete: jest.fn(async () => {
      expect(inTransaction).toBe(true);
      return 'job-a';
    }),
    attemptNow: jest.fn(async () => {
      expect(inTransaction).toBe(false);
      return false;
    }),
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, body: any) => {
      inTransaction = true;
      try {
        return await body(tx);
      } finally {
        inTransaction = false;
      }
    }),
  };
  const service = new TenantAdminService(
    prisma as never,
    { backend: { organizations: { updateOrganization: jest.fn(async (id: string, data: { name: string }) => ({ id, ...data })) } } } as never,
    {} as never,
    {} as never,
    outbox as never,
  );
  return { service, actor, target, tx, row, outbox, prisma };
}
describe('A1 authoritative tenant-admin service safety boundaries', () => {
  let h: ReturnType<typeof fixture>;
  let role: string;
  beforeEach(() => {
    h = fixture();
    role = ctx.role;
  });
  const remove = () => h.service.removeMember({ ...ctx, role } as never, 'target');

  it('ST-01 rejects logo metadata on generic PUT before any write, including service callers', async () => {
    for (const input of [
      { logoS3Key: 'tenants/tenant-b/branding/logo.png' },
      { logoContentType: 'image/png' },
    ]) {
      await expect(h.service.updateBranding(ctx, input as never)).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(h.tx.tenant.update).not.toHaveBeenCalled();
  });

  it('ST-01 permits name changes without changing stored logo attribution', async () => {
    Object.assign(h.row, { logoS3Key: 'existing-own-logo', logoContentType: 'image/png' });
    const res = await h.service.updateBranding(ctx, { name: 'After' });
    expect(res.name).toBe('After');
    expect(h.tx.tenant.update).toHaveBeenCalledWith({
      where: { id: ctx.tenantId },
      data: { name: 'After' },
    });
    expect(h.row).toMatchObject({ logoS3Key: 'existing-own-logo', logoContentType: 'image/png' });
  });

  it('ST-02 refuses protected Capiro targets for tenant admins and staff before local or outbox changes', async () => {
    h.target.role = 'capiro_admin';
    for (const caller of ['user_admin', 'capiro_admin']) {
      role = caller;
      await expect(remove()).rejects.toMatchObject({ status: 403 });
    }
    expect(h.target.status).toBe('active');
    expect(h.tx.tenantMembership.update).not.toHaveBeenCalled();
    expect(h.outbox.enqueueClerkMembershipDelete).not.toHaveBeenCalled();
    expect(h.outbox.attemptNow).not.toHaveBeenCalled();
  });

  it('ST-02 refuses self, foreign-tenant targets and ordinary users without effects', async () => {
    await expect(h.service.removeMember(ctx, 'actor')).rejects.toMatchObject({ status: 400 });
    h.target.tenantId = 'tenant-b';
    await expect(remove()).rejects.toMatchObject({ status: 404 });
    role = 'standard_user';
    h.target.tenantId = ctx.tenantId;
    await expect(remove()).rejects.toMatchObject({ status: 403 });
    expect(h.tx.tenantMembership.update).not.toHaveBeenCalled();
    expect(h.outbox.enqueueClerkMembershipDelete).not.toHaveBeenCalled();
  });

  it('X-04 rechecks removed or downgraded local admin at the removal transaction', async () => {
    h.actor.status = 'removed';
    await expect(remove()).rejects.toMatchObject({ status: 403 });
    h.actor.status = 'active';
    h.actor.role = 'standard_user';
    await expect(remove()).rejects.toMatchObject({ status: 403 });
    expect(h.target.status).toBe('active');
    expect(h.outbox.enqueueClerkMembershipDelete).not.toHaveBeenCalled();
  });

  it('ST-02 commits ordinary local removal despite a failed Clerk delivery and keeps retry idempotent', async () => {
    const result = await remove();
    expect(result).toMatchObject({ ok: true });
    expect(h.target.status).toBe('removed');
    expect(h.outbox.enqueueClerkMembershipDelete).toHaveBeenCalledTimes(1);
    expect(h.outbox.attemptNow).toHaveBeenCalledWith('job-a');
    await expect(remove()).resolves.toMatchObject({ ok: true });
    expect(h.tx.tenantMembership.update).toHaveBeenCalledTimes(1);
    expect(h.outbox.enqueueClerkMembershipDelete).toHaveBeenCalledTimes(1);
  });
});
