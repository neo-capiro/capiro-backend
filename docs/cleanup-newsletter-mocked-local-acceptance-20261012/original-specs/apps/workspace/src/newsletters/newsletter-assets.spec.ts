import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NewsletterService } from './newsletter.service.js';

const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', clerkUserId: 'owner' };
function fixture() {
  const asset = {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(312),
    create: jest.fn(),
    findFirst: jest.fn(),
    findFirstOrThrow: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
  };
  const importer = { download: jest.fn() };
  const raw = jest.fn().mockResolvedValue([{ id: '22222222-2222-4222-8222-222222222222' }]);
  const service = new NewsletterService(
    {
      wsNewsletterAsset: asset,
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
        operation({ wsNewsletterAsset: asset, $queryRaw: raw }),
    } as never,
    {} as never,
    {} as never,
    { get: () => 'https://app.capiro.ai' } as never,
    undefined,
    undefined,
    undefined,
    importer as never,
  );
  return { asset, importer, service };
}
describe('stored newsletter assets', () => {
  it('paginates beyond the old 200-image limit while scoping both rows and totals to the owner and tenant', async () => {
    const f = fixture();
    f.asset.findMany.mockResolvedValue([
      { id: 'asset1', name: 'Client update.png', mimeType: 'image/png', token: 'a'.repeat(64) },
    ]);
    const result = await f.service.assets(ctx, {
      page: 11,
      pageSize: 25,
      search: ' client ',
      sort: 'name-asc',
    });
    const where = {
      tenantId: ctx.tenantId,
      ownerId: ctx.clerkUserId,
      mimeType: { startsWith: 'image/' },
      deletedAt: null,
      currentRevision: true,
      name: { contains: 'client', mode: 'insensitive' },
    };
    expect(f.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        skip: 250,
        take: 25,
        orderBy: [{ name: 'asc' }, { id: 'desc' }],
      }),
    );
    expect(f.asset.count).toHaveBeenCalledWith({ where });
    expect(result).toMatchObject({
      page: 11,
      pageSize: 25,
      total: 312,
      items: [
        {
          id: 'asset1',
          url: `https://app.capiro.ai/workspace-api/newsletters/assets/file/${'a'.repeat(64)}`,
        },
      ],
    });
    expect(result.items[0]).not.toHaveProperty('token');
  });
  it.each([
    { page: 0 },
    { page: 1.5 },
    { page: 100001 },
    { pageSize: 200 },
    { sort: 'random' },
    { search: 'a'.repeat(201) },
  ])('rejects invalid pagination/filter bounds %j', async (query) => {
    const f = fixture();
    await expect(f.service.assets(ctx, query)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.asset.findMany).not.toHaveBeenCalled();
  });
  it('copies imported image bytes through the existing scoped upload path', async () => {
    const f = fixture();
    const buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    f.importer.download.mockResolvedValue({ buffer, originalname: 'Bill brief.png' });
    f.asset.create.mockImplementation(async ({ data }) => ({ id: 'asset1', ...data }));
    const result = await f.service.importAsset(ctx, ' https://images.example/brief.png ');
    expect(f.importer.download).toHaveBeenCalledWith('https://images.example/brief.png');
    expect(f.asset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: ctx.tenantId,
        ownerId: ctx.clerkUserId,
        mimeType: 'image/png',
        file: buffer,
      }),
    });
    expect(result.url).toMatch(
      /^https:\/\/app.capiro.ai\/workspace-api\/newsletters\/assets\/file\/[a-f0-9]{64}$/,
    );
    expect(result).not.toHaveProperty('file');
  });
  it('does not persist a failed import or unsupported image, and does not retry the download', async () => {
    const f = fixture();
    f.importer.download.mockRejectedValueOnce(new BadRequestException('Private URL'));
    await expect(f.service.importAsset(ctx, 'https://images.example/brief.png')).rejects.toThrow(
      'Private URL',
    );
    f.importer.download.mockResolvedValueOnce({
      buffer: Buffer.from('<html>oops</html>'),
      originalname: 'oops.png',
    });
    await expect(f.service.importAsset(ctx, 'https://images.example/brief.png')).rejects.toThrow(
      'not a supported image',
    );
    expect(f.asset.create).not.toHaveBeenCalled();
    expect(f.importer.download).toHaveBeenCalledTimes(2);
  });
  it('returns scoped details without exposing stored bytes or separate capability tokens', async () => {
    const f = fixture();
    const id = '22222222-2222-4222-8222-222222222222';
    f.asset.findFirst.mockResolvedValue({
      id,
      name: 'Brief.png',
      token: 'b'.repeat(64),
      mimeType: 'image/png',
      createdAt: new Date('2026-10-07T12:00:00Z'),
      file: Buffer.from([1, 2, 3]),
    });
    const result = await f.service.assetDetails(ctx, id);
    expect(f.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id,
          ...{ tenantId: ctx.tenantId, ownerId: ctx.clerkUserId },
          deletedAt: null,
          mimeType: { startsWith: 'image/' },
        },
      }),
    );
    expect(result).toMatchObject({ id, sizeBytes: 3, createdAt: '2026-10-07T12:00:00.000Z' });
    expect(result).not.toHaveProperty('file');
    expect(result).not.toHaveProperty('token');
    f.asset.findFirst.mockResolvedValue(null);
    await expect(f.service.assetDetails(ctx, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.assetDetails(ctx, 'invalid')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('renames only active scoped images without modifying bytes or URLs', async () => {
    const f = fixture();
    const id = '22222222-2222-4222-8222-222222222222';
    f.asset.updateMany.mockResolvedValue({ count: 1 });
    f.asset.findFirstOrThrow.mockResolvedValue({
      id,
      name: 'Client brief.png',
      token: 'b'.repeat(64),
      mimeType: 'image/png',
    });
    const result = await f.service.renameAsset(ctx, id, ' Client brief.png ');
    expect(f.asset.updateMany).toHaveBeenCalledWith({
      where: {
        id,
        tenantId: ctx.tenantId,
        ownerId: ctx.clerkUserId,
        deletedAt: null,
        currentRevision: true,
        mimeType: { startsWith: 'image/' },
      },
      data: { name: 'Client brief.png' },
    });
    expect(result.url).toContain('b'.repeat(64));
    f.asset.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.service.renameAsset(ctx, id, 'Another.png')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(f.service.renameAsset(ctx, id, '  ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.service.renameAsset(ctx, id, 'a'.repeat(201))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('soft-deletes a bounded deduplicated selection, fails mixed batches and keeps public reads immutable', async () => {
    const f = fixture();
    const id = '22222222-2222-4222-8222-222222222222';
    f.asset.updateMany.mockResolvedValue({ count: 1 });
    f.asset.findMany.mockResolvedValue([{ id, revisionRootId: null }]);
    f.asset.count.mockResolvedValue(1);
    expect(await f.service.deleteAssets(ctx, [id, id])).toEqual({ deleted: 1 });
    expect(f.asset.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: ctx.tenantId,
        ownerId: ctx.clerkUserId,
        deletedAt: null,
        OR: [{ id: { in: [id] } }, { revisionRootId: { in: [id] } }],
      },
      data: { deletedAt: expect.any(Date) },
    });
    f.asset.findMany.mockResolvedValue([]);
    await expect(f.service.deleteAssets(ctx, [id])).rejects.toBeInstanceOf(NotFoundException);
    for (const ids of [[], ['bad'], Array(101).fill(id)])
      await expect(f.service.deleteAssets(ctx, ids)).rejects.toBeInstanceOf(BadRequestException);
    f.asset.findUnique.mockResolvedValue({ file: Buffer.from([1]), mimeType: 'image/png' });
    expect((await f.service.publicAsset('b'.repeat(64))).file).toEqual(Buffer.from([1]));
    expect(f.asset.findUnique).toHaveBeenCalledWith({
      where: { token: 'b'.repeat(64) },
      select: { file: true, mimeType: true },
    });
  });
});
