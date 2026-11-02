import { fetchFederalPublication, retainedFederalVersionMatches } from './federal-bill-hydration';
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
describe('federal immutable originals and exact receipt reuse', () => {
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
