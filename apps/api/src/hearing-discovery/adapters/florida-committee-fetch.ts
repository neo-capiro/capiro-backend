import { fetchText, type FetchTextResult } from './source-http.js';

/** Per-job politeness for Florida pages shared by many committee sources.
 * Every committee still parses the cached page under its own attribution rules.
 * A 429 stops the host for this run, including linked indexes; there is no retry
 * that could precede a publisher's Retry-After. This is not a cross-job lock.
 */
export function createFloridaCommitteeFetch(
  read: typeof fetchText = fetchText,
  clock: () => number = Date.now,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): typeof fetchText {
  const pages = new Map<string, Promise<FetchTextResult>>();
  const hosts = new Map<
    string,
    { tail: Promise<void>; lastFinished: number; blocked?: FetchTextResult }
  >();
  return (url, options) => {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (!['flsenate.gov', 'flhouse.gov', 'leg.state.fl.us'].includes(host))
      return read(url, options);
    const key = JSON.stringify([url, options?.accept ?? null, options?.userAgent ?? null]);
    const cached = pages.get(key);
    if (cached) return cached;
    let state = hosts.get(host);
    if (!state) {
      state = { tail: Promise.resolve(), lastFinished: -Infinity };
      hosts.set(host, state);
    }
    const current = state;
    const pending = current.tail.then(async () => {
      if (current.blocked)
        return {
          ...current.blocked,
          durationMs: 0,
          error: `Deferred ${host} after publisher rate limit; ${current.blocked.error}`,
        };
      const wait = Math.max(0, current.lastFinished + 1000 - clock());
      if (wait) await pause(wait);
      // A shared page must be parsed once for EACH body's attribution, even
      // when a previous source/job stored a conditional hash for that URL.
      // Fetch the full representation once, then reuse that body in this run.
      const result = await read(url, { ...options, prior: undefined });
      current.lastFinished = clock();
      if (result.status === 429) current.blocked = result;
      if (result.status === 304)
        return {
          ...result,
          ok: false,
          notModified: false,
          error: 'Publisher returned304 to a full-page request; committee attribution unavailable',
        };
      return result;
    });
    current.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    pages.set(key, pending);
    void pending.then(
      (result) => {
        if (!result.ok || result.body === null) pages.delete(key);
      },
      () => pages.delete(key),
    );
    return pending;
  };
}
