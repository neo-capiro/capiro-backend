/**
 * Shared fetch layer for the discovery adapters.
 *
 * Follows the plan's §8.3 scraping hierarchy: an adapter asks for the least
 * fragile representation available and this layer supplies conditional-GET
 * plumbing (ETag / Last-Modified) plus a content hash, so an unchanged official
 * page costs one 304 instead of a re-parse and a spurious change-feed entry.
 *
 * Deliberately NOT a general-purpose HTTP client: every request is a plain GET
 * to an official congressional host with a bounded timeout and a bounded
 * response size. No redirect-following into arbitrary hosts, no request bodies,
 * no cookies. Nothing here fetches MEDIA — media URLs are resolved by
 * intel-api's net-guard-protected resolver in Phase 4, which is where the SSRF
 * boundary lives.
 */
import { createHash } from 'crypto';

/** Committee sites reject the default Node UA; this is the browser UA the
 *  pre-existing `sync-hearings.ts` docs.house.gov scraper already uses. */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** A committee page that takes longer than this is treated as a failing source. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Hard cap on a single response. A committee site serving a 50 MB PDF listing
 * must not be able to exhaust the discovery task's heap.
 */
export const MAX_BYTES = 8 * 1024 * 1024;

export interface ConditionalState {
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
}

export interface FetchTextResult {
  ok: boolean;
  status: number;
  /** Null on 304 (not modified) or on failure. */
  body: string | null;
  /** sha256 of the body, when there is one. */
  contentHash: string | null;
  etag: string | null;
  lastModified: string | null;
  /** True when the server answered 304, or when the hash matched what we had. */
  notModified: boolean;
  durationMs: number;
  error: string | null;
}

/**
 * Conditional GET of a text/HTML/XML resource.
 *
 * `notModified` is set both for a real 304 and for a 200 whose body hashes to
 * the caller's previous hash — some committee CMSes ignore conditional headers
 * entirely, and the hash is what actually protects the change feed from
 * duplicate entries.
 */
export async function fetchText(
  url: string,
  opts: {
    prior?: ConditionalState;
    timeoutMs?: number;
    accept?: string;
    userAgent?: string;
  } = {},
): Promise<FetchTextResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {
    'User-Agent': opts.userAgent ?? BROWSER_UA,
    Accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (opts.prior?.etag) headers['If-None-Match'] = opts.prior.etag;
  if (opts.prior?.lastModified) headers['If-Modified-Since'] = opts.prior.lastModified;

  try {
    const resp = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    const etag = resp.headers.get('etag');
    const lastModified = resp.headers.get('last-modified');
    if (resp.status === 304) {
      return {
        ok: true,
        status: 304,
        body: null,
        contentHash: opts.prior?.contentHash ?? null,
        etag,
        lastModified,
        notModified: true,
        durationMs: Date.now() - started,
        error: null,
      };
    }
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        body: null,
        contentHash: null,
        etag,
        lastModified,
        notModified: false,
        durationMs: Date.now() - started,
        error: `HTTP ${resp.status}`,
      };
    }
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return {
        ok: false,
        status: resp.status,
        body: null,
        contentHash: null,
        etag,
        lastModified,
        notModified: false,
        durationMs: Date.now() - started,
        error: `response too large (${buffer.byteLength} bytes > ${MAX_BYTES})`,
      };
    }
    const body = new TextDecoder('utf-8').decode(buffer);
    const hash = createHash('sha256').update(body).digest('hex');
    return {
      ok: true,
      status: resp.status,
      body,
      contentHash: hash,
      etag,
      lastModified,
      notModified: opts.prior?.contentHash != null && opts.prior.contentHash === hash,
      durationMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      body: null,
      contentHash: null,
      etag: null,
      lastModified: null,
      notModified: false,
      durationMs: Date.now() - started,
      // An abort is a timeout, and saying so is the difference between a
      // diagnosable source failure and "unknown error" on the dashboard.
      error: controller.signal.aborted
        ? `timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Conditional GET of a JSON API resource. */
export async function fetchJson<T>(
  url: string,
  opts: { timeoutMs?: number; prior?: ConditionalState } = {},
): Promise<{
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  durationMs: number;
}> {
  const res = await fetchText(url, {
    ...opts,
    accept: 'application/json',
    // Congress.gov rejects nothing on UA, and identifying the client honestly is
    // better citizenship than pretending to be a browser against an API.
    userAgent: 'capiro-legiwatch-discovery/1.0 (+https://capiro.ai)',
  });
  if (!res.ok || res.body == null) {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: res.error,
      durationMs: res.durationMs,
    };
  }
  try {
    return {
      ok: true,
      status: res.status,
      data: JSON.parse(res.body) as T,
      error: null,
      durationMs: res.durationMs,
    };
  } catch (err) {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: res.durationMs,
    };
  }
}

/** Cooperative pacing between requests so a fan-out stays under rate limits. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  '#39': "'",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(
      /&([a-z0-9#]+);/gi,
      (m, name) => ENTITIES[name] ?? ENTITIES[String(name).toLowerCase()] ?? m,
    );
}

/** Strip tags, decode entities, fold typography to ASCII, collapse whitespace. */
export function cleanText(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}
