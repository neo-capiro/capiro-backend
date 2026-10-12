import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { TenantGuard } from '../auth/tenant.guard.js';
import { NewsletterService } from './newsletter.service.js';
import { NewsletterStockImageService } from './newsletter-stock-image.service.js';
import { NewsletterStockImageController } from './newsletter-stock-image.controller.js';

const photo = (id = 123) => ({
  id,
  width: 1600,
  height: 1200,
  alt: 'Capitol building',
  photographer: 'Policy photographer',
  photographer_url: 'https://www.pexels.com/@policy',
  url: `https://www.pexels.com/photo/capitol-${id}/`,
  src: {
    medium: `https://images.pexels.com/photos/${id}/photo.jpeg?h=350`,
    large2x: `https://images.pexels.com/photos/${id}/photo.jpeg?w=1880`,
  },
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('newsletter Pexels adapter', () => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  const service = new NewsletterStockImageService(
    new ConfigService({ NEWSLETTER_PEXELS_API_KEY: 'test-provider-key' }),
  );
  beforeEach(() => {
    fetcher.mockReset();
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetcher);
  });
  afterEach(() => jest.restoreAllMocks());
  it('reports no connection without revealing credentials or making a provider call', async () => {
    const disconnected = new NewsletterStockImageService(new ConfigService());
    expect(disconnected.status()).toEqual({
      provider: 'pexels',
      available: false,
      reason: 'Stock image search is not connected yet.',
    });
    await expect(disconnected.search()).rejects.toThrow('not connected');
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(service.status())).not.toContain('test-provider-key');
  });
  it('encodes user searches on the fixed host and returns credited metadata only', async () => {
    fetcher.mockResolvedValue(
      json({
        photos: [photo()],
        total_results: 100_001,
        page: 2,
        per_page: 10,
        next_page: 'https://malicious.example/',
      }),
    );
    const result = await service.search('  bills & news  ', 2);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.pexels.com/v1/search?page=2&per_page=10&query=bills+%26+news',
      expect.objectContaining({
        headers: { Authorization: 'test-provider-key', Accept: 'application/json' },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({
      page: 2,
      pageSize: 10,
      total: 100_000,
      items: [{ id: 123, title: 'Capitol building', photographer: 'Policy photographer' }],
    });
    expect(JSON.stringify(result)).not.toContain('malicious');
    expect(JSON.stringify(result)).not.toContain('test-provider-key');
  });
  it('loads curated photos for an empty query and resolves selection by numeric ID', async () => {
    fetcher
      .mockResolvedValueOnce(json({ photos: [], total_results: 0, page: 1, per_page: 10 }))
      .mockResolvedValueOnce(json(photo()));
    expect((await service.search()).items).toEqual([]);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.pexels.com/v1/curated?page=1&per_page=10');
    expect((await service.get('123')).imageUrl).toContain('https://images.pexels.com/photos/123/');
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://api.pexels.com/v1/photos/123');
  });
  it('rejects invalid pages, oversized queries and IDs before contacting the provider', async () => {
    for (const id of ['../123', '01', '0', 'https://internal/', '123?query=private'])
      await expect(service.get(id)).rejects.toThrow('valid stock image');
    await expect(service.search('x'.repeat(101))).rejects.toThrow('valid stock image search');
    await expect(service.search('bill', 0)).rejects.toThrow('valid stock image search');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('handles quota, auth, network and unreadable responses without provider error disclosure', async () => {
    fetcher.mockResolvedValueOnce(new Response('sensitive provider body', { status: 429 }));
    await expect(service.search()).rejects.toThrow('search limit');
    fetcher
      .mockResolvedValueOnce(new Response('test-provider-key', { status: 401 }))
      .mockRejectedValueOnce(new Error('test-provider-key'))
      .mockResolvedValueOnce(new Response('not JSON'));
    for (let i = 0; i < 3; i++)
      await expect(service.search()).rejects.toThrow('temporarily unavailable');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('bounds both declared and streamed response size', async () => {
    fetcher
      .mockResolvedValueOnce(
        new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
      )
      .mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(service.search()).rejects.toThrow('temporarily unavailable');
    await expect(service.search()).rejects.toThrow('temporarily unavailable');
  });
  it('rejects wrong photo IDs, untrusted media hosts and unsafe attribution URLs', async () => {
    fetcher.mockResolvedValueOnce(json(photo(124)));
    await expect(service.get('123')).rejects.toThrow('temporarily unavailable');
    for (const altered of [
      { ...photo(), src: { ...photo().src, large2x: 'https://127.0.0.1/image' } },
      { ...photo(), url: 'javascript:alert(1)' },
      { ...photo(), photographer_url: 'https://www.pexels.com.evil.example/user' },
    ]) {
      fetcher.mockResolvedValueOnce(json(altered));
      await expect(service.get('123')).rejects.toThrow('temporarily unavailable');
    }
  });
});

describe('newsletter stock-image HTTP boundary', () => {
  let app: INestApplication;
  const ctx = { tenantId: 'tenant-stock-fixture', clerkUserId: 'stock-owner-fixture' };
  const stock = {
    status: jest.fn(() => ({ provider: 'pexels', available: true, reason: null })),
    search: jest.fn(async () => ({ items: [] })),
    get: jest.fn(async () => ({
      imageUrl: 'https://images.pexels.com/photos/123/image.jpeg',
      title: 'Capitol building',
    })),
  };
  const newsletters = {
    importAsset: jest.fn(async () => ({
      id: 'saved-owner-asset',
      url: '/workspace-api/newsletters/assets/file/token',
      name: 'image.jpeg',
      mimeType: 'image/jpeg',
    })),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [NewsletterStockImageController],
      providers: [
        { provide: NewsletterStockImageService, useValue: stock },
        { provide: NewsletterService, useValue: newsletters },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate: (execution: {
          switchToHttp(): { getRequest(): { headers: Record<string, string> } };
        }) => execution.switchToHttp().getRequest().headers['x-stock-test-auth'] === 'yes',
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('workspace-api');
    app.use((req: { tenantContext?: typeof ctx }, _res: unknown, next: () => void) => {
      req.tenantContext = ctx;
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it('requires the tenant guard for status, search and import', async () => {
    await request(app.getHttpServer())
      .get('/workspace-api/newsletters/stock-images/status')
      .expect(403);
    await request(app.getHttpServer()).get('/workspace-api/newsletters/stock-images').expect(403);
    await request(app.getHttpServer())
      .post('/workspace-api/newsletters/stock-images/123/import')
      .expect(403);
    expect(stock.get).not.toHaveBeenCalled();
    expect(stock.search).not.toHaveBeenCalled();
  });
  it('validates query fields before search and carries only normalized parameters', async () => {
    await request(app.getHttpServer())
      .get('/workspace-api/newsletters/stock-images?search=bills&page=2')
      .set('x-stock-test-auth', 'yes')
      .expect(200);
    expect(stock.search).toHaveBeenCalledWith('bills', 2);
    for (const query of [
      'page=0',
      'page=1.5',
      'url=https://internal/',
      `search=${'x'.repeat(101)}`,
    ])
      await request(app.getHttpServer())
        .get(`/workspace-api/newsletters/stock-images?${query}`)
        .set('x-stock-test-auth', 'yes')
        .expect(400);
    expect(stock.search).toHaveBeenCalledTimes(1);
  });
  it('uses the authoritative provider selection and scoped existing asset importer', async () => {
    await request(app.getHttpServer())
      .post('/workspace-api/newsletters/stock-images/123/import')
      .set('x-stock-test-auth', 'yes')
      .send({ url: 'https://internal/image' })
      .expect(400);
    expect(stock.get).not.toHaveBeenCalled();
    const result = await request(app.getHttpServer())
      .post('/workspace-api/newsletters/stock-images/123/import')
      .set('x-stock-test-auth', 'yes')
      .send({})
      .expect(201);
    expect(stock.get).toHaveBeenCalledWith('123');
    expect(newsletters.importAsset).toHaveBeenCalledWith(
      ctx,
      'https://images.pexels.com/photos/123/image.jpeg',
    );
    expect(result.body).toMatchObject({ id: 'saved-owner-asset', altText: 'Capitol building' });
  });
});
