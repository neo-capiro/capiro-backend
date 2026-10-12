import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NewsletterService } from './newsletter.service.js';

const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', clerkUserId: 'owner' };
const folderId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const scope = { tenantId: ctx.tenantId, ownerId: ctx.clerkUserId };
function fixture() {
  const folder = {
    findMany: jest.fn().mockResolvedValue([{ id: folderId, name: 'Policy images' }]),
    findFirst: jest.fn().mockResolvedValue({ id: folderId }),
    create: jest.fn().mockResolvedValue({ id: folderId, name: 'Policy images' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const asset = {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn(async ({ data }) => ({ id: assetId, ...data })),
  };
  const queryRaw = jest.fn().mockResolvedValue([{ id: folderId }]);
  const tx = { wsNewsletterAssetFolder: folder, wsNewsletterAsset: asset, $queryRaw: queryRaw };
  const prisma = {
    ...tx,
    $transaction: async <T>(operation: (tx: unknown) => Promise<T>) => operation(tx),
  };
  const importer = {
    download: jest.fn().mockResolvedValue({
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      originalname: 'Brief.png',
    }),
  };
  const service = new NewsletterService(
    prisma as never,
    {} as never,
    {} as never,
    { get: () => 'https://app.capiro.ai' } as never,
    undefined,
    undefined,
    undefined,
    importer as never,
  );
  return { service, folder, asset, queryRaw, importer };
}
describe('image-library folders', () => {
  it('lists scoped folder metadata and filters image rows and totals by an owned folder or Unfiled', async () => {
    const f = fixture();
    expect((await f.service.assetFolders(ctx)).items).toEqual([
      { id: folderId, name: 'Policy images' },
    ]);
    expect(f.folder.findMany).toHaveBeenCalledWith({
      where: scope,
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    await f.service.assets(ctx, { folder: folderId });
    expect(f.folder.findFirst).toHaveBeenCalledWith({
      where: { id: folderId, ...scope },
      select: { id: true },
    });
    expect(f.asset.count).toHaveBeenLastCalledWith({
      where: {
        ...scope,
        mimeType: { startsWith: 'image/' },
        deletedAt: null,
        currentRevision: true,
        folderId,
      },
    });
    await f.service.assets(ctx, { folder: 'unfiled' });
    expect(f.asset.count).toHaveBeenLastCalledWith({
      where: {
        ...scope,
        mimeType: { startsWith: 'image/' },
        deletedAt: null,
        currentRevision: true,
        folderId: null,
      },
    });
    f.folder.findFirst.mockResolvedValue(null);
    await expect(f.service.assets(ctx, { folder: folderId })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(f.service.assets(ctx, { folder: 'invalid' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('creates a folder and moves a deduplicated selection in the same transaction', async () => {
    const f = fixture();
    expect(await f.service.createAssetFolder(ctx, ' Policy images ', [assetId, assetId])).toEqual({
      id: folderId,
      name: 'Policy images',
    });
    expect(f.folder.create).toHaveBeenCalledWith({
      data: { ...scope, name: 'Policy images' },
      select: { id: true, name: true },
    });
    expect(f.asset.updateMany).toHaveBeenCalledWith({
      where: {
        ...scope,
        id: { in: [assetId] },
        deletedAt: null,
        mimeType: { startsWith: 'image/' },
      },
      data: { folderId },
    });
    f.asset.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.service.createAssetFolder(ctx, 'Other', [assetId])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    for (const name of ['  ', 'a'.repeat(101)])
      await expect(f.service.createAssetFolder(ctx, name)).rejects.toBeInstanceOf(
        BadRequestException,
      );
  });
  it('locks only an owned destination and rejects missing images or folders without a partial result', async () => {
    const f = fixture();
    expect(await f.service.moveAssets(ctx, [assetId, assetId], folderId)).toEqual({ moved: 1 });
    expect(f.queryRaw.mock.calls[0].slice(1)).toEqual([folderId, ctx.tenantId, ctx.clerkUserId]);
    expect(f.queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    f.queryRaw.mockResolvedValue([]);
    await expect(f.service.moveAssets(ctx, [assetId], folderId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.asset.updateMany).toHaveBeenCalledTimes(1);
    f.asset.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.service.moveAssets(ctx, [assetId], null)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(f.service.moveAssets(ctx, [assetId], 'invalid')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    for (const ids of [[], ['invalid'], Array(101).fill(assetId)])
      await expect(f.service.moveAssets(ctx, ids, null)).rejects.toBeInstanceOf(
        BadRequestException,
      );
  });
  it('renames and deletes a scoped folder without changing or deleting its asset bytes', async () => {
    const f = fixture();
    expect(await f.service.renameAssetFolder(ctx, folderId, ' Briefings ')).toEqual({
      id: folderId,
      name: 'Briefings',
    });
    expect(f.folder.updateMany).toHaveBeenCalledWith({
      where: { id: folderId, ...scope },
      data: { name: 'Briefings' },
    });
    expect(await f.service.deleteAssetFolder(ctx, folderId)).toEqual({ deleted: true });
    expect(f.asset.updateMany).toHaveBeenCalledWith({
      where: { ...scope, folderId },
      data: { folderId: null },
    });
    expect(f.folder.deleteMany).toHaveBeenCalledWith({ where: { id: folderId, ...scope } });
    f.queryRaw.mockResolvedValue([]);
    await expect(f.service.deleteAssetFolder(ctx, folderId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('stores an upload or import directly in a locked folder and never creates an image for an unavailable folder', async () => {
    const f = fixture();
    await f.service.importAsset(ctx, 'https://images.example/brief.png', folderId);
    expect(f.asset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ...scope, folderId, mimeType: 'image/png' }),
    });
    f.queryRaw.mockResolvedValue([]);
    await expect(
      f.service.importAsset(ctx, 'https://images.example/brief.png', folderId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.asset.create).toHaveBeenCalledTimes(1);
  });
});
