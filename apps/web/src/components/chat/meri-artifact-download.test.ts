import { afterEach, describe, expect, test, vi } from 'vitest';
import { canonicalMeriArtifactSandboxUrl, fetchMeriArtifactDownload, meriArtifactDownloadFromUrl, meriArtifactIdFromDownloadUrl, meriDocumentBytesMatchFormat, saveMeriDownloadBlob } from './meri-artifact-download.js';
import { artifactDownloadResponse, artifactFixture, type ArtifactFixtureMime } from '../../test/meri-artifact-download-fixtures.js';

const apiBaseUrl = 'https://api.example.test';
const route = '/api/clio/artifacts/saved-artifact-1/download';
const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const getAuthHeaders = vi.fn(async () => ({ Authorization: 'Bearer fresh-token', 'x-capiro-impersonate-tenant': 'qa-tenant' }));
const input = () => ({ artifactId: 'saved-artifact-1', apiBaseUrl, getAuthHeaders, signal: new AbortController().signal });
function response(type: ArtifactFixtureMime = docxMime, disposition?: string) {
  return artifactDownloadResponse({ mime: type, disposition });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('canonical authenticated Meri downloads', () => {
  test('downloads exact UTF-8 text only with its saved operation and byte receipts', async () => {
    const bytes = new TextEncoder().encode('Synthetic Aster briefing v1\n');
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(bytes.length),
      'Content-Disposition': 'attachment; filename="aster-synthetic-briefing.txt"',
      'X-Capiro-Artifact-Id': 'saved-artifact-1',
      'X-Capiro-Artifact-Sha256': 'c26beebc62f179a568981d811784dc75ad7e2cad79c94165d6f4859dcb278c53',
      'X-Capiro-Artifact-Byte-Authority': 'persisted_at_creation_v1',
      'X-Capiro-Artifact-Operation-Id': '44444444-4444-4444-8444-444444444444',
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { headers }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchMeriArtifactDownload({ ...input(), expectedFormat: 'txt' });
    expect(result.filename).toBe('aster-synthetic-briefing.txt');
    expect(Array.from(new Uint8Array(await result.blob.arrayBuffer()))).toEqual(Array.from(bytes));
    for (const key of ['X-Capiro-Artifact-Byte-Authority', 'X-Capiro-Artifact-Operation-Id']) {
      fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { ...headers, [key]: '' } }));
      await expect(fetchMeriArtifactDownload({ ...input(), expectedFormat: 'txt' })).rejects.toThrow('creation receipt');
    }
    expect(meriDocumentBytesMatchFormat(new Uint8Array([0xff]), 'txt')).toBe(false);
    expect(meriDocumentBytesMatchFormat(new Uint8Array([0]), 'txt')).toBe(false);
    expect(meriDocumentBytesMatchFormat(new TextEncoder().encode('\ufeffCafé\r\n'), 'txt')).toBe(true);
  });
  test.each(['', '?format=pdf', '?format=docx'])('normalizes only the exact historical sandbox artifact alias %s', (query) => {
    expect(canonicalMeriArtifactSandboxUrl(`sandbox:${route}${query}`)).toBe(`${route}${query}`);
    expect(meriArtifactDownloadFromUrl(`sandbox:${route}${query}`, apiBaseUrl)).toEqual({
      artifactId: 'saved-artifact-1', ...(query ? { format: query.split('=')[1] } : {}),
    });
  });

  test.each([
    `sandbox://evil.example.test${route}`, `sandbox:/https://evil.example.test${route}`,
    `sandbox:${route}/../../secrets`, 'sandbox:/mnt/data/private.pdf',
    'sandbox:/api/clio/artifacts/id%2fother/download', 'sandbox:/api/clio/artifacts/../download',
    `sandbox:${route}?format=pdf&token=secret`, `sandbox:${route}?format=html`,
    `sandbox:${route}?format=pdf&format=docx`, `sandbox:${route}#document`,
  ])('rejects sandbox hosts, paths and decorations outside the canonical alias: %s', (href) => {
    expect(canonicalMeriArtifactSandboxUrl(href)).toBeNull();
    expect(meriArtifactDownloadFromUrl(href, apiBaseUrl)).toBeNull();
  });

  test.each([route, `${apiBaseUrl}${route}`, `${window.location.origin}${route}`, `${route}?download=1#document`, `${route}?token=secret`])('recognizes the saved identity in %s', (href) => {
    expect(meriArtifactIdFromDownloadUrl(href, apiBaseUrl)).toBe('saved-artifact-1');
  });
  test.each([
    `https://other.example.test${route}`, `https://api.example.test.evil.test${route}`,
    `https://user:password@api.example.test${route}`,
    '/api/clio/artifacts/id%2fother/download', '/api/clio/artifacts/saved-artifact-1/image',
    'javascript:alert(1)', 'https://congress.gov/bill/119th-congress/house-bill/1',
  ])('never treats %s as an authenticated artifact request', (href) => {
    expect(meriArtifactIdFromDownloadUrl(href, apiBaseUrl)).toBeNull();
  });

  test.each([
    [docxMime, 'docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
    ['application/pdf', 'pdf'],
  ] as const)('preserves valid generated %s bytes, digest and canonical filename', async (type, extension) => {
    const expected = artifactFixture(type);
    const res = response(type, `attachment; filename="original-saved-name.${extension}"`);
    const fetchMock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal('fetch', fetchMock);
    const options = input();
    const result = await fetchMeriArtifactDownload(options);
    const digest = await crypto.subtle.digest('SHA-256', await result.blob.arrayBuffer());
    expect(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')).toBe(expected.sha256);
    expect(result.blob.size).toBe(expected.bytes.byteLength);
    expect(result.filename).toBe(`original-saved-name.${extension}`);
    expect(fetchMock).toHaveBeenCalledWith(`${apiBaseUrl}${route}`, {
      headers: { Authorization: 'Bearer fresh-token', 'x-capiro-impersonate-tenant': 'qa-tenant' },
      signal: options.signal, cache: 'no-store', redirect: 'error',
    });
    expect(fetchMock.mock.calls[0]![0]).not.toContain('token');
  });

  test('preserves only an explicit PDF format from a decorated saved link and uses current auth', async () => {
    const link = meriArtifactDownloadFromUrl(`${route}?format=pdf&token=never-forward#document`, apiBaseUrl);
    expect(link).toEqual({ artifactId: 'saved-artifact-1', format: 'pdf' });
    const fetchMock = vi.fn().mockResolvedValue(response('application/pdf', 'attachment; filename="saved.pdf"'));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchMeriArtifactDownload({ ...input(), ...link })).filename).toBe('saved.pdf');
    expect(fetchMock).toHaveBeenCalledWith(`${apiBaseUrl}${route}?format=pdf`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer fresh-token' }),
    }));
  });

  test('gets fresh auth for each download and accepts only non-empty document content', async () => {
    const getFreshAuth = vi.fn()
      .mockResolvedValueOnce({ Authorization: 'Bearer token-1' })
      .mockResolvedValueOnce({ Authorization: 'Bearer token-2' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchMeriArtifactDownload({ ...input(), getAuthHeaders: getFreshAuth });
    const second = await fetchMeriArtifactDownload({ ...input(), getAuthHeaders: getFreshAuth });

    expect(getFreshAuth).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toEqual({
      Authorization: 'Bearer token-1',
    });
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toEqual({
      Authorization: 'Bearer token-2',
    });
    expect(first.blob.size).toBeGreaterThan(0);
    expect(second.blob.size).toBeGreaterThan(0);
  });

  test.each(['html', '', 'pdf&token=secret'])('rejects unsupported format %s before authenticating or fetching', async (format) => {
    const auth = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchMeriArtifactDownload({ ...input(), getAuthHeaders: auth, format })).rejects.toThrow('requested format');
    expect(auth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects ambiguous repeated format parameters instead of using an unvalidated download URL', () => {
    expect(meriArtifactDownloadFromUrl(`${route}?format=pdf&format=docx`, apiBaseUrl)?.format).toBe('');
  });

  test('rejects Word bytes returned for a PDF conversion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    await expect(fetchMeriArtifactDownload({ ...input(), format: 'pdf' })).rejects.toThrow('expected document');
  });

  test('rejects a missing or mismatched server integrity receipt', async () => {
    const missing = response();
    missing.headers.delete('X-Capiro-Artifact-Sha256');
    const mismatch = artifactDownloadResponse({ sha256: '0'.repeat(64) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(mismatch));
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow('integrity receipt');
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow('did not match');
  });

  test('checks the byte-format envelope after the response hash matches', async () => {
    const fakePdf = new TextEncoder().encode('%PDF-1.7\nFAKE-PDF\n%%EOF');
    const digest = await crypto.subtle.digest('SHA-256', fakePdf);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(artifactDownloadResponse({
      mime: 'application/pdf',
      bytes: fakePdf,
      sha256,
    })));

    expect(meriDocumentBytesMatchFormat(fakePdf, 'pdf')).toBe(false);
    await expect(fetchMeriArtifactDownload({ ...input(), expectedFormat: 'pdf' }))
      .rejects.toThrow('expected document format');

    const generated = artifactFixture('application/pdf').bytes;
    expect(meriDocumentBytesMatchFormat(generated, 'pdf')).toBe(true);
  });

  test('rejects same-format bytes carrying another saved artifact identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(artifactDownloadResponse({ artifactId: 'different-artifact' })));
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow('different saved document');
  });

  test('bounds declared and streamed bytes before constructing the browser Blob', async () => {
    const declared = response();
    declared.headers.set('Content-Length', String(20 * 1024 * 1024 + 1));
    let cancelled = false;
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() { cancelled = true; },
    });
    const streamed = new Response(stream, { headers: {
      'Content-Type': docxMime,
      'X-Capiro-Artifact-Id': 'saved-artifact-1',
      'X-Capiro-Artifact-Sha256': artifactFixture(docxMime).sha256,
    } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(declared).mockResolvedValueOnce(streamed));
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow('too large');
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow('too large');
    // The stream implementation may prefetch one chunk, but the reader never
    // accumulates beyond the first chunk that crosses the 20 MiB ceiling.
    expect(chunks).toBeLessThanOrEqual(22);
    expect(cancelled).toBe(true);
  });

  test('turns a fetch failure into a visible retryable network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow('network connection');
  });

  test.each([
    [422, 'MERI_DOCUMENT_RENDER_FAILED', 'PDF conversion failed'],
    [400, 'MERI_DOCUMENT_FORMAT_UNSUPPORTED', 'requested format'],
    [422, 'UNKNOWN', 'could not be downloaded'],
  ])('reports render/format errors safely for %s %s', async (status, code, message) => {
    const blob = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, blob, json: async () => ({ code, message: 'private server details' }) }));
    await expect(fetchMeriArtifactDownload({ ...input(), format: 'pdf' })).rejects.toThrow(message);
    expect(blob).not.toHaveBeenCalled();
  });

  test.each([
    ['unsupported_text', 'Download Word to preserve the full text'],
    ['document_too_large', 'split it into smaller documents'],
    ['invalid_image', 'check the chart'],
  ])('provides an actionable recovery for the known PDF render reason %s', async (reason, recovery) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ code: 'MERI_DOCUMENT_RENDER_FAILED', reason, format: 'pdf' }) }));
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow(`The PDF could not be generated.`);
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow(recovery);
  });

  test('preserves an encoded filename, strips paths and ignores a misleading extension', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(docxMime, "attachment; filename*=UTF-8''Caf%C3%A9.docx"))
      .mockResolvedValueOnce(response(docxMime, 'attachment; filename="../../saved.docx"'))
      .mockResolvedValueOnce(response(docxMime, 'attachment; filename="fake.html"'));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchMeriArtifactDownload(input())).filename).toBe('Café.docx');
    expect((await fetchMeriArtifactDownload(input())).filename).toBe('saved.docx');
    expect((await fetchMeriArtifactDownload({ ...input(), fallbackFilename: 'briefing.docx' })).filename).toBe('briefing.docx');
  });

  test.each([['application/json', 'expected document'], ['text/html', 'expected document']])('rejects a successful HTTP response that is %s', async (type, error) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"not a document"}', { headers: { 'Content-Type': type } })));
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow(error);
  });
  test('rejects an empty successful document response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(artifactDownloadResponse({ bytes: new Uint8Array(), contentLength: '0' })));
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow('empty');
  });
  test('rejects a file format that disagrees with the saved artifact kind', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    await expect(fetchMeriArtifactDownload({ ...input(), expectedFormat: 'xlsx' })).rejects.toThrow('expected document');
  });
  test.each([[401, 'sign-in expired'], [403, 'no longer have access'], [404, 'no longer have access'], [500, 'Please retry']])('reports %s without downloading an error payload', async (status, message) => {
    const blob = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, blob }));
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow(message);
    expect(blob).not.toHaveBeenCalled();
  });
  test('does not dispatch without auth or after cancellation while auth resolves', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchMeriArtifactDownload({ ...input(), getAuthHeaders: async () => ({}) })).rejects.toThrow('Sign in again');
    const abort = new AbortController();
    const result = fetchMeriArtifactDownload({ ...input(), signal: abort.signal, getAuthHeaders: async () => {
      abort.abort();
      return { Authorization: 'Bearer old-token' };
    } });
    await expect(result).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('keeps the blob URL alive after click, then releases it', () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:document');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    saveMeriDownloadBlob(new Blob(['PK']), 'saved.docx');
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    expect(document.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith('blob:document');
  });
});
