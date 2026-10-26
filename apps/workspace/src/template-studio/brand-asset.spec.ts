import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { BrandAssetService } from './brand-asset.service.js';
import { BrandAssetAttachmentClient } from './brand-asset-attachment.client.js';
import { RegisterBrandAssetDto } from './brand-asset.controller.js';
import { validate } from 'class-validator';

const tenant = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const key = `tenants/${tenant}/engagement/upload/logo.png`;
function source(extra: Record<string, unknown> = {}) {
  return {
    id,
    tenantId: tenant,
    s3Key: key,
    fileName: 'logo.png',
    contentType: 'image/png',
    byteSize: 12,
    downloadUrl: 'https://assets.example.test/logo.png?signature=fresh',
    usable: true,
    clientId: null,
    prospectId: null,
    meetingId: null,
    mailMessageId: null,
    viewerMode: 'all',
    lifecycleStatus: 'ready',
    calculatedSha256: 'a'.repeat(64),
    ...extra,
  };
}
const record = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: tenant,
  objectKey: key,
  filename: 'logo.png',
  mimeType: 'image/png',
  sizeBytes: 12,
  url: 'https://assets.example.test/expired',
};
function fixture() {
  let asset: typeof record | null = null;
  const db = {
    wsBrandAsset: {
      findFirst: jest.fn(async ({ where }) =>
        asset &&
        where.tenantId === asset.tenantId &&
        (!where.id || where.id === asset.id) &&
        (!where.objectKey || where.objectKey === asset.objectKey)
          ? asset
          : null,
      ),
      findMany: jest.fn(async () => (asset ? [asset] : [])),
      create: jest.fn(async ({ data }) => {
        asset = { id: record.id, ...data };
        return asset;
      }),
      delete: jest.fn(async () => {
        asset = null;
      }),
    },
    wsThemeVersion: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    wsBlueprintVersion: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    wsDraft: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    wsDocVersion: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    $executeRaw: jest.fn(async () => 1),
    $transaction: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(db),
    ),
  };
  return {
    db,
    service: new BrandAssetService(db as never, new BrandAssetAttachmentClient()),
    set: (value: typeof record) => {
      asset = value;
    },
  };
}
let fetchMock: jest.SpiedFunction<typeof fetch>;
const originalBase = process.env.API_BASE_URL;
beforeEach(() => {
  process.env.API_BASE_URL = 'https://core.example.test';
  fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify([source()])));
});
afterEach(() => {
  fetchMock.mockRestore();
  if (originalBase === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = originalBase;
});

it('registers only verified Core metadata and exact attachment identity', async () => {
  const f = fixture();
  const asset = await f.service.register(tenant, 'member', id, 'Bearer test-token');
  expect(asset).toMatchObject({
    attachmentId: id,
    available: true,
    objectKey: key,
    filename: 'logo.png',
    sizeBytes: 12,
    scanDisclosure: null,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    'https://core.example.test/api/engagement/attachments?unlinked=true',
    expect.objectContaining({
      headers: { authorization: 'Bearer test-token', accept: 'application/json' },
      redirect: 'error',
    }),
  );
  expect(f.db.$executeRaw).toHaveBeenCalledTimes(1);
});
it('reuses the exact registration after rechecking current Core readiness', async () => {
  const f = fixture();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify([source()])));
  await f.service.register(tenant, 'member', id, 'Bearer test-token');
  await f.service.register(tenant, 'member', id, 'Bearer test-token');
  expect(f.db.wsBrandAsset.create).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it.each([
  { tenantId: 'different' },
  { clientId: 'private-client' },
  { prospectId: 'private-prospect' },
  { viewerMode: 'restricted' },
  { usable: false },
  { calculatedSha256: null },
  { downloadUrl: null },
  { downloadUrl: 'javascript:alert(1)' },
  { byteSize: -1 },
  { contentType: 'image/svg+xml' },
  { s3Key: 'tenants/foreign/engagement/image.png' },
])('refuses unbound or unavailable source %j', async (change) => {
  const f = fixture();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([source(change)])));
  await expect(
    f.service.register(tenant, 'member', id, 'Bearer test-token'),
  ).rejects.toBeInstanceOf(NotFoundException);
  expect(f.db.wsBrandAsset.create).not.toHaveBeenCalled();
});
it('preserves canonical disclosure when Core permits an unscanned confirmed image', async () => {
  const f = fixture();
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify([source({ lifecycleStatus: 'quarantined', scanDisclosure: 'Not scanned' })]),
    ),
  );
  expect(await f.service.register(tenant, 'member', id, 'Bearer test-token')).toMatchObject({
    available: true,
    scanDisclosure: 'Not scanned',
  });
});
it('refreshes read URLs and never returns a stored expired URL when access is gone', async () => {
  const f = fixture();
  f.set(record);
  expect(await f.service.list(tenant, 'Bearer test-token')).toMatchObject([
    { available: true, url: source().downloadUrl },
  ]);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([])));
  expect(await f.service.list(tenant, 'Bearer test-token')).toMatchObject([
    { available: false, url: null },
  ]);
});
it('fails closed when Core or its configuration is unavailable', async () => {
  const f = fixture();
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await expect(
    f.service.register(tenant, 'member', id, 'Bearer test-token'),
  ).rejects.toBeInstanceOf(ServiceUnavailableException);
  delete process.env.API_BASE_URL;
  await expect(
    f.service.register(tenant, 'member', id, 'Bearer test-token'),
  ).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(f.db.wsBrandAsset.create).not.toHaveBeenCalled();
});
it('does not accept a caller-supplied URL/object metadata in the registration DTO', async () => {
  const dto = Object.assign(new RegisterBrandAssetDto(), {
    attachmentId: id,
    url: 'https://evil.example',
    objectKey: 'foreign',
  });
  expect(
    (await validate(dto, { whitelist: true, forbidNonWhitelisted: true }))
      .map((x) => x.property)
      .sort(),
  ).toEqual(['objectKey', 'url']);
});
it.each(['theme', 'blueprint', 'draft', 'history', 'rotated-url'])(
  'preserves a %s reference',
  async (kind) => {
    const f = fixture();
    f.set(record);
    if (kind === 'theme')
      f.db.wsThemeVersion.findMany.mockResolvedValueOnce([
        { settings: { letterhead: { assetId: record.id } } },
      ]);
    if (kind === 'blueprint')
      f.db.wsBlueprintVersion.findMany.mockResolvedValueOnce([
        { definition: { defaultTheme: { settings: { objectKey: key } } } },
      ]);
    if (kind === 'draft')
      f.db.wsDraft.findMany.mockResolvedValueOnce([{ config: { logo: record.url } }]);
    if (kind === 'history')
      f.db.wsDocVersion.findMany.mockResolvedValueOnce([
        { snapshot: { config: { assetId: record.id } } },
      ]);
    if (kind === 'rotated-url')
      f.db.wsThemeVersion.findMany.mockResolvedValueOnce([
        {
          settings: { html: '<img src="https://assets.example.test/expired?fresh-signature=yes">' },
        },
      ]);
    await expect(f.service.remove(tenant, record.id)).rejects.toBeInstanceOf(ConflictException);
    expect(f.db.wsBrandAsset.delete).not.toHaveBeenCalled();
  },
);
it('removes only the tenant library entry, never sends a provider delete', async () => {
  const f = fixture();
  f.set(record);
  expect(await f.service.remove(tenant, record.id)).toEqual({ deleted: true, assetId: record.id });
  expect(f.db.wsBrandAsset.delete).toHaveBeenCalledWith({
    where: { id: record.id, tenantId: tenant },
  });
  expect(fetchMock).not.toHaveBeenCalled();
});
it('does not delete a foreign tenant asset', async () => {
  const f = fixture();
  f.set(record);
  await expect(f.service.remove('foreign', record.id)).rejects.toBeInstanceOf(NotFoundException);
  expect(f.db.wsBrandAsset.delete).not.toHaveBeenCalled();
});
