import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MeriArtifactDownloadLink } from './MeriArtifactDownloadLink.js';

const apiBaseUrl = 'https://api.example.test';
const href = '/api/clio/artifacts/saved-artifact-1/download';
const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const officeBytes = Uint8Array.from([
  0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0,
  0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0,
]);
const pdfBytes = new TextEncoder().encode('%PDF-1.7\ncontrolled fixture\n%%EOF');
function success() {
  return { ok: true, headers: new Headers({ 'Content-Type': docxMime, 'Content-Disposition': 'attachment; filename="saved-briefing.docx"' }), blob: async () => new Blob([officeBytes], { type: docxMime }) };
}
function setupBlob() {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved-document');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return { create, click };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('inline Meri artifact download', () => {
  test.each([`sandbox://untrusted.example.test${href}`, 'sandbox:/mnt/data/private.pdf'])('never links or authenticates unrecognized sandbox destinations: %s', (unrecognized) => {
    const getAuthHeaders = vi.fn();
    render(<MeriArtifactDownloadLink href={unrecognized} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>Unrecognized file</MeriArtifactDownloadLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(getAuthHeaders).not.toHaveBeenCalled();
  });

  test('intercepts the protected Markdown link and downloads the same saved artifact after reopening', async () => {
    const fetchMock = vi.fn().mockResolvedValue(success());
    vi.stubGlobal('fetch', fetchMock);
    const { click } = setupBlob();
    const getAuthHeaders = vi.fn(async () => ({ Authorization: 'Bearer current-user' }));
    const view = render(<MeriArtifactDownloadLink href={href} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>Download Word</MeriArtifactDownloadLink>);
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download Word' }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    view.unmount();
    render(<MeriArtifactDownloadLink href={href} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>Download Word</MeriArtifactDownloadLink>);
    fireEvent.click(screen.getByRole('button', { name: 'Download Word' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${apiBaseUrl}${href}`, `${apiBaseUrl}${href}`]);
    expect(getAuthHeaders).toHaveBeenCalledTimes(2);
  });

  test('keeps an expired-auth failure visible and retries using fresh headers without regenerating', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }).mockResolvedValueOnce(success());
    vi.stubGlobal('fetch', fetchMock);
    const { click } = setupBlob();
    const getAuthHeaders = vi.fn().mockResolvedValueOnce({ Authorization: 'Bearer expired' }).mockResolvedValueOnce({ Authorization: 'Bearer renewed' });
    render(<MeriArtifactDownloadLink href={href} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>Download Word</MeriArtifactDownloadLink>);
    fireEvent.click(screen.getByRole('button', { name: 'Download Word' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('sign-in expired');
    expect(click).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download Word' }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock.mock.calls[1]![1].headers.Authorization).toBe('Bearer renewed');
    expect(fetchMock.mock.calls[1]![0]).toBe(`${apiBaseUrl}${href}`);
  });

  test('keeps a network failure visible without creating a file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { click } = setupBlob();
    render(<MeriArtifactDownloadLink href={href} apiBaseUrl={apiBaseUrl} getAuthHeaders={async () => ({ Authorization: 'Bearer current-user' })}>Download Word</MeriArtifactDownloadLink>);
    fireEvent.click(screen.getByRole('button', { name: 'Download Word' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('network connection failed');
    expect(click).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download Word' })).toBeEnabled();
  });

  test('downloads PDF through the same protected inline link after history replay', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/pdf' }), blob: async () => new Blob([pdfBytes], { type: 'application/pdf' }) });
    vi.stubGlobal('fetch', fetchMock);
    const { click } = setupBlob();
    const getAuthHeaders = vi.fn(async () => ({ Authorization: 'Bearer current-user' }));
    const pdfHref = `${href}?format=pdf&token=discard`;
    const view = render(<MeriArtifactDownloadLink href={pdfHref} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>Download PDF</MeriArtifactDownloadLink>);
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    view.unmount();
    render(<MeriArtifactDownloadLink href={pdfHref} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>Download PDF</MeriArtifactDownloadLink>);
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${apiBaseUrl}${href}?format=pdf`, `${apiBaseUrl}${href}?format=pdf`]);
    expect(getAuthHeaders).toHaveBeenCalledTimes(2);
  });

  test('cancels the old format when a saved link changes while its download is in flight', async () => {
    let resolveResponse!: (response: ReturnType<typeof success>) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { resolveResponse = resolve; })));
    const { create } = setupBlob();
    const getAuthHeaders = async () => ({ Authorization: 'Bearer current-user' });
    const view = render(<MeriArtifactDownloadLink href={href} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>Download Word</MeriArtifactDownloadLink>);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(resolveResponse).toBeTypeOf('function'));
    view.rerender(<MeriArtifactDownloadLink href={`${href}?format=pdf`} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>Download PDF</MeriArtifactDownloadLink>);
    await act(async () => resolveResponse(success()));
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
  });

  test('does not dispatch an old artifact after the identity context changes during auth', async () => {
    let resolveAuth!: (headers: Record<string, string>) => void;
    const oldAuth = vi.fn(() => new Promise<Record<string, string>>((resolve) => { resolveAuth = resolve; }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { click } = setupBlob();
    const view = render(<MeriArtifactDownloadLink href={href} apiBaseUrl={apiBaseUrl} getAuthHeaders={oldAuth}>Download Word</MeriArtifactDownloadLink>);
    fireEvent.click(screen.getByRole('button', { name: 'Download Word' }));
    expect(screen.getByRole('button')).toBeDisabled();
    await waitFor(() => expect(resolveAuth).toBeTypeOf('function'));
    view.rerender(<MeriArtifactDownloadLink href={href} apiBaseUrl={apiBaseUrl} getAuthHeaders={async () => ({ Authorization: 'Bearer new-user' })}>Download Word</MeriArtifactDownloadLink>);
    await act(async () => resolveAuth({ Authorization: 'Bearer old-user' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toBeEnabled();
  });

  test('discards an in-flight result when the user switches to a different artifact', async () => {
    let resolveResponse!: (response: ReturnType<typeof success>) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { resolveResponse = resolve; })));
    const { create } = setupBlob();
    const getAuthHeaders = async () => ({ Authorization: 'Bearer current-user' });
    const view = render(<MeriArtifactDownloadLink href={href} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>Download Word</MeriArtifactDownloadLink>);
    fireEvent.click(screen.getByRole('button', { name: 'Download Word' }));
    await waitFor(() => expect(resolveResponse).toBeTypeOf('function'));
    view.rerender(<MeriArtifactDownloadLink href={href.replace('saved-artifact-1', 'saved-artifact-2')} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>Download Word</MeriArtifactDownloadLink>);
    await act(async () => resolveResponse(success()));
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('retains ordinary external links and never authenticates them', () => {
    const getAuthHeaders = vi.fn();
    const external = `https://untrusted.example.test${href}`;
    render(<MeriArtifactDownloadLink href={external} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>External source</MeriArtifactDownloadLink>);
    expect(screen.getByRole('link')).toHaveAttribute('href', external);
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('button')).toBeNull();
    expect(getAuthHeaders).not.toHaveBeenCalled();
  });

  test('bounds a stalled auth provider and restores the retry control', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const getAuthHeaders = () => new Promise<Record<string, string>>(() => undefined);
    render(<MeriArtifactDownloadLink href={href} apiBaseUrl={apiBaseUrl} getAuthHeaders={getAuthHeaders}>Download Word</MeriArtifactDownloadLink>);
    fireEvent.click(screen.getByRole('button', { name: 'Download Word' }));
    expect(screen.getByRole('button')).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(screen.getByRole('alert')).toHaveTextContent('download timed out');
    expect(screen.getByRole('button')).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
