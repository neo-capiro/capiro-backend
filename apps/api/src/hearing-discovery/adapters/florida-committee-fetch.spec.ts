import { createFloridaCommitteeFetch } from './florida-committee-fetch.js';
import type { FetchTextResult } from './source-http.js';

const response = (status = 200): FetchTextResult => ({
  ok: status === 200,
  status,
  body: status === 200 ? '<html>official</html>' : null,
  contentHash: 'hash',
  etag: null,
  lastModified: null,
  notModified: false,
  durationMs: 0,
  error: status === 200 ? null : `HTTP ${status}; Retry-After: 3600`,
  retryAfter: status === 429 ? '3600' : null,
});

describe('Florida committee request pacing per job', () => {
  function setup() {
    let now = 0;
    const pause = jest.fn(async (ms: number) => {
      now += ms;
    });
    const read = jest.fn(async () => response());
    return { pause, read, create: () => createFloridaCommitteeFetch(read, () => now, pause) };
  }
  it('paces distinct same-host pages, including concurrent requests, at least one second apart', async () => {
    const { read, pause, create } = setup();
    const fetch = create();
    await Promise.all([
      fetch('https://www.flsenate.gov/Committees/Show/RI'),
      fetch('https://flsenate.gov/Committees/Show/TR'),
      fetch('https://www.flsenate.gov/Media'),
    ]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(pause.mock.calls).toEqual([[1000], [1000]]);
  });
  it('stops all same-host requests after429 without sleeping or retrying before Retry-After; other hosts continue', async () => {
    const { read, pause, create } = setup();
    read.mockResolvedValueOnce(response(429));
    const fetch = create();
    const first = await fetch('https://www.flsenate.gov/Committees/Show/RI');
    const deferred = await fetch('https://www.flsenate.gov/Media');
    expect(first.retryAfter).toBe('3600');
    expect(deferred).toMatchObject({ ok: false, status: 429, retryAfter: '3600' });
    expect(deferred.error).toContain('Deferred flsenate.gov');
    await fetch('https://flhouse.gov/news');
    await fetch('https://www.armed-services.senate.gov/hearings');
    expect(read).toHaveBeenCalledTimes(3);
    expect(pause).not.toHaveBeenCalled();
    await create()('https://www.flsenate.gov/Committees/Show/RI');
    expect(read).toHaveBeenCalledTimes(4); // new job has no stale circuit
  });
  it('reuses the full URL response while separating query strings and representation contexts', async () => {
    const { read, create } = setup();
    const fetch = create();
    const url = 'https://flhouse.gov/news?session=2026';
    const first = await fetch(url, { accept: 'text/html' });
    const reused = await fetch(url, { accept: 'text/html', prior: { contentHash: 'hash' } });
    expect(reused).toBe(first);
    expect(reused.notModified).toBe(false);
    await fetch('https://flhouse.gov/news?session=2027', { accept: 'text/html' });
    await fetch(url, { accept: 'application/json' });
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('preserves non-Florida fetch behavior without pacing or caching', async () => {
    const { read, pause, create } = setup();
    const fetch = create();
    await fetch('https://www.armed-services.senate.gov/');
    await fetch('https://www.armed-services.senate.gov/');
    expect(read).toHaveBeenCalledTimes(2);
    expect(pause).not.toHaveBeenCalled();
  });
  it('omits the first Florida conditional state so304 cannot suppress another committee attribution', async () => {
    const read = jest.fn(async (_url: string, options?: { prior?: unknown }) =>
      options?.prior ? { ...response(), status: 304, body: null, notModified: true } : response(),
    );
    const fetch = createFloridaCommitteeFetch(read);
    const url = 'https://flhouse.gov/news';
    const first = await fetch(url, { prior: { etag: 'old-etag', contentHash: 'hash' } });
    const nextCommittee = await fetch(url);
    expect(first).toMatchObject({ status: 200, body: '<html>official</html>', notModified: false });
    expect(nextCommittee).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[1]?.prior).toBeUndefined();
  });
  it('does not cache an unexpected304 or a failed page as successful coverage', async () => {
    const { read, create } = setup();
    read.mockResolvedValueOnce({ ...response(), status: 304, body: null, notModified: true });
    const fetch = create();
    const url = 'https://flhouse.gov/news';
    expect(await fetch(url)).toMatchObject({ ok: false, status: 304, notModified: false });
    expect(await fetch(url)).toMatchObject({ ok: true, status: 200 });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
