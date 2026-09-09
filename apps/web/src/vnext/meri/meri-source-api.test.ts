import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meriSourceLocator, normalizeMeriSourceLocator, readMeriSource, safeMeriSourceUrl } from './meri-source-api.js';
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.example.test' } }));
const id = '50000000-0000-4000-8000-000000000001';
const locator = { kind: 'email' as const, recordId: id };
const auth = async () => ({ Authorization: 'Bearer test', 'X-Capiro-Tenant': 'tenant' });
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('full source transport and locator contract', () => {
  it('uses only configured API origin with bearer headers, no redirects/cache, and exact IDs', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ kind: 'email', recordId: id, status: 'available' })));
    await readMeriSource(locator, auth, 'source-cursor');
    expect(fetch).toHaveBeenCalledWith(`https://api.example.test/api/clio/sources?kind=email&recordId=${id}&cursor=source-cursor`, expect.objectContaining({ headers: await auth(), redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal) }));
  });
  it.each([[401, 'sign-in expired'], [403, 'denied'], [404, 'deleted'], [400, 'changed'], [503, 'temporarily unavailable']])('makes HTTP %s explicit', async (status, expected) => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: Number(status) }));
    await expect(readMeriSource(locator, auth)).rejects.toThrow(String(expected));
  });
  it('distinguishes a not-ready document from a stale continuation on the same HTTP status', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'ATTACHMENT_NOT_READY' }), { status: 400 }));
    await expect(readMeriSource(locator, auth)).rejects.toThrow('not ready');
  });
  it('bounds stalled auth and never sends a late token after timeout', async () => {
    vi.useFakeTimers();
    let resolve!: (headers: Record<string, string>) => void;
    const pending = readMeriSource(locator, () => new Promise((yes) => { resolve = yes; }));
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(60_001); await assertion;
    resolve(await auth()); await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels auth promptly on source navigation and rejects a missing token', async () => {
    const controller = new AbortController();
    const pending = readMeriSource(locator, () => new Promise(() => {}), undefined, controller.signal);
    controller.abort(new Error('Navigation changed'));
    await expect(pending).rejects.toThrow('Navigation changed');
    await expect(readMeriSource(locator, async () => ({}))).rejects.toThrow('Sign in again');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps exact historical locator metadata and does not use titles or picker identity', () => {
    expect(normalizeMeriSourceLocator({ kind: 'memory', recordId: id, clientId: 'bad', version: 'content:abcd' })).toEqual({ kind: 'memory', recordId: id, version: 'content:abcd' });
    expect(meriSourceLocator({ id: 'L3 Harris', type: 'client', title: 'L3 Harris', n: 1, snippet: null, url: null, tool: 'get_client_context' })).toBeUndefined();
    expect(meriSourceLocator({ id, type: 'email', title: 'mail', n: 1, snippet: null, url: null, tool: 'list_emails' })).toEqual(locator);
  });
  it('permits original web and canonical profile navigation without authenticated arbitrary URL fetching', () => {
    expect(safeMeriSourceUrl('javascript:alert(1)')).toBeNull();
    expect(safeMeriSourceUrl('//evil.test')).toBeNull();
    expect(safeMeriSourceUrl(`/api/clio/artifacts/${id}/download`)).toBeNull();
    expect(safeMeriSourceUrl(`/clients?clientId=${id}&tab=documents`)).toBe(`/clients?clientId=${id}&tab=documents`);
    expect(safeMeriSourceUrl('https://example.gov/source')).toBe('https://example.gov/source');
  });
});
