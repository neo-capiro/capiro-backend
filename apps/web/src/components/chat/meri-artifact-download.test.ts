import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchMeriArtifactDownload, meriArtifactIdFromDownloadUrl, saveMeriDownloadBlob } from './meri-artifact-download.js';

const apiBaseUrl = 'https://api.example.test';
const route = '/api/clio/artifacts/saved-artifact-1/download';
const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const getAuthHeaders = vi.fn(async () => ({ Authorization: 'Bearer fresh-token', 'x-capiro-impersonate-tenant': 'qa-tenant' }));
const input = () => ({ artifactId: 'saved-artifact-1', apiBaseUrl, getAuthHeaders, signal: new AbortController().signal });
function response(type = docxMime, disposition?: string, bytes = 'PK-document') {
  const blob = new Blob([bytes], { type });
  return { ok: true, headers: new Headers({ 'Content-Type': type, ...(disposition ? { 'Content-Disposition': disposition } : {}) }), blob: async () => blob };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('canonical authenticated Meri downloads', () => {
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
  ])('preserves %s bytes and canonical filename', async (type, extension) => {
    const res = response(type, `attachment; filename="original-saved-name.${extension}"`);
    const fetchMock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal('fetch', fetchMock);
    const options = input();
    const result = await fetchMeriArtifactDownload(options);
    expect(result.blob).toBe(await res.blob());
    expect(result.filename).toBe(`original-saved-name.${extension}`);
    expect(fetchMock).toHaveBeenCalledWith(`${apiBaseUrl}${route}`, {
      headers: { Authorization: 'Bearer fresh-token', 'x-capiro-impersonate-tenant': 'qa-tenant' },
      signal: options.signal, cache: 'no-store', redirect: 'error',
    });
    expect(fetchMock.mock.calls[0]![0]).not.toContain('token');
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

  test.each([['application/json', 'expected document'], ['text/html', 'expected document'], [docxMime, 'empty']])('rejects a successful HTTP response that is %s', async (type, error) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(type, undefined, type === docxMime ? '' : '{"error":"not a document"}')));
    await expect(fetchMeriArtifactDownload(input())).rejects.toThrow(error);
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
