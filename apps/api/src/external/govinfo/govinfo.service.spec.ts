import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import { GovInfoService } from './govinfo.service.js';
import { TokenBucket } from './rate-limiter.js';

const API_KEY = 'test-govinfo-key';

/** Minimal fetch Response stub. */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
    headers: new Map<string, string>(),
  } as unknown as Response;
}

function textResponse(text: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    headers: new Map<string, string>(),
  } as unknown as Response;
}

function pdfResponse(buf: Buffer) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString('utf8'),
    headers: new Map<string, string>(),
  } as unknown as Response;
}

interface CacheRow {
  url: string;
  response: unknown;
  fetchedAt: Date;
}

function makeService(opts?: {
  cacheBucket?: string;
  s3?: { send: (...args: unknown[]) => unknown };
  seedCache?: CacheRow;
}) {
  const cache = new Map<string, CacheRow>();
  if (opts?.seedCache) cache.set(opts.seedCache.url, opts.seedCache);

  const prisma = {
    govInfoCache: {
      findUnique: jest.fn(
        async ({ where }: { where: { url: string } }) => cache.get(where.url) ?? null,
      ),
      upsert: jest.fn(async ({ where, create }: { where: { url: string }; create: CacheRow }) => {
        cache.set(where.url, { ...create, fetchedAt: create.fetchedAt ?? new Date() });
        return cache.get(where.url)!;
      }),
    },
  };

  const config = {
    get: (k: string) =>
      k === 'GOVINFO_API_KEY'
        ? API_KEY
        : k === 'GOVINFO_CACHE_BUCKET'
          ? opts?.cacheBucket
          : 'us-east-1',
  } as unknown as ConfigService<AppConfig, true>;

  const s3 = (opts?.s3 ?? { send: jest.fn() }) as unknown as import('@aws-sdk/client-s3').S3Client;
  // Big bucket so the limiter never blocks in unit tests.
  const limiter = new TokenBucket({ capacity: 100_000, refillWindowMs: 1000 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test injection of private-ctor deps
  const svc = new GovInfoService(prisma as any, config, s3, limiter);
  return { svc, prisma, cache };
}

describe('GovInfoService', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
    fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>;
  });
  test('resumes CHRG beyond 100 with a frozen, credential-free source continuation', async () => {
    const { svc } = makeService();
    const since = '2026-01-01T00:00:00Z',
      until = '2026-09-13T00:00:00Z';
    // Live GovInfo returns unescaped ISO colons even when the request encoded them.
    const next = `https://api.govinfo.gov/collections/CHRG/${since}/${until}?offsetMark=next&api_key=secret`;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          packages: Array.from({ length: 100 }, (_, i) => ({ packageId: `CHRG-119hhrg${i}` })),
          nextPage: next,
          count: 150,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          packages: Array.from({ length: 50 }, (_, i) => ({ packageId: `CHRG-119hhrg${i + 100}` })),
          count: 150,
        }),
      );
    const first = await svc.listHearingsPage(119, since, until);
    expect(first.nextPage).not.toContain('api_key');
    const last = await svc.listHearingsPage(119, since, until, first.nextPage);
    expect(first.packages.length + last.packages.length).toBe(150);
    expect(last.nextPage).toBeNull();
  });
  test('rejects a CHRG continuation outside the exact source scope before fetching', async () => {
    const { svc } = makeService();
    await expect(
      svc.listHearingsPage(
        119,
        '2026-01-01T00:00:00Z',
        '2026-09-13T00:00:00Z',
        'https://example.invalid/next',
      ),
    ).rejects.toThrow('SCOPE_MISMATCH');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('listBills calls the BILLS collection endpoint with congress + docClass', async () => {
    const { svc } = makeService();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        packages: [
          {
            packageId: 'BILLS-118hr3935ih',
            title: 'NDAA',
            congress: '118',
            dateIssued: '2024-01-01',
          },
        ],
      }),
    );

    const bills = await svc.listBills(118, 'hr');

    const calledUrl = String(fetchMock.mock.calls[0]![0]);
    expect(calledUrl).toContain('https://api.govinfo.gov/collections/BILLS/');
    expect(calledUrl).toContain('congress=118');
    expect(calledUrl).toContain('docClass=hr');
    expect(calledUrl).toContain(`api_key=${API_KEY}`);
    expect(bills).toEqual([
      expect.objectContaining({
        billId: 'BILLS-118hr3935ih',
        congress: 118,
        billType: 'hr',
        billNumber: '3935',
        title: 'NDAA',
      }),
    ]);
  });

  test('getBillText fetches the package summary then the XML link and parses sections', async () => {
    const { svc } = makeService();
    const billXml = `<bill><section id="s1"><num>1.</num><heading>Short title</heading><text>This Act may be cited.</text></section></bill>`;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          packageId: 'BILLS-118hr1',
          download: { xmlLink: 'https://api.govinfo.gov/x.xml' },
        }),
      )
      .mockResolvedValueOnce(textResponse(billXml));

    const result = await svc.getBillText('BILLS-118hr1');

    expect(String(fetchMock.mock.calls[0]![0])).toContain('packages/BILLS-118hr1/summary');
    expect(result.xml).toBe(billXml);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.heading).toBe('Short title');
    expect(result.sections[0]!.number).toContain('1');
    expect(result.sections[0]!.text).toContain('This Act may be cited');
  });

  test('listCommitteeReports calls the CRPT collection endpoint', async () => {
    const { svc } = makeService();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        packages: [{ packageId: 'CRPT-118hrpt1', title: 'Report', congress: '118' }],
      }),
    );

    const reports = await svc.listCommitteeReports(118, 'house', 'authorization');

    expect(String(fetchMock.mock.calls[0]![0])).toContain('collections/CRPT/');
    expect(reports[0]).toEqual(
      expect.objectContaining({
        reportId: 'CRPT-118hrpt1',
        chamber: 'house',
        kind: 'authorization',
        congress: 118,
      }),
    );
  });

  test('getCommitteeReport returns the PDF buffer + metadata', async () => {
    const { svc } = makeService();
    const pdf = Buffer.from('%PDF-1.7 fake');
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          packageId: 'CRPT-118hrpt1',
          download: { pdfLink: 'https://api.govinfo.gov/r.pdf' },
        }),
      )
      .mockResolvedValueOnce(pdfResponse(pdf));

    const result = await svc.getCommitteeReport('CRPT-118hrpt1');

    expect(result.url).toBe('https://api.govinfo.gov/r.pdf');
    expect(result.pdfBuffer.equals(pdf)).toBe(true);
    expect(result.metadata.packageId).toBe('CRPT-118hrpt1');
  });

  test('getPublicLaw returns the PDF buffer', async () => {
    const { svc } = makeService();
    const pdf = Buffer.from('%PDF public law');
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          packageId: 'PLAW-118publ1',
          download: { pdfLink: 'https://api.govinfo.gov/p.pdf' },
        }),
      )
      .mockResolvedValueOnce(pdfResponse(pdf));

    const result = await svc.getPublicLaw('PLAW-118publ1');
    expect(result.pdfBuffer.equals(pdf)).toBe(true);
  });

  test('cache hit avoids the HTTP call', async () => {
    const cacheUrl = 'https://api.govinfo.gov/packages/BILLS-118hr1/summary';
    const { svc } = makeService({
      seedCache: {
        url: cacheUrl,
        response: {
          packageId: 'BILLS-118hr1',
          download: { xmlLink: 'https://api.govinfo.gov/x.xml' },
        },
        fetchedAt: new Date(),
      },
    });
    fetchMock.mockResolvedValueOnce(textResponse('<bill></bill>'));

    await svc.getBillText('BILLS-118hr1');

    // Only the XML fetch should hit the network — the summary came from cache.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('x.xml');
  });

  test('S3 cache hit returns the cached PDF without an HTTP fetch', async () => {
    const cachedPdf = Buffer.from('%PDF cached-in-s3');
    const sendMock = jest.fn(async () => ({
      Body: { transformToByteArray: async () => new Uint8Array(cachedPdf) },
    })) as unknown as (...args: unknown[]) => unknown;
    const s3 = { send: sendMock };
    const { svc } = makeService({ cacheBucket: 'capiro-govinfo-cache', s3 });
    // Summary still comes from the API (1 fetch); the PDF must come from S3 (0 PDF fetch).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        packageId: 'PLAW-118publ1',
        download: { pdfLink: 'https://api.govinfo.gov/p.pdf' },
      }),
    );

    const result = await svc.getPublicLaw('PLAW-118publ1');

    expect(result.pdfBuffer.equals(cachedPdf)).toBe(true);
    expect(s3.send).toHaveBeenCalledTimes(1); // GetObject only, no PutObject
    expect(fetchMock).toHaveBeenCalledTimes(1); // summary only, PDF served from S3
  });

  test('S3 cache miss fetches then writes the PDF to S3', async () => {
    const pdf = Buffer.from('%PDF fresh');
    let call = 0;
    const sendMock = jest.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('NoSuchKey'); // GetObject miss
      return {}; // PutObject ok
    }) as unknown as (...args: unknown[]) => unknown;
    const { svc } = makeService({ cacheBucket: 'capiro-govinfo-cache', s3: { send: sendMock } });
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          packageId: 'PLAW-118publ1',
          download: { pdfLink: 'https://api.govinfo.gov/p.pdf' },
        }),
      )
      .mockResolvedValueOnce(pdfResponse(pdf));

    const result = await svc.getPublicLaw('PLAW-118publ1');

    expect(result.pdfBuffer.equals(pdf)).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(2); // GetObject (miss) + PutObject (write)
  });
});
