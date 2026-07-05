import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for the hearing stream resolver + ingestion path.
 *
 * The ingestion path (StreamIngestionService → ffmpeg) and the resolver both take
 * an operator/analyst-supplied URL and open it SERVER-SIDE. Before P8 the only
 * check was `new URL()` + http(s) scheme — which lets a URL point ffmpeg (or the
 * resolver's own `fetch`) at `http://169.254.169.254/…` (cloud metadata),
 * `http://127.0.0.1:<port>/…` (loopback services), or an internal `10.0.0.0/8`
 * host. This module closes that hole with a host ALLOWLIST + a private/link-local
 * IP DENY (applied to BOTH the literal host and, when it's a name, its resolved
 * A/AAAA records to defeat DNS-rebinding) + caps on redirects/size/timeout.
 *
 * Used by:
 *   - StreamResolverService — before every server-side page/probe fetch.
 *   - StreamIngestionService — before spawning ffmpeg on a media URL.
 *
 * The allowlist is HARDCODED (not env-driven): it is a security boundary, not a
 * feature toggle. Media/pages we resolve only ever come from these gov/broadcast
 * origins; anything else is refused (analysts fall back to assisted-paste, which
 * itself is validated through here before ingestion).
 *
 * ── RESIDUAL RISK (cannot be closed in-app) ──
 * This module hardens the NODE fetch path (resolver probes/page fetches follow
 * redirects manually, re-validating every hop's host + resolved IP) AND the
 * URL handed to ffmpeg (guardedProbe now returns the FINAL post-redirect URL, so
 * ffmpeg is pointed at a validated endpoint and started with `-follow_redirects 0`
 * + a protocol whitelist that excludes `file:`). What it CANNOT close: a
 * malicious HLS manifest hosted on an ALLOWLISTED host can list ABSOLUTE segment
 * URIs pointing at internal IPs (169.254.169.254 metadata, 10.x, etc.); ffmpeg
 * fetches those segment URIs itself, and the app never sees them to re-validate.
 * The only real mitigation is a network-layer egress policy.
 *   TODO(infra): egress deny for link-local/RFC1918 on the intel-api task —
 *   block 169.254.0.0/16 + 10.0.0.0/8 + 172.16.0.0/12 + 192.168.0.0/16 (and the
 *   IPv6 equivalents) at the security-group / NACL / egress-proxy layer so a
 *   compromised allowlisted manifest cannot reach internal services via ffmpeg.
 */

/** Browser UA — gov/broadcast pages 403 a bare Node/curl UA (proven for C-SPAN). */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Allowed host suffixes. A host is allowed when it EQUALS an entry or ends with
 * `.<entry>` (subdomain). Kept deliberately tight — expanding it is a security
 * decision, so it lives in code + review, never env.
 *
 * Deliberately does NOT use a broad `*.akamaized.net` (a multi-tenant CDN — any
 * customer can host content there, so a wildcard is an SSRF footgun). Instead we
 * pin the SPECIFIC Senate Akamai hosts the resolver actually constructs (see
 * stream-extractors.ts `constructSenateIsvpUrl` / `senateIsvpFallbackUrls`):
 *   - www-senate-gov-media-srs.akamaized.net    (primary ISVP master.m3u8)
 *   - www-senate-gov-msl3archive.akamaized.net  (archive fallback)
 *   - *.akamaihd.net                            (legacy per-committee HD host,
 *     `${comm}-f.akamaihd.net` — still a broadish suffix, but only ever a Senate
 *     fallback probe; kept until the legacy form is retired)
 *
 * Coverage rationale (see p8 resolver spec):
 *  - senate.gov + the pinned Senate Akamai hosts → Senate ISVP pages + HLS masters
 *  - *.house.gov + docs.house.gov → House committee pages / hearing docs
 *  - c-span.org + c-spanvideo.org → C-SPAN archive pages + m3u8 CDN
 *  - youtube.com / youtu.be       → YouTube watch pages (only fetched when the
 *    youtube-live adapter is enabled; the media host `googlevideo.com` is added
 *    to the allowlist ONLY behind RESOLVER_ENABLE_YOUTUBE_LIVE, below)
 *  - api.congress.gov             → congress.gov event `videos[]` (JSON API)
 */
export const ALLOWED_HOST_SUFFIXES: readonly string[] = Object.freeze([
  'senate.gov',
  'house.gov',
  'c-span.org',
  'c-spanvideo.org',
  'youtube.com',
  'youtu.be',
  'www-senate-gov-media-srs.akamaized.net',
  'www-senate-gov-msl3archive.akamaized.net',
  'akamaihd.net',
  'api.congress.gov',
  'docs.house.gov',
]);

/**
 * `googlevideo.com` (the YouTube-live HLS media host) is admitted ONLY when the
 * youtube-live adapter is enabled. It is a Google-wide CDN, so keeping it off the
 * allowlist while the adapter is gated OFF (the default) shrinks the SSRF surface.
 * The env flag matches StreamResolverService's RESOLVER_ENABLE_YOUTUBE_LIVE.
 */
function youtubeLiveEnabled(): boolean {
  const v = (process.env.RESOLVER_ENABLE_YOUTUBE_LIVE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export interface NetGuardOptions {
  /** Max redirects to follow (default 4). */
  maxRedirects?: number;
  /** Per-request timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Max response bytes to buffer for text fetches (default 5 MiB). */
  maxBytes?: number;
  /**
   * Skip the DNS resolution + IP-deny step. Only for unit tests / offline
   * environments — the host-suffix allowlist still applies. Never set in prod.
   */
  skipDnsCheck?: boolean;
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * True when `host` is (or is a subdomain of) an allowlisted origin. Case- and
 * trailing-dot-insensitive. Pure — no I/O.
 */
export function isHostAllowed(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  const matches = (suffix: string) => h === suffix || h.endsWith(`.${suffix}`);
  if (ALLOWED_HOST_SUFFIXES.some(matches)) return true;
  // googlevideo.com is gated behind the youtube-live flag (default OFF).
  if (youtubeLiveEnabled() && matches('googlevideo.com')) return true;
  return false;
}

/**
 * True when an IP literal is private, loopback, link-local, or otherwise
 * non-routable — the classic SSRF targets (cloud metadata 169.254.169.254,
 * 127.0.0.1, 10/8, 192.168/16, 172.16/12, ::1, fc00::/7, fe80::/10, mapped v4).
 * Pure — no I/O. Accepts only IP literals; returns false for names.
 */
export function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isPrivateIpv4(ip);
  if (fam === 6) return isPrivateIpv6(ip);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0]!; // strip zone id
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) → judge the embedded v4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

/**
 * Validate a URL for a server-side fetch: http(s) scheme, allowlisted host, and
 * — unless `skipDnsCheck` — no resolved IP in a private/link-local range. Throws
 * `SsrfError` on any violation. Returns the parsed URL on success.
 *
 * This is the single choke point both the resolver and the ingestion service call
 * before opening a URL.
 */
export async function assertUrlAllowed(rawUrl: string, opts: NetGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('URL must be http(s)');
  }
  const host = url.hostname;
  if (!isHostAllowed(host)) {
    throw new SsrfError(`Host not allowed: ${host}`);
  }
  // If the host is an IP literal, judge it directly.
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new SsrfError(`Blocked private IP: ${host}`);
    return url;
  }
  if (opts.skipDnsCheck) return url;
  // Resolve the name and deny if ANY record is private/link-local (anti-rebind).
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new SsrfError(`DNS lookup failed for ${host}: ${(err as Error).message}`);
  }
  if (!records.length) throw new SsrfError(`No DNS records for ${host}`);
  for (const rec of records) {
    if (isPrivateIp(rec.address)) {
      throw new SsrfError(`Host ${host} resolves to a private IP: ${rec.address}`);
    }
  }
  return url;
}

/**
 * SSRF-guarded text fetch: validates the URL through `assertUrlAllowed`, sends a
 * browser UA, caps the timeout, follows redirects MANUALLY re-validating each hop
 * (native `redirect:'follow'` would bypass the per-hop allowlist/IP check), and
 * caps the buffered body size. Returns `{ status, url, text }`.
 *
 * Throws `SsrfError` for a policy violation, or a plain Error for a transport
 * failure. Callers treat both as "could not resolve via this provider".
 */
export async function guardedFetchText(
  rawUrl: string,
  opts: NetGuardOptions & { headers?: Record<string, string> } = {},
): Promise<{ status: number; url: string; text: string }> {
  const maxRedirects = opts.maxRedirects ?? 4;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await assertUrlAllowed(current, opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(validated, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': BROWSER_UA, accept: '*/*', ...(opts.headers ?? {}) },
      });
      // Manual redirect handling: re-validate the Location against the allowlist.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { status: res.status, url: validated.toString(), text: '' };
        current = new URL(loc, validated).toString();
        continue;
      }
      const text = await readCapped(res, maxBytes);
      return { status: res.status, url: validated.toString(), text };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SsrfError(`Too many redirects (>${maxRedirects}) for ${rawUrl}`);
}

/** Read a response body but stop after `maxBytes` (avoids buffering a huge stream). */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * SSRF-guarded HEAD/range probe used to VALIDATE a candidate media URL without
 * downloading it. Tries HEAD; if the origin rejects HEAD (many CDNs 405/403 it),
 * falls back to a 1-byte ranged GET. Never buffers the body.
 *
 * Redirects are followed MANUALLY, re-validating each hop's host + resolved IP
 * through `assertUrlAllowed` (same as `guardedFetchText`). This is critical: a
 * direct-media URL on an allowlisted host that 302s OFF the allowlist (or to an
 * internal IP) must be REJECTED, not accepted as "reachable" — otherwise the
 * resolver would hand the ORIGINAL redirecting URL to ffmpeg, which would follow
 * the redirect unguarded (SSRF). On success returns `{ ok, status, contentType,
 * url }` where `url` is the FINAL, fully-validated post-redirect URL — the caller
 * MUST hand THAT url to ingestion, not the original. A redirect to a denied host
 * throws `SsrfError`; a real HTTP error status returns `ok:false`.
 */
export async function guardedProbe(
  rawUrl: string,
  opts: NetGuardOptions & { headers?: Record<string, string> } = {},
): Promise<{ ok: boolean; status: number; contentType: string | null; url: string }> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const maxRedirects = opts.maxRedirects ?? 4;

  const doReq = async (
    target: URL,
    method: 'HEAD' | 'GET',
    extra?: Record<string, string>,
  ) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(target, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': BROWSER_UA, ...(opts.headers ?? {}), ...(extra ?? {}) },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  // Follow the redirect chain manually so EACH hop is re-validated (host +
  // resolved IP). `redirect:'manual'` means fetch surfaces 3xx to us instead of
  // silently following off-allowlist.
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await assertUrlAllowed(current, opts);
    let res = await doReq(validated, 'HEAD');
    if (res.status === 405 || res.status === 403 || res.status === 501) {
      // Some CDNs disallow HEAD — retry with a tiny range GET.
      res = await doReq(validated, 'GET', { range: 'bytes=0-0' });
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      // A 3xx with no Location is a dead end — not reachable.
      if (!loc) return { ok: false, status: res.status, contentType: null, url: validated.toString() };
      // Resolve relative Locations against the current URL; the next loop
      // iteration re-validates the resulting host + IP (throws if denied).
      current = new URL(loc, validated).toString();
      continue;
    }
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      status: res.status,
      contentType: res.headers.get('content-type'),
      url: validated.toString(),
    };
  }
  throw new SsrfError(`Too many redirects (>${maxRedirects}) for ${rawUrl}`);
}
