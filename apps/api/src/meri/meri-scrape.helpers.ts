import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

/** The caller must never be able to make the API connect to a non-public peer. */
const BLOCKED_IPV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED_IPV4.addSubnet(address, prefix, 'ipv4');

const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet('2000::', 3, 'ipv6');
const BLOCKED_IPV6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23], // IETF protocol assignments, not ordinary public hosts
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 can tunnel a private IPv4 destination
] as const) BLOCKED_IPV6.addSubnet(address, prefix, 'ipv6');

export const MERI_SCRAPE_TIMEOUT_MS = 10_000;
export const MERI_SCRAPE_MAX_REDIRECTS = 5;
export const MERI_SCRAPE_MAX_HTML_BYTES = 4 * 1024 * 1024;
export const MERI_SCRAPE_MAX_PDF_BYTES = 15 * 1024 * 1024;

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_IPV4.check(address, 'ipv4');
  if (family === 6) {
    // This also rejects loopback, ULA/link-local, IPv4-mapped and NAT64 prefixes.
    return GLOBAL_IPV6.check(address, 'ipv6') && !BLOCKED_IPV6.check(address, 'ipv6');
  }
  return false;
}

export function parseAndValidatePublicUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('url must be a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('Only http/https URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new BadRequestException('URL credentials are not allowed');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new BadRequestException('URL hostname is required');
  if (
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host.endsWith('.home.arpa')
  ) {
    throw new BadRequestException('Private/local network URLs are not allowed');
  }
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(literal) && !isPublicIpAddress(literal)) {
    throw new BadRequestException('Private/local network URLs are not allowed');
  }
  return parsed;
}

/** Validate the DNS answer used by net.connect, not an earlier preflight answer. */
export function createPublicLookup(resolver: LookupFunction = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, options, (error, result, family) => {
      if (error) return callback(error, result, family);
      const addresses = typeof result === 'string' ? [result] : result.map((row) => row.address);
      if (!addresses.length || addresses.some((address) => !isPublicIpAddress(address))) {
        return callback(new Error('Private/local network destination blocked'), options.all ? [] : '', 0);
      }
      callback(null, result, family);
    });
  };
}

/** Defense in depth: fail closed if the connected socket does not have a public peer. */
export function guardPublicConnector(
  connector: ReturnType<typeof buildConnector>,
): ReturnType<typeof buildConnector> {
  return (options, callback) => {
    connector(options, (error, socket) => {
      if (error) return callback(error, null);
      if (!socket || !isPublicIpAddress(socket.remoteAddress ?? '')) {
        socket?.destroy();
        return callback(new Error('Private/local network connection blocked'), null);
      }
      callback(null, socket);
    });
  };
}

export type ScrapedResource = {
  url: string;
  contentType: string;
  body: Buffer;
};

/** A fresh, non-reusing connection pool keeps every redirect under this lookup policy. */
export async function fetchPublicScrape(
  rawUrl: string,
  options: {
    fetchImpl?: typeof undiciFetch;
    lookup?: LookupFunction;
    timeoutMs?: number;
  } = {},
): Promise<ScrapedResource> {
  const agent = new Agent({
    connect: guardPublicConnector(buildConnector({
      lookup: createPublicLookup(options.lookup),
      timeout: Math.min(options.timeoutMs ?? MERI_SCRAPE_TIMEOUT_MS, 5_000),
      maxCachedSessions: 0,
    })),
    connections: 1,
    pipelining: 1,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MERI_SCRAPE_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  try {
    let current = parseAndValidatePublicUrl(rawUrl);
    const visited = new Set<string>();
    for (let redirects = 0; redirects <= MERI_SCRAPE_MAX_REDIRECTS; redirects++) {
      if (visited.has(current.toString())) throw new BadRequestException('Web scrape redirect loop');
      visited.add(current.toString());
      const response = await fetchImpl(current.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Capiro-Meri/1.0; +https://capiro.ai)',
          Accept: 'text/html,application/xhtml+xml,application/pdf',
        },
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: agent,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        void response.body?.cancel().catch(() => {});
        if (!location) throw new BadGatewayException('Web scrape redirect lacked a location');
        if (redirects === MERI_SCRAPE_MAX_REDIRECTS) {
          throw new BadRequestException('Web scrape exceeded redirect limit');
        }
        current = parseAndValidatePublicUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new BadGatewayException(`Web scrape failed (${response.status})`);
      }
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const pdf = looksLikePdf(contentType, current.toString());
      if (!pdf && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        void response.body?.cancel().catch(() => {});
        throw new BadRequestException(`Unsupported content type for scraping: ${contentType || 'unknown'}`);
      }
      const maxBytes = pdf ? MERI_SCRAPE_MAX_PDF_BYTES : MERI_SCRAPE_MAX_HTML_BYTES;
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > maxBytes) {
        void response.body?.cancel().catch(() => {});
        throw new BadRequestException(pdf ? 'PDF too large to extract (limit 15MB)' : 'HTML too large to scrape (limit 4MB)');
      }
      return {
        url: current.toString(),
        contentType,
        body: await readBoundedBody(response.body, maxBytes),
      };
    }
    throw new BadRequestException('Web scrape exceeded redirect limit');
  } catch (error) {
    if (controller.signal.aborted) throw new BadGatewayException('Web scrape timed out');
    if (error instanceof BadRequestException || error instanceof BadGatewayException) throw error;
    throw new BadGatewayException('Web scrape request failed');
  } finally {
    clearTimeout(timer);
    await agent.destroy();
  }
}

async function readBoundedBody(
  body: Awaited<ReturnType<typeof undiciFetch>>['body'],
  maxBytes: number,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        throw new BadRequestException(maxBytes === MERI_SCRAPE_MAX_PDF_BYTES
          ? 'PDF too large to extract (limit 15MB)'
          : 'HTML too large to scrape (limit 4MB)');
      }
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      chunks.push(chunk);
    }
    complete = true;
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Whether a fetched resource should go down the PDF-extraction path: either
 * the response says application/pdf (params/case ignored) or, when the server
 * sends a generic/absent content type, the URL path itself ends in `.pdf`
 * (query string excluded). An explicit non-PDF content type like text/html
 * only defers to the URL when it is missing/generic — a .pdf-looking query
 * param never triggers the PDF path.
 */
export function looksLikePdf(
  contentType: string | null | undefined,
  url: string | null | undefined,
): boolean {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/pdf') || ct.includes('application/x-pdf')) return true;
  if (ct.includes('text/') || ct.includes('html') || ct.includes('xml') || ct.includes('json')) {
    return false;
  }
  if (!url) return false;
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}
