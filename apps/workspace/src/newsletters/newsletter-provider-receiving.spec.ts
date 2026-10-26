import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import {
  newsletterVideoSource,
  parseNewsletterAssetItem,
  parseNewsletterStockStatus,
  parseNewsletterStockPage,
  parseNewsletterStockImport,
  parseNewsletterCapabilities,
  parseNewsletterWritingProposal,
  parseNewsletterAltText,
  parseNewsletterImageRefinement,
  parseNewsletterVideoThumbnail,
  parseNewsletterLinkProposal,
  parseNewsletterHtmlCheck,
} from '@capiro/shared/newsletter';
import { NewsletterStockImageService } from './newsletter-stock-image.service.js';
import { NewsletterStockImageController } from './newsletter-stock-image.controller.js';
import { NewsletterService } from './newsletter.service.js';
import { newsletterLinkMetadata } from './newsletter-link-preview.service.js';
import { newsletterVideoMetadata } from './newsletter-video.service.js';

const assetId = '10000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const url = `https://assets.example.test/base/workspace-api/newsletters/assets/file/${'a'.repeat(64)}`;
const asset = { id: assetId, name: '', mimeType: 'image/png', url };
const photo = {
  id: 123,
  title: '',
  photographer: '',
  photographerUrl: 'https://www.pexels.com/@synthetic',
  sourceUrl: 'https://www.pexels.com/photo/synthetic-123/',
  thumbnailUrl: 'https://images.pexels.com/photos/123/photo.jpeg?h=350',
  imageUrl: 'https://images.pexels.com/photos/123/photo.jpeg?w=1880',
  width: 1600,
  height: 1200,
};
const page = { provider: 'pexels', items: [photo], page: 2, pageSize: 10, total: 100_000 };
const cap = { available: false, reason: 'Synthetic unavailable capability' };
const capabilities = {
  ai: cap,
  imageAi: cap,
  altTextAi: cap,
  htmlCheck: cap,
  inboxPreview: cap,
  send: cap,
};
const canonicalVideo = newsletterVideoSource('https://youtu.be/AbCdef_12-3')!;
const video = {
  sourceUrl: canonicalVideo.url,
  provider: canonicalVideo.provider,
  title: '',
  imageUrl: url,
};
const videoCapture = { sourceUrl: canonicalVideo.url, provider: canonicalVideo.provider };
const link = {
  sourceUrl: 'https://final.example.test/redirected',
  title: '',
  description: '',
  imageUrl: '',
  warnings: ['The page image could not be imported. The text preview is available.'],
};

afterEach(() => jest.restoreAllMocks());
it('admits the actual stock status/search/import outputs without a real provider request', async () => {
  const disconnected = new NewsletterStockImageService(new ConfigService());
  const providerCall = jest.spyOn(globalThis, 'fetch');
  expect(parseNewsletterStockStatus(disconnected.status())).toEqual({
    ok: true,
    value: disconnected.status(),
  });
  await expect(disconnected.search()).rejects.toThrow('not connected');
  expect(providerCall).not.toHaveBeenCalled();
  providerCall.mockResolvedValue(
    new Response(
      JSON.stringify({
        page: 2,
        per_page: 10,
        total_results: 100_001,
        photos: [
          {
            id: photo.id,
            width: photo.width,
            height: photo.height,
            alt: photo.title,
            photographer: photo.photographer,
            photographer_url: photo.photographerUrl,
            url: photo.sourceUrl,
            src: { medium: photo.thumbnailUrl, large2x: photo.imageUrl },
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  const service = new NewsletterStockImageService(
    new ConfigService({ NEWSLETTER_PEXELS_API_KEY: 'synthetic-key' }),
  );
  expect(parseNewsletterStockPage(await service.search('synthetic', 2), { page: 2 })).toEqual({
    ok: true,
    value: page,
  });
  const get = jest.spyOn(service, 'get').mockResolvedValue(photo);
  const importAsset = jest.fn().mockResolvedValue(asset);
  const controller = new NewsletterStockImageController(service, {
    importAsset,
  } as unknown as NewsletterService);
  const imported = await controller.import(
    { tenantId: assetId, clerkUserId: 'synthetic-actor' } as never,
    '123',
    {},
  );
  expect(get).toHaveBeenCalledWith('123');
  expect(importAsset.mock.calls[0]?.[1]).toBe(photo.imageUrl);
  expect(parseNewsletterStockImport(imported)).toEqual({
    ok: true,
    value: { ...asset, altText: '' },
  });
  expect(providerCall).toHaveBeenCalledTimes(1); // One fake response, no network.
});

it('binds only the echoed stock page and preserves attribution and producer bounds', () => {
  expect(parseNewsletterStockPage(page, { page: 1 })).toEqual({
    ok: false,
    error: { code: 'identity_mismatch', path: '$.page' },
  });
  expect(parseNewsletterStockPage({ ...page, total: 0 }, { page: 2 }).ok).toBe(true);
  expect(
    parseNewsletterStockPage(
      { ...page, items: [{ ...photo, id: Number.MAX_SAFE_INTEGER }] },
      { page: 2 },
    ).ok,
  ).toBe(true);
  for (const change of [
    { provider: 'other' },
    { page: 0 },
    { pageSize: 20 },
    { total: 100_001 },
    { query: 'invented' },
    { items: Array(11).fill(photo) },
  ])
    expect(parseNewsletterStockPage({ ...page, ...change }, { page: 2 }).ok).toBe(false);
  for (const change of [
    { id: '123' },
    { width: 0 },
    { height: 1.5 },
    { title: 'x'.repeat(501) },
    { photographer: 'x'.repeat(201) },
    { license: 'invented' },
  ])
    expect(
      parseNewsletterStockPage({ ...page, items: [{ ...photo, ...change }] }, { page: 2 }).ok,
    ).toBe(false);
  for (const unsafe of [
    'https://www.pexels.com.attacker.test/a',
    'http://www.pexels.com/a',
    'https://user@www.pexels.com/a',
    'https://www.pexels.com:444/a',
  ])
    expect(
      parseNewsletterStockPage(
        { ...page, items: [{ ...photo, photographerUrl: unsafe }] },
        { page: 2 },
      ).ok,
    ).toBe(false);
  expect(
    parseNewsletterStockImport({ ...asset, altText: 'Proposed description', photoId: 123 }).ok,
  ).toBe(false);
});

it('admits actual capability output but not invented send or inbox functionality', async () => {
  const credentials = {
    resolveAnthropic: jest.fn().mockResolvedValue(null),
    resolveNewsletterImage: jest.fn().mockResolvedValue(null),
  };
  const service = new NewsletterService(
    {} as never,
    {} as never,
    credentials as never,
    new ConfigService(),
  );
  const unavailable = await service.capabilities({
    tenantId: assetId,
    clerkUserId: 'synthetic-actor',
  });
  expect(parseNewsletterCapabilities(unavailable)).toEqual({ ok: true, value: unavailable });
  credentials.resolveAnthropic.mockResolvedValue({
    model: 'synthetic',
    secret: 'synthetic-key',
  } as never);
  const available = await service.capabilities({
    tenantId: assetId,
    clerkUserId: 'synthetic-actor',
  });
  expect(parseNewsletterCapabilities(available).ok).toBe(true);
  expect(available.ai).toEqual({ available: true, reason: null });
  for (const changed of [
    { ...capabilities, send: { available: true, reason: null } },
    { ...capabilities, inboxPreview: { available: true, reason: null } },
    { ...capabilities, connectUrl: 'https://attacker.test' },
  ])
    expect(parseNewsletterCapabilities(changed).ok).toBe(false);
});

it('keeps generated text inert and gives alt text its actual stricter bound', () => {
  const text = '<script>untrusted proposed text</script>';
  expect(parseNewsletterWritingProposal({ text })).toEqual({ ok: true, value: { text } });
  expect(parseNewsletterWritingProposal({ text: 'x'.repeat(30_000) }).ok).toBe(true);
  for (const value of [
    { text: '' },
    { text: ' ' },
    { text: 'x'.repeat(30_001) },
    { text, documentId: assetId },
  ])
    expect(parseNewsletterWritingProposal(value).ok).toBe(false);
  expect(parseNewsletterAltText({ text: 'x'.repeat(500) }).ok).toBe(true);
  for (const value of [
    { text: 'x'.repeat(501) },
    { text: '\u0000bad' },
    { text: null },
    { text: 'description', sourceToken: 'a'.repeat(64) },
  ])
    expect(parseNewsletterAltText(value).ok).toBe(false);
});

it('checks the captured refinement count without inventing current or source metadata', () => {
  expect(parseNewsletterImageRefinement({ items: [asset] }, { count: 1 })).toEqual({
    ok: true,
    value: { items: [asset] },
  });
  expect(parseNewsletterImageRefinement({ items: [asset] }, { count: 4 })).toEqual({
    ok: false,
    error: { code: 'identity_mismatch', path: '$.items' },
  });
  expect(parseNewsletterImageRefinement({ items: Array(4).fill(asset) }, { count: 4 }).ok).toBe(
    true,
  );
  for (const value of [
    { items: [] },
    { items: Array(5).fill(asset) },
    { items: [{ ...asset, currentRevision: true }] },
    { items: [asset], sourceToken: 'a'.repeat(64) },
  ])
    expect(parseNewsletterImageRefinement(value, { count: 1 }).ok).toBe(false);
});

it('binds normalized video source and provider but never claims document identity', () => {
  const metadata = newsletterVideoMetadata(
    {
      type: 'video',
      provider_name: 'YouTube',
      thumbnail_url: 'https://img.youtube.com/vi/AbCdef_12-3/hqdefault.jpg',
      title: '<Synthetic/video>',
    },
    'youtube',
  );
  expect(metadata.title).toBe('Synthetic video');
  expect(parseNewsletterVideoThumbnail(video, videoCapture)).toEqual({ ok: true, value: video });
  expect(
    parseNewsletterVideoThumbnail(video, {
      ...videoCapture,
      sourceUrl: 'https://www.youtube.com/watch?v=OtherVideo1',
    }),
  ).toEqual({ ok: false, error: { code: 'identity_mismatch', path: '$.sourceUrl' } });
  expect(parseNewsletterVideoThumbnail(video, { ...videoCapture, provider: 'vimeo' })).toEqual({
    ok: false,
    error: { code: 'identity_mismatch', path: '$.provider' },
  });
  for (const changed of [
    { ...video, title: 'x'.repeat(161) },
    { ...video, documentId: assetId },
    { ...video, imageUrl: photo.thumbnailUrl },
  ])
    expect(parseNewsletterVideoThumbnail(changed, videoCapture).ok).toBe(false);
});

it('admits actual redirected link metadata and text-only warning without a fake source binding', () => {
  const metadata = newsletterLinkMetadata(
    '<html><head><title>Synthetic &amp; inert</title><meta name="description" content="Description"></head></html>',
    link.sourceUrl,
  );
  expect(parseNewsletterLinkProposal({ ...metadata, warnings: [] })).toEqual({
    ok: true,
    value: { ...metadata, warnings: [] },
  });
  expect(parseNewsletterLinkProposal(link)).toEqual({ ok: true, value: link });
  expect(parseNewsletterLinkProposal({ ...link, imageUrl: url, warnings: [] }).ok).toBe(true);
  for (const change of [
    { title: 'x'.repeat(2001) },
    { description: 'x'.repeat(6001) },
    { imageUrl: null },
    { warnings: ['a', 'b'] },
    { sourceUrl: 'javascript:alert(1)' },
    { requestUrl: 'https://original.example.test' },
  ])
    expect(parseNewsletterLinkProposal({ ...link, ...change }).ok).toBe(false);
});

it('reuses the unchanged managed-asset policy and existing HTML revision receiver', () => {
  for (const candidate of [
    url,
    url.replace('https:', 'http:').replace('assets.example.test', 'assets.example.test:8080'),
  ]) {
    expect(parseNewsletterAssetItem({ ...asset, url: candidate }).ok).toBe(true);
    expect(parseNewsletterVideoThumbnail({ ...video, imageUrl: candidate }, videoCapture).ok).toBe(
      true,
    );
    expect(parseNewsletterLinkProposal({ ...link, imageUrl: candidate }).ok).toBe(true);
  }
  for (const candidate of [
    url + '?source=1',
    url + '#hash',
    url.replace('https://', 'https://user:secret@'),
    url.replace('/assets/file/', '/assets/other/'),
    ` ${url}`,
  ]) {
    expect(parseNewsletterAssetItem({ ...asset, url: candidate }).ok).toBe(false);
    expect(parseNewsletterVideoThumbnail({ ...video, imageUrl: candidate }, videoCapture).ok).toBe(
      false,
    );
    expect(parseNewsletterLinkProposal({ ...link, imageUrl: candidate }).ok).toBe(false);
  }
  const report = {
    provider: 'Mailtrap',
    issues: [],
    report: { status: 'success', errors: [] },
    revision: 3,
    checkedAt: '2026-10-26T12:00:00.000Z',
  };
  expect(parseNewsletterHtmlCheck(report, { revision: 3 }).ok).toBe(true);
  expect(parseNewsletterHtmlCheck(report, { revision: 4 }).ok).toBe(false);
});

it('rejects hostile JSON across all new boundaries and detaches accepted provider data', () => {
  const parsers = [
    parseNewsletterStockStatus,
    (value: unknown) => parseNewsletterStockPage(value, { page: 2 }),
    parseNewsletterStockImport,
    parseNewsletterCapabilities,
    parseNewsletterWritingProposal,
    parseNewsletterAltText,
    (value: unknown) => parseNewsletterImageRefinement(value, { count: 1 }),
    (value: unknown) => parseNewsletterVideoThumbnail(value, videoCapture),
    parseNewsletterLinkProposal,
  ];
  let accessed = false;
  const accessor = Object.defineProperty({}, 'text', {
    enumerable: true,
    get: () => {
      accessed = true;
      throw new Error('Must not run');
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [
    accessor,
    cycle,
    revoked.proxy,
    { [Symbol('hidden')]: 1 },
    Object.defineProperty({}, 'hidden', { value: 1 }),
    new Date(),
    [, 1],
  ])
    for (const parse of parsers) expect(parse(value).ok).toBe(false);
  expect(accessed).toBe(false);
  const original = structuredClone(page),
    admitted = parseNewsletterStockPage(original, { page: 2 });
  expect(admitted.ok).toBe(true);
  original.items[0]!.photographer = 'Changed later';
  if (admitted.ok) expect(admitted.value.items[0]!.photographer).toBe('');
  const expected = Object.defineProperty({}, 'page', {
    get: () => {
      accessed = true;
      return 2;
    },
    enumerable: true,
  });
  expect(parseNewsletterStockPage(page, expected as { page: number }).ok).toBe(false);
  expect(accessed).toBe(false);
});
