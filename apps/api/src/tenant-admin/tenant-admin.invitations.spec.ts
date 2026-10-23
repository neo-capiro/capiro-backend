import { describe, expect, it, jest } from '@jest/globals';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../auth/clerk.service.js', () => ({ ClerkService: class {} }));
jest.mock('../auth/clerk-provisioning.service.js', () => ({ ClerkProvisioningService: class {} }));
jest.mock('../auth/identity-outbox.service.js', () => ({ IdentityOutboxService: class {} }));
import { TenantAdminService } from './tenant-admin.service.js';

const ctx = {
  tenantId: 'tenant-a',
  tenantSlug: 'synthetic',
  userId: 'actor',
  clerkUserId: 'clerk-actor',
  role: 'user_admin' as const,
};
const invitation = (id: string, email = `${id}@example.test`) => ({
  id,
  emailAddress: email,
  organizationId: 'org-a',
  status: 'pending',
  role: 'org:admin',
  createdAt: 1,
  expiresAt: 4_102_444_800_000,
  publicMetadata: {
    first_name: 'Ada',
    last_name: 'Lovelace',
    capiro_tenant_id: 'wrong',
    ignored: true,
  },
});
function fixture() {
  const rows = [
    ...Array.from({ length: 100 }, (_, i) => invitation(`i${i}`)),
    invitation('target'),
  ];
  const organizations = {
    getOrganizationInvitationList: jest.fn(
      async ({ offset, limit }: { offset: number; limit: number }) => ({
        data: rows.slice(offset, offset + limit),
        totalCount: rows.length,
      }),
    ),
    revokeOrganizationInvitation: jest.fn(async () => ({})),
    createOrganizationInvitation: jest.fn(async () =>
      invitation('replacement', 'target@example.test'),
    ),
  };
  const tx = {
    tenant: { findUnique: jest.fn(async () => ({ id: 'tenant-a', clerkOrgId: 'org-a' })) },
    tenantMembership: { findFirst: jest.fn(async () => null) },
  };
  const prisma = {
    withSystem: async (fn: (tx: unknown) => unknown) => fn(tx),
    withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx),
  };
  const service = new TenantAdminService(
    prisma as never,
    { backend: { organizations } } as never,
    {} as never,
    { get: () => 'https://synthetic.example.test' } as never,
    {} as never,
  );
  return { service, organizations, rows };
}
describe('tenant invitation replacement (synthetic provider, no requests)', () => {
  it('lists and resends a target beyond page one with safe names and exact replacement receipt', async () => {
    const h = fixture();
    expect(await h.service.listPendingInvitations(ctx)).toHaveLength(101);
    const result = await h.service.resendInvitation(ctx, 'target');
    expect(result).toMatchObject({
      replacedInvitationId: 'target',
      invitationId: 'replacement',
      invitation: { id: 'replacement', email: 'target@example.test' },
    });
    expect(h.organizations.createOrganizationInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        emailAddress: 'target@example.test',
        role: 'org:admin',
        publicMetadata: { first_name: 'Ada', last_name: 'Lovelace', capiro_tenant_id: 'tenant-a' },
      }),
    );
  });
  it('revokes all matching pending duplicate emails before creating a replacement', async () => {
    const h = fixture();
    h.rows[0]!.emailAddress = 'TARGET@example.test';
    await h.service.inviteTeamMember(ctx, {
      email: ' target@example.test ',
      role: 'standard_user',
    });
    expect(h.organizations.revokeOrganizationInvitation).toHaveBeenCalledTimes(2);
    expect(h.organizations.createOrganizationInvitation).toHaveBeenCalledTimes(1);
  });
  it('denies foreign/expired/revoked targets without a write', async () => {
    for (const kind of ['missing', 'expired', 'revoked', 'foreign']) {
      const h = fixture(),
        target = h.rows.at(-1)!;
      if (kind === 'expired') target.expiresAt = 1;
      if (kind === 'revoked') target.status = 'revoked';
      if (kind === 'foreign') target.organizationId = 'org-b';
      await expect(
        h.service.resendInvitation(ctx, kind === 'missing' ? 'absent' : 'target'),
      ).rejects.toThrow();
      expect(h.organizations.revokeOrganizationInvitation).not.toHaveBeenCalled();
      expect(h.organizations.createOrganizationInvitation).not.toHaveBeenCalled();
    }
  });
  it('does not report definite failure or automatically retry a replacement lost after revoke', async () => {
    const h = fixture();
    h.organizations.createOrganizationInvitation.mockRejectedValueOnce(
      new Error('synthetic lost response'),
    );
    await expect(h.service.resendInvitation(ctx, 'target')).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('replacement result is unconfirmed'),
    });
    expect(h.organizations.revokeOrganizationInvitation).toHaveBeenCalledTimes(1);
    expect(h.organizations.createOrganizationInvitation).toHaveBeenCalledTimes(1);
  });
  it('stops before replacement on uncertain revoke, including partial duplicate cleanup', async () => {
    for (const action of ['resend', 'invite']) {
      const h = fixture();
      h.rows[0]!.emailAddress = 'target@example.test';
      h.organizations.revokeOrganizationInvitation.mockRejectedValueOnce(
        new Error('synthetic revoke lost'),
      );
      await expect(
        action === 'resend'
          ? h.service.resendInvitation(ctx, 'target')
          : h.service.inviteTeamMember(ctx, {
              email: 'target@example.test',
              role: 'standard_user',
            }),
      ).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining('revocation is unconfirmed'),
      });
      expect(h.organizations.createOrganizationInvitation).not.toHaveBeenCalled();
    }
  });
  it('retains uncertainty when initial invitation creation fails after duplicate cleanup', async () => {
    const h = fixture();
    h.organizations.createOrganizationInvitation.mockRejectedValueOnce(
      new Error('synthetic create lost'),
    );
    await expect(
      h.service.inviteTeamMember(ctx, { email: 'target@example.test', role: 'standard_user' }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('result is unconfirmed'),
    });
    expect(h.organizations.revokeOrganizationInvitation).toHaveBeenCalledTimes(1);
    expect(h.organizations.createOrganizationInvitation).toHaveBeenCalledTimes(1);
  });
});
