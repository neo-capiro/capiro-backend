import { describe, expect, it, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';

// Domain service and provider-receipt seam only: no live identity, database,
// storage, AI, or extraction dependency is initialized by this suite.
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../auth/clerk.service.js', () => ({ ClerkService: class {} }));
jest.mock('../auth/clerk-provisioning.service.js', () => ({ ClerkProvisioningService: class {} }));
jest.mock('../auth/identity-outbox.service.js', () => ({ IdentityOutboxService: class {} }));
jest.mock('../program-element/program-element-writer.service.js', () => ({
  ProgramElementWriterService: class {},
}));
jest.mock('../program-element/jbook/jbook-extract.js', () => ({ isValidPeCode: jest.fn() }));
jest.mock('../acquisition-personnel/acquisition-personnel-writer.service.js', () => ({
  AcquisitionPersonnelWriterService: class {},
}));
jest.mock('../ai-usage/ai-usage.service.js', () => ({ AiUsageService: class {} }));
jest.mock('../ai-usage/ai-credential-store.service.js', () => ({
  AiCredentialStoreService: class {},
  AI_PROVIDERS: ['openai', 'anthropic'],
}));
jest.mock('../billing/billing.service.js', () => ({ BillingService: class {} }));
jest.mock('../meri/meri-feature-flags.service.js', () => ({ MeriFeatureFlagsService: class {} }));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: class {} }), { virtual: true });

import { CapiroAdminService } from '../capiro-admin/capiro-admin.service.js';
import { CapiroAdminController } from '../capiro-admin/capiro-admin.controller.js';
import { BillingService } from '../billing/billing.service.js';

function fixture() {
  const receipt = {
    id: 'inv-new',
    organizationId: 'org-a',
    emailAddress: 'Admin@Example.com',
    role: 'org:admin',
  };
  const organizations = {
    getOrganizationInvitationList: jest.fn(async () => ({ data: [] })),
    revokeOrganizationInvitation: jest.fn(),
    createOrganizationInvitation: jest.fn(async () => receipt),
  };
  const service = new CapiroAdminService(
    {
      withSystem: async (fn: any) =>
        fn({ tenant: { findUnique: async () => ({ id: 'tenant-a', clerkOrgId: 'org-a' }) } }),
    } as never,
    { backend: { organizations } } as never,
    {} as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, receipt, organizations };
}

describe('ST-24 HQ invitation receipts', () => {
  it('qualifies a provider receipt against the current tenant, normalized recipient and role', async () => {
    const h = fixture();
    await expect(
      h.service.resendAdminInvitation('tenant-a', ' ADMIN@example.com '),
    ).resolves.toEqual({
      invitationId: 'inv-new',
      tenantId: 'tenant-a',
      email: 'admin@example.com',
      role: 'user_admin',
    });
    expect(h.organizations.createOrganizationInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        emailAddress: 'admin@example.com',
        role: 'org:admin',
      }),
    );
  });

  it('direct HTTP rejects nonstaff before effects and refuses empty, foreign-organization, wrong-recipient or wrong-role provider receipts', async () => {
    const h = fixture();
    const mod = await Test.createTestingModule({
      controllers: [CapiroAdminController],
      providers: [
        { provide: CapiroAdminService, useValue: h.service },
        { provide: BillingService, useValue: {} },
      ],
    }).compile();
    const app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    let role = 'user_admin';
    // Trusted Core context seam; the real HQ role guard remains enabled.
    app.use((req: any, _res: any, next: () => void) => {
      req.tenantContext = { tenantId: 'tenant-a', userId: 'actor', role };
      next();
    });
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/capiro-admin/tenants/tenant-a/admins/resend`;
    const send = () =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com' }),
      });
    try {
      expect((await send()).status).toBe(403);
      expect(h.organizations.getOrganizationInvitationList).not.toHaveBeenCalled();
      expect(h.organizations.revokeOrganizationInvitation).not.toHaveBeenCalled();
      expect(h.organizations.createOrganizationInvitation).not.toHaveBeenCalled();
      role = 'capiro_admin';
      for (const bad of [
        { ...h.receipt, id: '' },
        { ...h.receipt, organizationId: 'org-b' },
        { ...h.receipt, emailAddress: 'other@example.com' },
        { ...h.receipt, role: 'org:member' },
      ]) {
        h.organizations.createOrganizationInvitation.mockResolvedValueOnce(bad);
        expect((await send()).status).toBe(502);
      }
    } finally {
      await app.close();
    }
  });
});
