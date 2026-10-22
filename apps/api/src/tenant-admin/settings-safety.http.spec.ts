import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../auth/clerk.service.js', () => ({ ClerkService: class {} }));
jest.mock('../auth/clerk-provisioning.service.js', () => ({ ClerkProvisioningService: class {} }));
jest.mock('../auth/identity-outbox.service.js', () => ({ IdentityOutboxService: class {} }));
jest.mock(
  '@aws-sdk/client-s3',
  () => ({
    S3Client: class {
      send = jest.fn(async () => ({ ContentType: 'image/jpeg', ContentLength: 100 }));
    },
    GetObjectCommand: class {
      constructor(public input: unknown) {}
    },
    HeadObjectCommand: class {
      constructor(public input: unknown) {}
    },
  }),
  { virtual: true },
);
jest.mock(
  '@aws-sdk/s3-presigned-post',
  () => ({
    createPresignedPost: jest.fn(async () => ({ url: 'https://upload.invalid', fields: {} })),
  }),
  { virtual: true },
);
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }), { virtual: true });
import { TenantAdminService } from './tenant-admin.service.js';
import { TenantAdminController } from './tenant-admin.controller.js';
import { BrandingService } from '../branding/branding.service.js';
import { BrandingController } from '../branding/branding.controller.js';

const ctx = {
  tenantId: 'tenant-a',
  tenantSlug: 'a',
  userId: 'actor',
  clerkUserId: 'clerk-a',
  role: 'user_admin',
};
describe('A1 Settings direct HTTP negative boundaries', () => {
  let app: INestApplication;
  let base: string;
  let role: string;
  let tx: any;
  let outbox: any;
  let branding: BrandingService;
  beforeEach(async () => {
    role = ctx.role;
    tx = {
      $queryRaw: jest.fn(async () => []),
      tenant: {
        findUnique: jest.fn(async () => ({
          id: ctx.tenantId,
          logoS3Key: null,
          logoContentType: null,
          logoUploadedAt: null,
        })),
        update: jest.fn(async ({ data }: any) => ({ id: ctx.tenantId, ...data })),
      },
      tenantMembership: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.tenantId_userId.userId === ctx.userId
            ? { role: 'user_admin', status: 'active' }
            : {
                id: 'target',
                role: 'capiro_admin',
                status: 'active',
                tenant: { clerkOrgId: 'org-a' },
                user: { clerkUserId: 'clerk-target' },
              },
        ),
        update: jest.fn(async () => ({})),
      },
    };
    outbox = { enqueueClerkMembershipDelete: jest.fn(async () => 'job'), attemptNow: jest.fn() };
    const prisma = { withTenant: async (_tenant: string, body: any) => body(tx) };
    const service = new TenantAdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      outbox,
    );
    branding = new BrandingService(
      prisma as never,
      { get: (key: string) => (key === 'ASSETS_BUCKET' ? 'assets-test' : 'us-east-1') } as never,
    );
    const mod = await Test.createTestingModule({
      controllers: [TenantAdminController, BrandingController],
      providers: [
        { provide: TenantAdminService, useValue: service },
        { provide: BrandingService, useValue: branding },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    // Core middleware owns authentication/current session admission. These
    // transport tests start at its trusted context seam, retain real route
    // guards/DTOs, and use the actual domain services with inert providers.
    app.use((req: any, _res: any, next: () => void) => {
      req.tenantContext = { ...ctx, role };
      next();
    });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterEach(async () => app?.close());
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}/tenant-admin${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('ST-01 generic branding rejects forged logo metadata at the direct PUT route', async () => {
    for (const body of [
      { logoS3Key: 'tenants/tenant-b/branding/logo.png' },
      { logoContentType: 'image/png' },
    ]) {
      expect((await send('PUT', '/branding', body)).status).toBe(400);
    }
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });

  it('ST-01 direct confirm rejects a false HEAD MIME before persisting the logo', async () => {
    const issued = await send('POST', '/branding/logo/upload-url', {
      contentType: 'image/png',
      contentLength: 100,
    });
    expect(issued.status).toBe(201);
    const { s3Key } = (await issued.json()) as { s3Key: string };
    expect(
      (await send('POST', '/branding/logo/confirm', { s3Key, contentType: 'image/png' })).status,
    ).toBe(400);
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });

  it('ST-02 direct DELETE rejects a protected target and standard-user callers with no effects', async () => {
    expect((await send('DELETE', '/team/target')).status).toBe(403);
    role = 'standard_user';
    expect((await send('DELETE', '/team/target')).status).toBe(403);
    expect(tx.tenantMembership.update).not.toHaveBeenCalled();
    expect(outbox.enqueueClerkMembershipDelete).not.toHaveBeenCalled();
    expect(outbox.attemptNow).not.toHaveBeenCalled();
  });

  it('ST-01 direct confirm refuses a superseded upload even inside its five-minute window', async () => {
    tx.tenant.findUnique.mockResolvedValue({
      id: ctx.tenantId,
      logoS3Key: 'newer-logo',
      logoContentType: 'image/png',
      logoUploadedAt: new Date(Date.now() + 1000),
    });
    const issued = await send('POST', '/branding/logo/upload-url', {
      contentType: 'image/png',
      contentLength: 100,
    });
    const { s3Key } = (await issued.json()) as { s3Key: string };
    const issuedAt = s3Key.slice(`tenants/${ctx.tenantId}/branding/logo-`.length).split('-')[0];
    (branding as any).s3.send.mockResolvedValue({
      ContentType: 'image/png',
      ContentLength: 100,
      Metadata: { 'tenant-id': ctx.tenantId, 'upload-issued-at': issuedAt },
    });
    expect(
      (await send('POST', '/branding/logo/confirm', { s3Key, contentType: 'image/png' })).status,
    ).toBe(400);
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });
});
