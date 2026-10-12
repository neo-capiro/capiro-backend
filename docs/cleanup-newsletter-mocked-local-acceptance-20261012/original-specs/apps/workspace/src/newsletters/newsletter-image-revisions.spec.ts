import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { NewsletterService } from './newsletter.service.js';

const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', clerkUserId: 'owner' };
const root = '22222222-2222-4222-8222-222222222222';
const parent = '33333333-3333-4333-8333-333333333333';
const token = 'a'.repeat(64);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const file = { buffer: png, originalname: 'Edited.png' };
const scope = { tenantId: ctx.tenantId, ownerId: ctx.clerkUserId };
function fixture() {
  const asset = {
    findFirst: jest.fn(async ({ where }) =>
      where.token ? { id: parent, revisionRootId: root } : { folderId: null },
    ),
    create: jest.fn(async ({ data }) => ({ id: root, ...data })),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    aggregate: jest.fn().mockResolvedValue({ _max: { revisionNumber: 3 } }),
    count: jest.fn().mockResolvedValue(3),
  };
  const raw = jest.fn().mockResolvedValue([{ id: root }]);
  const imageEditor = { refine: jest.fn().mockResolvedValue([png]) };
  const tx = { wsNewsletterAsset: asset, $queryRaw: raw };
  const prisma = {
    ...tx,
    wsNewsletterDocument: {
      findFirst: jest.fn().mockResolvedValue({ config: {}, design: { sections: [] } }),
    },
    $transaction: async (fn: (value: unknown) => Promise<unknown>) => fn(tx),
  };
  const service = new NewsletterService(
    prisma as never,
    {} as never,
    {} as never,
    { get: () => 'https://app.capiro.ai' } as never,
    undefined,
    imageEditor as never,
  );
  return { service, asset, raw, imageEditor };
}
describe('immutable newsletter image revisions', () => {
  it('keeps the selected parent when branching from an earlier version and serializes version allocation on the scoped root', async () => {
    const f = fixture();
    await f.service.saveImageRevision(ctx, file, token);
    expect(f.raw.mock.calls[0].slice(1)).toEqual([root, ctx.tenantId, ctx.clerkUserId]);
    expect(f.raw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    expect(f.asset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ...scope,
        revisionRootId: root,
        revisionParentId: parent,
        revisionNumber: 4,
        currentRevision: true,
        file: png,
      }),
    });
    expect(f.asset.updateMany).toHaveBeenCalledWith({
      where: { ...scope, OR: [{ id: root }, { revisionRootId: root }], currentRevision: true },
      data: { currentRevision: false },
    });
    expect(f.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ...scope,
          token,
          deletedAt: null,
          mimeType: { startsWith: 'image/' },
        },
      }),
    );
  });
  it('retains a browser-provided original for a previously unstored image and requires valid bytes for both images', async () => {
    const f = fixture();
    await f.service.saveImageRevision(ctx, file, undefined, {
      ...file,
      originalname: 'Original.png',
    });
    expect(f.asset.create.mock.calls[0]![0].data).toMatchObject({
      name: 'Original.png',
      file: png,
      currentRevision: false,
    });
    expect(f.asset.create.mock.calls[1]![0].data).toMatchObject({
      revisionRootId: root,
      revisionParentId: root,
    });
    expect(f.raw).not.toHaveBeenCalled();
    f.asset.create.mockClear();
    await expect(f.service.saveImageRevision(ctx, file)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      f.service.saveImageRevision(ctx, { ...file, buffer: Buffer.from('<html>') }, undefined, file),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.asset.create).not.toHaveBeenCalled();
  });
  it('rejects missing, deleted, foreign or non-image sources before persistence or a paid request', async () => {
    const f = fixture();
    f.asset.findFirst.mockResolvedValue(null as never);
    await expect(f.service.saveImageRevision(ctx, file, token)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      f.service.refineImage(ctx, root, file, { prompt: 'Edit', sourceToken: token }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.saveImageRevision(ctx, file, 'bad')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(f.asset.create).not.toHaveBeenCalled();
    expect(f.imageEditor.refine).not.toHaveBeenCalled();
  });
  it('does not save an edit when the image moves folders while its root lock is pending', async () => {
    const f = fixture();
    f.asset.findFirst
      .mockResolvedValueOnce({ id: parent, revisionRootId: root } as never)
      .mockResolvedValueOnce({ folderId: null } as never)
      .mockResolvedValueOnce({ id: parent, revisionRootId: root } as never)
      .mockResolvedValueOnce({ folderId: root } as never);
    await expect(f.service.saveImageRevision(ctx, file, token)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(f.asset.create).not.toHaveBeenCalled();
  });
  it('returns paginated private metadata without loading file bytes or exposing separate tokens', async () => {
    const f = fixture();
    f.asset.findFirst.mockResolvedValue({ id: parent, revisionRootId: root } as never);
    f.raw.mockResolvedValue([
      {
        id: root,
        name: 'Original.png',
        token,
        mimeType: 'image/png',
        createdAt: new Date('2026-10-07T12:00:00Z'),
        sizeBytes: 9,
        revisionNumber: 1,
        currentRevision: false,
      },
    ]);
    const result = await f.service.assetRevisions(ctx, parent, { page: 2, pageSize: 10 });
    expect(result).toMatchObject({
      page: 2,
      pageSize: 10,
      total: 3,
      items: [{ revisionNumber: 1, sizeBytes: 9 }],
    });
    expect(result.items[0]).not.toHaveProperty('token');
    expect(result.items[0]).not.toHaveProperty('file');
    expect(f.raw.mock.calls[0].slice(1)).toEqual([
      ctx.tenantId,
      ctx.clerkUserId,
      root,
      root,
      10,
      10,
    ]);
    expect(f.raw.mock.calls[0][0].join('')).toContain('octet_length(file)');
    for (const query of [{ page: 0 }, { pageSize: 200 }, { page: 1.5 }])
      await expect(f.service.assetRevisions(ctx, parent, query)).rejects.toBeInstanceOf(
        BadRequestException,
      );
  });
});
