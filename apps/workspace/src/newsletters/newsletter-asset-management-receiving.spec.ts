import {
  parseNewsletterAssetFolder,
  parseNewsletterAssetFolders,
  parseNewsletterAssetFolderRename,
  parseNewsletterAssetFolderDeletion,
  parseNewsletterAssetRename,
  parseNewsletterAssetRevisionPage,
  parseNewsletterAssetsMoved,
  parseNewsletterAssetsDeleted,
  parseNewsletterAssetItem,
  type NewsletterReceiveResult,
} from '@capiro/shared/newsletter';
import { NewsletterService } from './newsletter.service.js';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const time = '2026-10-26T09:00:00.000Z';
const ctx = { tenantId: id(1), clerkUserId: 'user_synthetic_asset_management' };
const folderId = id(2),
  assetId = id(3),
  token = 'a'.repeat(64);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const scope = { tenantId: ctx.tenantId, ownerId: ctx.clerkUserId };
const folder = () => ({ id: folderId, name: 'Policy images' });
const item = () => ({
  id: assetId,
  name: '',
  mimeType: 'image/png',
  url: `https://assets.example.test/workspace-api/newsletters/assets/file/${token}`,
});
const detail = () => ({
  ...item(),
  createdAt: time,
  sizeBytes: 8,
  revisionNumber: 2,
  currentRevision: false,
});
const page = () => ({ page: 2, pageSize: 10, total: 0, items: [detail()] });
function accepted<T>(result: NewsletterReceiveResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function fixture() {
  const folders = {
    findMany: jest.fn().mockResolvedValue([folder()]),
    create: jest.fn(async ({ data }) => ({ id: folderId, name: data.name })),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const assets = {
    findFirst: jest.fn().mockResolvedValue({ id: assetId, revisionRootId: id(4) }),
    findFirstOrThrow: jest.fn().mockResolvedValue({ ...item(), name: 'Renamed.png', token }),
    findMany: jest.fn().mockResolvedValue([{ id: assetId, revisionRootId: id(4) }]),
    count: jest.fn().mockResolvedValue(1),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn(async ({ data }) => ({ ...data, id: assetId })),
    findUnique: jest.fn().mockResolvedValue({ file: png, mimeType: 'image/png' }),
  };
  const raw = jest.fn(async (query: TemplateStringsArray) =>
    query.join('').includes('octet_length')
      ? [{ ...detail(), token, createdAt: new Date(time) }].map(({ url: _url, ...rest }) => rest)
      : [{ id: folderId }],
  );
  const tx = { wsNewsletterAssetFolder: folders, wsNewsletterAsset: assets, $queryRaw: raw };
  const prisma = { ...tx, $transaction: async (run: (value: unknown) => unknown) => run(tx) };
  const importer = {
    download: jest.fn().mockResolvedValue({ buffer: png, originalname: 'Imported.png' }),
  };
  const service = new NewsletterService(
    prisma as never,
    {} as never,
    {} as never,
    { get: () => 'https://assets.example.test' } as never,
    undefined,
    undefined,
    undefined,
    importer as never,
  );
  return { service, folders, assets, raw, importer };
}

it('receives real folder list/create/rename/delete shapes and preserves unfiling semantics', async () => {
  const f = fixture();
  expect(accepted(parseNewsletterAssetFolders(await f.service.assetFolders(ctx)))).toEqual({
    items: [folder()],
  });
  expect(f.folders.findMany).toHaveBeenCalledWith({
    where: scope,
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  expect(
    accepted(
      parseNewsletterAssetFolder(
        await f.service.createAssetFolder(ctx, ' Policy images ', [assetId, assetId]),
      ),
    ),
  ).toEqual(folder());
  expect(f.assets.updateMany).toHaveBeenCalledWith({
    where: { ...scope, id: { in: [assetId] }, deletedAt: null, mimeType: { startsWith: 'image/' } },
    data: { folderId },
  });
  const renamed = await f.service.renameAssetFolder(ctx, folderId, ' Briefings ');
  expect(accepted(parseNewsletterAssetFolderRename(renamed, { folderId }))).toEqual({
    id: folderId,
    name: 'Briefings',
  });
  expect(
    accepted(parseNewsletterAssetFolderDeletion(await f.service.deleteAssetFolder(ctx, folderId))),
  ).toEqual({ deleted: true });
  expect(f.assets.updateMany).toHaveBeenLastCalledWith({
    where: { ...scope, folderId },
    data: { folderId: null },
  });
  expect(f.folders.deleteMany).toHaveBeenCalledWith({ where: { id: folderId, ...scope } });
  expect(f.raw.mock.calls[0]!.slice(1)).toEqual([folderId, ctx.tenantId, ctx.clerkUserId]);
});

it('receives actual revision metadata and rename items without inventing a root echo', async () => {
  const f = fixture();
  f.assets.count.mockResolvedValueOnce(0);
  const result = await f.service.assetRevisions(ctx, id(5), { page: 2, pageSize: 10 });
  expect(accepted(parseNewsletterAssetRevisionPage(result))).toEqual(page());
  expect(result).not.toHaveProperty('assetId');
  expect(result.items[0]).not.toHaveProperty('revisionRootId');
  expect(f.assets.findFirst).toHaveBeenCalledWith({
    where: { id: id(5), ...scope, deletedAt: null, mimeType: { startsWith: 'image/' } },
    select: { id: true, revisionRootId: true },
  });
  expect(f.raw.mock.calls[0]!.slice(1)).toEqual([
    ctx.tenantId,
    ctx.clerkUserId,
    id(4),
    id(4),
    10,
    10,
  ]);
  const renamed = await f.service.renameAsset(ctx, assetId, ' Renamed.png ');
  expect(accepted(parseNewsletterAssetRename(renamed, { assetId }))).toEqual({
    ...item(),
    name: 'Renamed.png',
  });
  expect(f.assets.updateMany).toHaveBeenCalledWith({
    where: {
      id: assetId,
      ...scope,
      deletedAt: null,
      currentRevision: true,
      mimeType: { startsWith: 'image/' },
    },
    data: { name: 'Renamed.png' },
  });
});

it('receives distinct-selection counts and imported items without claiming token revocation', async () => {
  const f = fixture();
  expect(
    accepted(parseNewsletterAssetsMoved(await f.service.moveAssets(ctx, [assetId, assetId], null))),
  ).toEqual({ moved: 1 });
  expect(
    accepted(parseNewsletterAssetsDeleted(await f.service.deleteAssets(ctx, [assetId, assetId]))),
  ).toEqual({ deleted: 1 });
  expect(f.assets.updateMany).toHaveBeenLastCalledWith({
    where: {
      ...scope,
      deletedAt: null,
      OR: [{ id: { in: [id(4)] } }, { revisionRootId: { in: [id(4)] } }],
    },
    data: { deletedAt: expect.any(Date) },
  });
  expect(await f.service.publicAsset(token)).toEqual({ file: png, mimeType: 'image/png' });
  expect(f.assets.findUnique).toHaveBeenCalledWith({
    where: { token },
    select: { file: true, mimeType: true },
  });
  const imported = await f.service.importAsset(
    ctx,
    'https://images.example.test/source.png',
    folderId,
  );
  expect(accepted(parseNewsletterAssetItem(imported))).toEqual(imported);
  expect(imported).not.toHaveProperty('folderId');
  expect(imported).not.toHaveProperty('sourceUrl');
  expect(f.importer.download).toHaveBeenCalledTimes(1); // Local fake only; no network/provider.
  expect(f.assets.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ ...scope, folderId }),
  });
});

it('binds echoed rename identities to the captured resource, including UUID case', () => {
  expect(
    accepted(parseNewsletterAssetFolderRename(folder(), { folderId: folderId.toUpperCase() })),
  ).toEqual(folder());
  expect(accepted(parseNewsletterAssetRename(item(), { assetId: assetId.toUpperCase() }))).toEqual(
    item(),
  );
  for (const result of [
    parseNewsletterAssetFolderRename(folder(), { folderId: id(8) }),
    parseNewsletterAssetRename(item(), { assetId: id(8) }),
  ])
    expect(result).toEqual({ ok: false, error: { code: 'identity_mismatch', path: '$.id' } });
  for (const bad of [undefined, {}, { folderId: token }, { folderId, requestId: id(7) }])
    expect(parseNewsletterAssetFolderRename(folder(), bad as never).ok).toBe(false);
  for (const bad of [undefined, {}, { assetId: token }, { assetId, folderId }])
    expect(parseNewsletterAssetRename(item(), bad as never).ok).toBe(false);
});

it('retains truthful empty names, current flags and non-atomic page totals', () => {
  expect(accepted(parseNewsletterAssetRevisionPage(page()))).toEqual(page());
  for (const pageSize of [10, 25, 50, 100])
    expect(
      accepted(parseNewsletterAssetRevisionPage({ page: 100_000, pageSize, total: 0, items: [] })),
    ).toEqual({ page: 100_000, pageSize, total: 0, items: [] });
  const many = {
    items: Array.from({ length: 501 }, (_, n) => ({ id: id(n + 10), name: 'Folder' })),
  };
  expect(accepted(parseNewsletterAssetFolders(many))).toEqual(many); // No invented take-500 service cap.
  const version8 = { ...folder(), id: folderId.replace('-4aaa-', '-8aaa-') };
  expect(accepted(parseNewsletterAssetFolder(version8))).toEqual(version8);
});

it('enforces actual folder names and revision paging/metadata bounds', () => {
  for (const bad of ['', ' ', 'a'.repeat(101), null, 5])
    expect(parseNewsletterAssetFolder({ ...folder(), name: bad }).ok).toBe(false);
  for (const patch of [
    { page: 0 },
    { page: 100_001 },
    { page: 1.1 },
    { pageSize: 20 },
    { total: -1 },
    { total: 0.5 },
    { items: Array(11).fill(detail()) },
    { items: null },
  ])
    expect(parseNewsletterAssetRevisionPage({ ...page(), ...patch }).ok).toBe(false);
  for (const patch of [
    { createdAt: '2026-10-26' },
    { sizeBytes: 0 },
    { sizeBytes: 10 * 1024 * 1024 + 1 },
    { revisionNumber: 0 },
    { revisionNumber: 1.5 },
    { currentRevision: 'false' },
    { mimeType: 'image/svg+xml' },
    { url: 'javascript:alert(1)' },
    { revisionRootId: id(7) },
    { dimensions: { width: 10 } },
  ])
    expect(
      parseNewsletterAssetRevisionPage({ ...page(), items: [{ ...detail(), ...patch }] }).ok,
    ).toBe(false);
  expect(
    parseNewsletterAssetRevisionPage({ ...page(), items: [{ ...detail(), sizeBytes: 0 }] }),
  ).toEqual({
    ok: false,
    error: { code: 'invalid_shape', path: '$.items.0.sizeBytes' },
  });
});

it('refuses false success, count coercion, invented identities and recovery guarantees', () => {
  for (const value of [
    { ok: true },
    { deleted: false },
    { deleted: 1 },
    { deleted: true, folderId },
    { deleted: true, publicUrlsRevoked: true },
  ])
    expect(parseNewsletterAssetFolderDeletion(value).ok).toBe(false);
  for (const count of [0, -1, 101, 1.5, '1', true, null]) {
    expect(parseNewsletterAssetsMoved({ moved: count }).ok).toBe(false);
    expect(parseNewsletterAssetsDeleted({ deleted: count }).ok).toBe(false);
  }
  for (const count of [1, 100]) {
    expect(accepted(parseNewsletterAssetsMoved({ moved: count }))).toEqual({ moved: count });
    expect(accepted(parseNewsletterAssetsDeleted({ deleted: count }))).toEqual({ deleted: count });
  }
  expect(parseNewsletterAssetsMoved({ moved: 1, folderId }).ok).toBe(false);
  expect(parseNewsletterAssetsDeleted({ deleted: 1, ids: [assetId] }).ok).toBe(false);
  expect(parseNewsletterAssetFolders({ items: [folder()], complete: true }).ok).toBe(false);
  expect(parseNewsletterAssetFolder({ ...folder(), moved: 1 }).ok).toBe(false);
  expect(parseNewsletterAssetRename({ ...item(), requestId: id(7) }, { assetId }).ok).toBe(false);
  expect(parseNewsletterAssetRevisionPage({ ...page(), assetId }).ok).toBe(false);
  expect(
    parseNewsletterAssetItem({ ...item(), sourceUrl: 'https://images.example.test/source.png' }).ok,
  ).toBe(false);
});

const readers = [
  parseNewsletterAssetFolder,
  parseNewsletterAssetFolders,
  parseNewsletterAssetFolderDeletion,
  parseNewsletterAssetRevisionPage,
  parseNewsletterAssetsMoved,
  parseNewsletterAssetsDeleted,
  (value: unknown) => parseNewsletterAssetFolderRename(value, { folderId }),
  (value: unknown) => parseNewsletterAssetRename(value, { assetId }),
];
it('rejects hostile snapshots without invoking accessors or trusting thrown errors', () => {
  const getter = jest.fn(() => true);
  const accessor = Object.defineProperty({}, 'deleted', { get: getter, enumerable: true });
  const hidden = Object.defineProperty({ deleted: true }, 'hidden', { value: 1 });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const forged = new Proxy(
    {},
    {
      ownKeys() {
        throw { code: 'identity_mismatch', path: '$.forged' };
      },
    },
  );
  for (const bad of [
    undefined,
    Symbol('bad'),
    () => {},
    new Date(),
    NaN,
    accessor,
    hidden,
    cyclic,
    revoked.proxy,
    forged,
    { deleted: true, [Symbol('hidden')]: 1 },
    { items: Array(2) },
  ])
    for (const read of readers) expect(read(bad).ok).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  expect(parseNewsletterAssetsDeleted(forged)).toEqual({
    ok: false,
    error: { code: 'invalid_json', path: '$' },
  });
  const expected = Object.defineProperty({}, 'assetId', { get: getter, enumerable: true });
  expect(parseNewsletterAssetRename(item(), expected as never).ok).toBe(false);
  expect(getter).not.toHaveBeenCalled();
});

it('returns detached JSON and leaves capability URLs inert', () => {
  const original = page();
  const result = accepted(parseNewsletterAssetRevisionPage(original));
  result.items[0]!.name = 'Changed';
  expect(original.items[0]!.name).toBe('');
  expect(result.items).not.toBe(original.items);
  const folders = { items: [folder()] };
  accepted(parseNewsletterAssetFolders(folders)).items[0]!.name = 'Changed';
  expect(folders.items[0]!.name).toBe('Policy images');
  const local = {
    ...item(),
    url: `http://127.0.0.1:8080/base/workspace-api/newsletters/assets/file/${token}`,
  };
  // Existing URL syntax policy, not origin trust, DNS lookup, fetch or an import request.
  expect(accepted(parseNewsletterAssetRename(local, { assetId }))).toEqual(local);
});
