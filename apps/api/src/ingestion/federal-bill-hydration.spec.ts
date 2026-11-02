import {
  fetchFederalPublication,
  retainedFederalVersionMatches,
  hydrateFederalInventories,
} from './federal-bill-hydration';
import * as persistence from '../program-element/federal-evidence/persistence';
import { federalInventoryManifest } from './federal-billstatus-import';
import { normalizeFederalVersions } from './federal-billstatus';
import { byteHash } from './federal-document-bytes';
import { parseFederalCacheArgs } from '../../scripts/import-federal-billstatus-cache';
import { parseFederalInventoryArgs } from '../../scripts/sync-federal-bill-inventory';
const version = normalizeFederalVersions('119-samdt-1', 'amendment', [
  {
    type: 'Submitted',
    date: '2026-01-01',
    formats: [
      {
        type: 'HTML',
        url: 'https://www.congress.gov/119/crec/2026/01/01/172/1/modified/CREC-2026-01-01-pt1-PgS1.htm',
      },
    ],
  },
])[0]!;
function syntheticPdf() {
  const stream =
    'BT /F1 12 Tf 72 720 Td (SECTION 1.) Tj 0 -18 Td (Readable synthetic PDF provision.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const fallbackVersion = normalizeFederalVersions('119-hr-1', 'text', [
  {
    type: 'Introduced',
    date: '2026-01-01',
    formats: [
      {
        type: 'XML',
        url: 'https://www.govinfo.gov/content/pkg/BILLS-119hr1ih/xml/BILLS-119hr1ih.xml',
      },
      {
        type: 'PDF',
        url: 'https://www.govinfo.gov/content/pkg/BILLS-119hr1ih/pdf/BILLS-119hr1ih.pdf',
      },
    ],
  },
])[0]!;
describe('federal immutable originals and exact receipt reuse', () => {
  afterEach(() => jest.restoreAllMocks());
  it('preserves unreadable XML and falls through to a readable native PDF for the same version', async () => {
    const malformed = Buffer.from('<bill><section>truncated'),
      pdf = syntheticPdf(),
      captures: any[] = [];
    const fetchImpl = jest.fn(
      async (url: string) =>
        new Response(url.endsWith('.xml') ? malformed : pdf, {
          headers: { 'content-type': url.endsWith('.xml') ? 'application/xml' : 'application/pdf' },
        }),
    );
    const result = await fetchFederalPublication(fallbackVersion, {
      beforeAttempt: async () => {},
      fetchImpl: fetchImpl as any,
      onCapture: async (capture) => {
        captures.push(capture);
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.completeness).toBe('complete');
    expect(result.format).toBe('pdf');
    expect(result.extractedText).toContain('Readable synthetic PDF provision.');
    expect(captures.map((c) => [c.format, c.completeness])).toEqual([
      ['xml', 'unreadable'],
      ['pdf', 'complete'],
    ]);
    expect(captures.map((c) => c.originalBytes.sha256)).toEqual([
      byteHash(malformed),
      byteHash(pdf),
    ]);
  });
  it('persists every all-unreadable original and preserves captures before an alternate request cap', async () => {
    const malformed = Buffer.from('<bill><section>truncated'),
      badPdf = Buffer.from('%PDF-broken'),
      captures: any[] = [];
    const fetchImpl = async (url: string) =>
      new Response(url.endsWith('.xml') ? malformed : badPdf);
    const result = await fetchFederalPublication(fallbackVersion, {
      beforeAttempt: async () => {},
      fetchImpl: fetchImpl as any,
      onCapture: async (capture) => {
        captures.push(capture);
      },
    });
    expect(result.completeness).toBe('unreadable');
    expect(result.extractedText).toBe('');
    expect(captures).toHaveLength(2);
    expect(captures.every((c) => c.completeness === 'unreadable')).toBe(true);
    const saved: any[] = [];
    let calls = 0;
    await expect(
      fetchFederalPublication(fallbackVersion, {
        beforeAttempt: async () => {
          if (++calls === 2) throw Error('CONGRESS_REQUEST_CAP_REACHED');
        },
        fetchImpl: fetchImpl as any,
        onCapture: async (capture) => {
          saved.push(capture);
        },
      }),
    ).rejects.toThrow('CONGRESS_REQUEST_CAP_REACHED');
    expect(saved).toHaveLength(1);
    expect(saved[0].originalBytes.sha256).toBe(byteHash(malformed));
  });
  it('does not let cached unreadable primary bytes starve a readable alternate and binds both captures', async () => {
    const malformed = Buffer.from('<bill><section>truncated'),
      pdf = syntheticPdf();
    const receipt: any = {
      id: 'receipt',
      source: 'fy26-federal-provider-inventory',
      scope: { fiscalYear: 2026, congress: 119, billId: '119-hr-1', archiveHash: 'archive' },
      manifest: federalInventoryManifest({
        kind: 'text',
        providerDocumentId: '119-hr-1',
        providerUpdatedAt: '2026-01-01',
        versions: [fallbackVersion],
      }),
      complete: true,
      observedAt: new Date('2026-01-02'),
    };
    const cached: any = {
      rawContent: malformed.toString(),
      extractedText: '',
      completeness: 'unreadable',
      sourceUrl: fallbackVersion.formats.find((f) => f.type === 'xml')!.url,
      metadata: {
        originalBytesBase64: malformed.toString('base64'),
        rawBytesHash: byteHash(malformed),
        originalMime: 'application/xml',
      },
      observation: {
        providerDocumentId: '119-hr-1',
        providerVersionId: fallbackVersion.versionId,
        sourceInventoryReceiptId: receipt.id,
      },
      originManifest: receipt.manifest,
      originComplete: true,
    };
    expect(retainedFederalVersionMatches(cached, receipt, fallbackVersion)).toBe(false);
    let previousRows: any[] = [];
    const db: any = {
      $executeRawUnsafe: jest.fn(async () => 1),
      $queryRawUnsafe: jest.fn(async (sql: string) =>
        sql.includes("WHERE source='fy26-federal-provider-inventory'")
          ? [receipt]
          : sql.includes('cursor_jsonb AS cursor')
            ? [{ cursor: { offset: 0 } }]
            : previousRows,
      ),
    };
    const write = jest.spyOn(persistence, 'persistFederalEvidenceSnapshot').mockResolvedValue({
      sourceKey: 'source',
      revisionId: 'revision',
      observationInserted: true,
      revisionInserted: true,
      eventTypes: [],
      pendingUnknownCodes: [],
    });
    const generation: any = {
      congress: 119,
      inventoryHash: 'generation',
      archiveHashes: ['archive'],
      billIds: ['119-hr-1'],
      billArchives: new Map([['119-hr-1', 'archive']]),
      amendments: [],
    };
    const result = await hydrateFederalInventories(db, generation, {
      limit: 1,
      beforeAttempt: async () => {},
      fetchImpl: (async (url: string) =>
        new Response(url.endsWith('.xml') ? malformed : pdf)) as any,
    });
    expect(result).toMatchObject({ processed: 1, retained: 0, unreadable: 0, complete: true });
    expect(write).toHaveBeenCalledTimes(2);
    expect(
      write.mock.calls.map((call) => [call[1].metadata?.format, call[1].completeness]),
    ).toEqual([
      ['xml', 'unreadable'],
      ['pdf', 'complete'],
    ]);
    expect(new Set(write.mock.calls.map((call) => call[1].observationKey)).size).toBe(2);
    expect(
      write.mock.calls.every((call) => call[1].metadata?.sourceInventoryReceiptId === receipt.id),
    ).toBe(true);
    expect(
      write.mock.calls.every((call) => call[1].metadata?.publicationUrl === call[1].sourceUrl),
    ).toBe(true);
    previousRows = [cached];
    write.mockClear();
    let budget = 0;
    const alternateFetch = jest.fn(async () => new Response(pdf));
    const retried = await hydrateFederalInventories(db, generation, {
      limit: 1,
      beforeAttempt: async () => {
        if (++budget > 1) throw Error('CONGRESS_REQUEST_CAP_REACHED');
      },
      fetchImpl: alternateFetch as any,
    });
    expect(retried).toMatchObject({ processed: 1, retained: 0, complete: true, capped: false });
    expect(alternateFetch).toHaveBeenCalledTimes(1);
    expect((alternateFetch.mock.calls[0] as any)[0]).toMatch(/\.pdf$/);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![1]).toMatchObject({
      completeness: 'complete',
      metadata: { format: 'pdf' },
    });
    const failed = await hydrateFederalInventories(db, generation, {
      limit: 1,
      beforeAttempt: async () => {},
      fetchImpl: (async (url: string) =>
        new Response(url.endsWith('.xml') ? malformed : Buffer.from('%PDF-broken'))) as any,
    });
    expect(failed).toMatchObject({ processed: 1, unreadable: 1, complete: false });
  });
  it('captures exact publisher bytes and structure without any model dependency', async () => {
    const bytes = Buffer.from(
      '<html><body><h1>SECTION 1.</h1><p>Complete synthetic legislative language.</p></body></html>',
    );
    const before = jest.fn(async () => {}),
      fetchImpl = jest.fn(
        async () => new Response(bytes, { headers: { 'content-type': 'text/html;charset=utf-8' } }),
      );
    const result = await fetchFederalPublication(version, {
      beforeAttempt: before,
      fetchImpl: fetchImpl as any,
    });
    expect(before).toHaveBeenCalledTimes(1);
    expect(result.originalBytes.sha256).toBe(byteHash(bytes));
    expect(Buffer.from(result.originalBytes.base64, 'base64')).toEqual(bytes);
    expect(result.extractedText).toContain('Complete synthetic legislative language.');
    expect(result.sourceUrl).toBe(version.sourceUrl);
  });
  it('retains invalid declared encoding as unreadable with no lexical or semantic text', async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x61]);
    const result = await fetchFederalPublication(version, {
      beforeAttempt: async () => {},
      fetchImpl: (async () =>
        new Response(bytes, { headers: { 'content-type': 'text/html;charset=utf-16' } })) as any,
    });
    expect(result).toMatchObject({ rawContent: '', extractedText: '', completeness: 'unreadable' });
    expect(result.originalBytes.encoding).toBe('unsupported');
    expect(result.originalBytes.sha256).toBe(byteHash(bytes));
  });
  it('refuses cross-origin redirect and counts each bounded request attempt', async () => {
    const before = jest.fn(async () => {}),
      fetchImpl = jest.fn(
        async () =>
          new Response('', { status: 302, headers: { location: 'https://evil.example/doc.htm' } }),
      );
    await expect(
      fetchFederalPublication(version, {
        beforeAttempt: before,
        fetchImpl: fetchImpl as any,
        sleep: async () => {},
      }),
    ).rejects.toThrow('URL_UNQUALIFIED');
    expect(before).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.every((call) => (call as any)[0] === version.sourceUrl)).toBe(true);
  });
  it('reuses an older exact version only when its complete receipt freshness and bytes agree', () => {
    const text = 'Synthetic original text',
      bytes = Buffer.from(text),
      manifest = {
        kind: 'amendment',
        providerDocumentId: '119-samdt-1',
        providerUpdatedAt: '2026-01-01',
        versions: [version],
      };
    const receipt: any = { id: 'new', manifest };
    const row: any = {
      rawContent: text,
      extractedText: text,
      completeness: 'complete',
      sourceUrl: version.sourceUrl,
      metadata: {
        originalBytesBase64: bytes.toString('base64'),
        rawBytesHash: byteHash(bytes),
        originalMime: 'text/plain',
        originalBytesEncoding: 'UTF-8',
      },
      observation: {
        sourceInventoryReceiptId: 'old',
        providerDocumentId: '119-samdt-1',
        providerVersionId: version.versionId,
      },
      originManifest: manifest,
      originComplete: true,
    };
    expect(retainedFederalVersionMatches(row, receipt, version)).toBe(true);
    expect(retainedFederalVersionMatches({ ...row, originComplete: false }, receipt, version)).toBe(
      false,
    );
    expect(
      retainedFederalVersionMatches(
        row,
        { ...receipt, manifest: { ...manifest, providerUpdatedAt: '2026-02-01' } },
        version,
      ),
    ).toBe(false);
    expect(
      retainedFederalVersionMatches(
        { ...row, metadata: { ...row.metadata, rawBytesHash: '0'.repeat(64) } },
        receipt,
        version,
      ),
    ).toBe(false);
    expect(
      retainedFederalVersionMatches(
        { ...row, observation: { ...row.observation, providerVersionId: 'wrong' } },
        receipt,
        version,
      ),
    ).toBe(false);
  });
});
describe('federal CLI admission', () => {
  const host = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com',
    env = { DATABASE_URL: `postgresql://fixture:unused@${host}/capiro` };
  const args = [
    '--congress',
    '119',
    '--archive-hashes',
    Array.from({ length: 8 }, (_, i) => String(i).repeat(64)).join(','),
    '--amendment-list-hash',
    'f'.repeat(64),
    '--stage',
    'metadata',
  ];
  it('does not admit a write against another database or an unbudgeted provider stage', () => {
    expect(parseFederalInventoryArgs(args, env).commit).toBe(false);
    expect(() =>
      parseFederalInventoryArgs([...args, '--commit', '--expected-host', host], env),
    ).toThrow('CONGRESS_API_KEY_REQUIRED');
    expect(() =>
      parseFederalInventoryArgs(args, { DATABASE_URL: 'postgresql://fixture:unused@other/capiro' }),
    ).toThrow('DATABASE_MISMATCH');
    expect(() => parseFederalInventoryArgs([...args, '--request-cap', '4801'], env)).toThrow(
      'SCOPE',
    );
  });
  it('keeps local archive preview entirely offline and validates frozen hash scope', () => {
    const parsed = parseFederalCacheArgs(
      [
        '--congress',
        '119',
        '--type',
        'hr',
        '--expected-bills',
        '1',
        '--archive',
        'synthetic.zip',
        '--sha256',
        'a'.repeat(64),
      ],
      {},
    );
    expect(parsed.commit).toBe(false);
    expect(parsed.billType).toBe('hr');
  });
});
