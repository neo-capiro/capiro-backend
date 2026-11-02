import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock(
  '@aws-sdk/client-s3',
  () => ({
    S3Client: class {
      send = jest.fn();
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
jest.mock(
  '@aws-sdk/s3-request-presigner',
  () => ({
    getSignedUrl: jest.fn(async () => 'https://signed.invalid'),
  }),
  { virtual: true },
);

import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BrandingService } from './branding.service.js';

const ctx = {
  tenantId: 'tenant-a',
  tenantSlug: 'a',
  userId: 'actor',
  clerkUserId: 'clerk-a',
  role: 'user_admin' as const,
};
function fixture() {
  const row: any = {
    id: ctx.tenantId,
    name: 'Acme',
    logoS3Key: null,
    logoContentType: null,
    logoUploadedAt: null,
  };
  const tx = {
    $queryRaw: jest.fn(async () => []),
    tenant: {
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
    },
  };
  const service = new BrandingService(
    {
      withTenant: async (_tenant: string, read: any) => read(tx),
      withSystem: async (read: any) => read(tx),
    } as never,
    { get: (key: string) => (key === 'ASSETS_BUCKET' ? 'assets-test' : 'us-east-1') } as never,
  );
  const send = (service as any).s3.send;
  return { service, row, tx, send };
}
async function upload(h: ReturnType<typeof fixture>) {
  const result = await h.service.createLogoUploadUrl(ctx, 'image/png', 100);
  const args: any = jest.mocked(createPresignedPost).mock.calls.at(-1)![1];
  const metadata = Object.fromEntries(
    Object.entries(args.Fields)
      .filter(([key]) => key.startsWith('x-amz-meta-'))
      .map(([key, value]) => [key.slice(11), value]),
  );
  h.send.mockResolvedValue({ ContentType: 'image/png', ContentLength: 100, Metadata: metadata });
  return result.s3Key;
}

beforeEach(() => {
  jest.clearAllMocks();
});
describe('ST-01 branding object admission', () => {
  it('issues an exact unique tenant upload with signed ownership and a nonempty size policy', async () => {
    const h = fixture();
    // Two requests may issue within the same millisecond (for example from
    // separate tabs); the object identity must still remain distinct.
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now());
    let first: string, second: string;
    try {
      first = await upload(h);
      second = await upload(h);
    } finally {
      clock.mockRestore();
    }
    expect(first).not.toBe(second);
    expect(first).toMatch(/^tenants\/tenant-a\/branding\/logo-\d+-[0-9a-f-]{36}\.png$/);
    const options: any = jest.mocked(createPresignedPost).mock.calls[0]![1];
    expect(options.Conditions).toContainEqual(['eq', '$key', first]);
    expect(options.Conditions).toContainEqual(['content-length-range', 1, 2 * 1024 * 1024]);
    expect(options.Fields['x-amz-meta-tenant-id']).toBe(ctx.tenantId);
    for (const size of [0, -1, NaN, 1.5, 2 * 1024 * 1024 + 1]) {
      await expect(h.service.createLogoUploadUrl(ctx, 'image/png', size)).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  it('rejects foreign, unrelated and forged upload keys before storage access', async () => {
    const h = fixture();
    for (const key of [
      'tenants/tenant-b/branding/logo.png',
      'tenants/tenant-a/private/file.png',
      'tenants/tenant-a/branding/other.png',
      'tenants/tenant-a/branding/../private.png',
      'tenants/tenant-a/branding/logo.png',
    ]) {
      await expect(h.service.confirmLogoUpload(ctx, key, 'image/png')).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(h.send).not.toHaveBeenCalled();
    expect(h.tx.tenant.update).not.toHaveBeenCalled();
  });

  it('rejects missing objects and false MIME, invalid size or ownership metadata without persisting', async () => {
    const h = fixture();
    const key = await upload(h);
    const good = await h.send();
    h.send.mockClear();
    for (const head of [
      null,
      { ...good, ContentType: undefined },
      { ...good, ContentType: 'image/jpeg' },
      { ...good, ContentLength: undefined },
      { ...good, ContentLength: 0 },
      { ...good, ContentLength: 2 * 1024 * 1024 + 1 },
      { ...good, Metadata: {} },
      { ...good, Metadata: { ...good.Metadata, 'tenant-id': 'tenant-b' } },
    ]) {
      h.send.mockResolvedValue(head);
      await expect(h.service.confirmLogoUpload(ctx, key, 'image/png')).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(h.tx.tenant.update).not.toHaveBeenCalled();
  });

  it('refuses an expired upload and an extension/content-type substitution', async () => {
    const h = fixture();
    const key = await upload(h);
    await expect(h.service.confirmLogoUpload(ctx, key, 'image/jpeg')).rejects.toMatchObject({
      status: 400,
    });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000);
    try {
      await expect(h.service.confirmLogoUpload(ctx, key, 'image/png')).rejects.toMatchObject({
        status: 400,
      });
    } finally {
      clock.mockRestore();
    }
    expect(h.tx.tenant.update).not.toHaveBeenCalled();
  });

  it('confirms a verified upload and signs only the exact own-tenant object', async () => {
    const h = fixture();
    const key = await upload(h);
    await h.service.confirmLogoUpload(ctx, key, 'image/png');
    expect(h.tx.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ctx.tenantId },
        data: expect.objectContaining({ logoS3Key: key, logoContentType: 'image/png' }),
      }),
    );
    expect((await h.service.getBranding(ctx))?.logoUrl).toBe('/api/firm-logo');
    // The signed-URL owner is now the no-session share path, not the settings payload.
    expect(await h.service.signedLogoUrlForTenant(ctx.tenantId)).not.toBeNull();
    expect(jest.mocked(getSignedUrl).mock.calls.at(-1)?.[1]).toMatchObject({ input: { Key: key } });
  });

  it('withholds foreign or corrupted persisted keys but retains safe legacy own-tenant logos', async () => {
    const h = fixture();
    for (const key of [
      'tenants/tenant-b/branding/logo.png',
      'tenants/tenant-a/private/file.png',
      'tenants/tenant-a/branding/../private.png',
      'tenants/tenant-a/branding/unknown.png',
    ]) {
      Object.assign(h.row, { logoS3Key: key, logoContentType: 'image/png' });
      const result = await h.service.getBranding(ctx);
      expect(result).toMatchObject({ logoUrl: null, logoS3Key: null, logoContentType: null });
    }
    expect((await h.service.getBranding(ctx))?.logoUrl).toBeNull();
    expect(getSignedUrl).not.toHaveBeenCalled();
    Object.assign(h.row, {
      logoS3Key: 'tenants/tenant-a/branding/logo.png',
      logoContentType: 'image/png',
    });
    expect((await h.service.getBranding(ctx))?.logoUrl).toBe('/api/firm-logo');
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
