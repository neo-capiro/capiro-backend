import {
  parseNewsletterAssetItem,
  parseNewsletterAssetList,
  parseNewsletterAssetDetails,
  type NewsletterAssetItem,
  type NewsletterAssetDetails,
  type NewsletterReceiveResult,
} from '@capiro/shared/newsletter';
import { NewsletterService } from './newsletter.service.js';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const time = '2026-10-26T09:00:00.000Z';
const ctx = { tenantId: id(1), clerkUserId: 'user_synthetic_assets' };
const token = 'a'.repeat(64);
const url = `https://assets.example.test/workspace-api/newsletters/assets/file/${token}`;
const item = (): NewsletterAssetItem => ({
  id: id(2),
  name: 'Saved image',
  mimeType: 'image/png',
  url,
});
const details = (): NewsletterAssetDetails => ({
  ...item(),
  createdAt: time,
  sizeBytes: 8,
  revisionNumber: 1,
  currentRevision: false,
});
const list = () => ({ page: 1, pageSize: 25, total: 1, items: [item()] });
function accepted<T>(result: NewsletterReceiveResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const readDetails = (value: unknown) => parseNewsletterAssetDetails(value, { assetId: id(2) });

it.each([
  ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
  ['image/jpeg', Buffer.from([255, 216, 255])],
  ['image/gif', Buffer.from('GIF89a')],
  ['image/webp', Buffer.from('RIFF0000WEBP')],
])(
  'receives unchanged upload, paged list and detail producer output for %s',
  async (mime, buffer) => {
    let stored: Record<string, unknown>;
    const assets = {
      create: jest.fn(
        async ({ data }) =>
          (stored = {
            ...data,
            id: id(2),
            createdAt: new Date(time),
            revisionNumber: 1,
            currentRevision: false,
          }),
      ),
      findMany: jest.fn(async () => [
        { id: stored.id, name: stored.name, token: stored.token, mimeType: stored.mimeType },
      ]),
      count: jest.fn(async () => 312),
      findFirst: jest.fn(async () => stored),
    };
    const service = new NewsletterService(
      { wsNewsletterAsset: assets } as never,
      {} as never,
      {} as never,
      { get: () => 'http://images.example.test:8080/base/' } as never,
    );
    // A sanitizable filename can legitimately become empty; the receiver must not invent one.
    const uploaded = await service.upload(ctx, { buffer, originalname: '<>\r\n' });
    expect(accepted(parseNewsletterAssetItem(uploaded))).toEqual(uploaded);
    expect(uploaded.name).toBe('');
    expect(uploaded.mimeType).toBe(mime);
    expect(uploaded.url).toMatch(
      /^http:\/\/images\.example\.test:8080\/base\/workspace-api\/newsletters\/assets\/file\/[a-f0-9]{64}$/,
    );
    const page = accepted(
      parseNewsletterAssetList(await service.assets(ctx, { page: 11, pageSize: 25 })),
    );
    expect(page).toEqual({ page: 11, pageSize: 25, total: 312, items: [uploaded] });
    expect(assets.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: ctx.tenantId,
          ownerId: ctx.clerkUserId,
          mimeType: { startsWith: 'image/' },
          deletedAt: null,
          currentRevision: true,
        },
        skip: 250,
        take: 25,
      }),
    );
    const detail = await service.assetDetails(ctx, uploaded.id);
    expect(accepted(parseNewsletterAssetDetails(detail, { assetId: uploaded.id }))).toEqual(detail);
    expect(detail).toMatchObject({
      sizeBytes: buffer.length,
      currentRevision: false,
      revisionNumber: 1,
    });
    expect(assets.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: uploaded.id,
          tenantId: ctx.tenantId,
          ownerId: ctx.clerkUserId,
          deletedAt: null,
          mimeType: { startsWith: 'image/' },
        },
      }),
    );
    expect(detail).not.toHaveProperty('file');
    expect(detail).not.toHaveProperty('token');
  },
);

it('requires the requested asset UUID even when another item has the same public URL', () => {
  expect(parseNewsletterAssetDetails(details(), { assetId: id(3) })).toEqual({
    ok: false,
    error: { code: 'identity_mismatch', path: '$.id' },
  });
  expect(
    accepted(parseNewsletterAssetDetails(details(), { assetId: id(2).toUpperCase() })),
  ).toEqual(details());
  // @ts-expect-error Detail receiving always requires the requested UUID.
  expect(parseNewsletterAssetDetails(details()).ok).toBe(false);
  for (const expected of [
    null,
    {},
    { assetId: null },
    { assetId: token },
    { assetId: url },
    { id: id(2) },
    { assetId: id(2), ownerId: 'invented' },
  ])
    expect(parseNewsletterAssetDetails(details(), expected as never).ok).toBe(false);
});

it('uses the existing Workspace UUID profile without confusing a capability token with an asset ID', () => {
  for (const version of ['1', '4', '8']) {
    const assetId = id(2).slice(0, 14) + version + id(2).slice(15);
    expect(
      accepted(parseNewsletterAssetDetails({ ...details(), id: assetId }, { assetId })).id,
    ).toBe(assetId);
  }
  for (const invalid of [
    token,
    url,
    '',
    '00000000-0000-0000-0000-000000000000',
    id(2).replace('-4aaa-', '-9aaa-'),
  ])
    expect(parseNewsletterAssetItem({ ...item(), id: invalid }).ok).toBe(false);
});

it('preserves page metadata and does not infer a complete or atomic collection', () => {
  for (const pageSize of [10, 25, 50, 100]) {
    const page = { page: 100_000, pageSize, total: Number.MAX_SAFE_INTEGER, items: [] };
    expect(accepted(parseNewsletterAssetList(page))).toEqual(page);
  }
  // findMany and count are separate reads: a concurrent deletion can yield a lower count.
  expect(accepted(parseNewsletterAssetList({ ...list(), total: 0 }))).toEqual({
    ...list(),
    total: 0,
  });
  const page = {
    ...list(),
    pageSize: 10,
    items: Array.from({ length: 10 }, (_, n) => ({ ...item(), id: id(n + 10) })),
  };
  expect(accepted(parseNewsletterAssetList(page))).toEqual(page);
  expect(parseNewsletterAssetList({ ...page, items: [...page.items, item()] })).toEqual({
    ok: false,
    error: { code: 'limit_exceeded', path: '$.items' },
  });
});

it('refuses malformed pagination and item collections at the actual endpoint limits', () => {
  for (const page of [0, -1, 1.5, 100_001, '1', null])
    expect(parseNewsletterAssetList({ ...list(), page }).ok).toBe(false);
  for (const pageSize of [0, 1, 26, 101, '25', null])
    expect(parseNewsletterAssetList({ ...list(), pageSize }).ok).toBe(false);
  for (const total of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null])
    expect(parseNewsletterAssetList({ ...list(), total }).ok).toBe(false);
  for (const items of [null, {}, [null], [details()], Array(101).fill(item())])
    expect(parseNewsletterAssetList({ ...list(), pageSize: 100, items }).ok).toBe(false);
});

it('preserves actual name and detail scalars, including empty names and a false revision flag', () => {
  for (const name of ['', '   ', '<inert name>', 'x'.repeat(200)])
    expect(accepted(parseNewsletterAssetItem({ ...item(), name })).name).toBe(name);
  expect(parseNewsletterAssetItem({ ...item(), name: 'x'.repeat(201) }).ok).toBe(false);
  expect(
    accepted(readDetails({ ...details(), sizeBytes: 10 * 1024 * 1024, currentRevision: true }))
      .currentRevision,
  ).toBe(true);
  expect(accepted(readDetails(details())).currentRevision).toBe(false);
  for (const change of [
    { sizeBytes: 0 },
    { sizeBytes: -1 },
    { sizeBytes: 1.5 },
    { sizeBytes: 10 * 1024 * 1024 + 1 },
    { revisionNumber: 0 },
    { revisionNumber: 1.5 },
    { revisionNumber: Number.MAX_SAFE_INTEGER + 1 },
    { createdAt: new Date(time) },
    { createdAt: 'yesterday' },
    { createdAt: '2026-10-26' },
    { currentRevision: 'false' },
  ])
    expect(readDetails({ ...details(), ...change }).ok).toBe(false);
});

it('requires every producer fact and refuses invented nullable or optional fields', () => {
  for (const [value, parse] of [
    [item(), parseNewsletterAssetItem],
    [details(), readDetails],
    [list(), parseNewsletterAssetList],
  ] as const) {
    for (const key of Object.keys(value)) {
      const missing: Record<string, unknown> = { ...value };
      delete missing[key];
      expect(parse(missing).ok).toBe(false);
      expect(parse({ ...value, [key]: null }).ok).toBe(false);
      expect(parse({ ...value, [key]: undefined }).ok).toBe(false);
    }
    expect(parse({ ...value, folderId: null }).ok).toBe(false);
  }
});

it('admits managed HTTP(S) URLs without turning origin syntax into authority', () => {
  for (const base of [
    'https://other.example.test',
    'http://localhost:4000',
    'https://images.example.test:8443/base',
  ]) {
    const candidate = `${base}/workspace-api/newsletters/assets/file/${token}`;
    expect(accepted(parseNewsletterAssetItem({ ...item(), url: candidate })).url).toBe(candidate);
  }
  for (const candidate of [
    '/workspace-api/newsletters/assets/file/' + token,
    'https:/images.example.test/workspace-api/newsletters/assets/file/' + token,
    'https:///images.example.test/workspace-api/newsletters/assets/file/' + token,
    url.replace('https:', 'javascript:'),
    url.replace('https:', 'file:'),
    'data:image/png;base64,AA==',
    url.replace('https://', 'https://user:secret@'),
    url + '?access=1',
    url + '#image',
    url + '/',
    url.replace(token, id(2)),
    url.replace(token, token.toUpperCase()),
    url.replace('/file/', '/other/'),
    url.replace('https://', 'https:\\\\'),
    url + '\n',
    url.replace('assets.example', 'assets.\nexample'),
  ])
    expect(parseNewsletterAssetItem({ ...item(), url: candidate }).ok).toBe(false);
  for (const mimeType of ['image/svg+xml', 'image/avif', 'image/PNG', 'text/html', '', null])
    expect(parseNewsletterAssetItem({ ...item(), mimeType }).ok).toBe(false);
});

it('never admits causal upload receipts, grants or a deleted-public-token revocation claim', () => {
  for (const [value, parse] of [
    [item(), parseNewsletterAssetItem],
    [details(), readDetails],
    [list(), parseNewsletterAssetList],
  ] as const)
    for (const field of [
      'requestId',
      'replayed',
      'uploaded',
      'committed',
      'authorized',
      'tenantId',
      'ownerId',
      'token',
      'revoked',
      'complete',
      'hasMore',
    ])
      expect(parse({ ...value, [field]: true }).ok).toBe(false);
  expect(parseNewsletterAssetItem(null).ok).toBe(false);
  expect(
    accepted(parseNewsletterAssetList({ page: 1, pageSize: 25, total: 0, items: [] })),
  ).toEqual({ page: 1, pageSize: 25, total: 0, items: [] });
});

it('takes detached JSON snapshots and rejects hostile inputs without invoking getters', () => {
  const original = list();
  const received = accepted(parseNewsletterAssetList(original));
  original.items[0]!.name = 'later change';
  expect(received.items[0]!.name).toBe('Saved image');
  received.items[0]!.name = 'local copy';
  expect(original.items[0]!.name).toBe('later change');
  let getterCalls = 0;
  const accessor = Object.defineProperty({ ...item() }, 'url', {
    enumerable: true,
    get() {
      getterCalls++;
      return url;
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const hidden = Object.defineProperty({ ...item() }, 'private', { value: 1 });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [
    undefined,
    () => {},
    1n,
    new Date(time),
    new Map(),
    cycle,
    accessor,
    hidden,
    revoked.proxy,
    { ...item(), extra: Symbol() },
    Object.assign([], { length: 1 }),
  ]) {
    expect(() => parseNewsletterAssetItem(value)).not.toThrow();
    expect(parseNewsletterAssetItem(value).ok).toBe(false);
    expect(parseNewsletterAssetList(value).ok).toBe(false);
    expect(readDetails(value).ok).toBe(false);
  }
  const expected = Object.defineProperty({}, 'assetId', {
    enumerable: true,
    get() {
      getterCalls++;
      return id(2);
    },
  });
  expect(parseNewsletterAssetDetails(details(), expected as never).ok).toBe(false);
  expect(getterCalls).toBe(0);
  expect(accepted(parseNewsletterAssetItem(Object.assign(Object.create(null), item())))).toEqual(
    item(),
  );
});
