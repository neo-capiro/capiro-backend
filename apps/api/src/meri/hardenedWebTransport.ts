import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';
import { BadGatewayException, BadRequestException } from '@nestjs/common';

const nonPublicV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  nonPublicV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const nonPublicV6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  nonPublicV6.addSubnet(address, prefix, 'ipv6');

function unbracket(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}

/** Conservative public-unicast allowlist; mapped/translated IPv6 is not admitted. */
export function isPrivateAddress(address: string): boolean {
  const host = unbracket(address.toLowerCase()).replace(/\.$/, '');
  const family = isIP(host);
  if (family === 4) return nonPublicV4.check(host, 'ipv4');
  if (family === 6) return !globalV6.check(host, 'ipv6') || nonPublicV6.check(host, 'ipv6');
  return (
    !host ||
    host.includes(':') ||
    host.includes('%') ||
    !host.includes('.') ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  );
}

export function validateUrlBeforeRequest(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestException('url must be a valid absolute URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new BadRequestException('Only http/https URLs are allowed');
  if (parsed.username || parsed.password)
    throw new BadRequestException('URLs with embedded credentials are not allowed');
  if (isPrivateAddress(parsed.hostname))
    throw new BadRequestException('Private/local network URLs are not allowed');
  return parsed;
}

export async function resolveAndPinAddress(
  hostname: string,
): Promise<{ pinned: string; family: 4 | 6; all: string[] }> {
  const host = unbracket(hostname);
  const literalFamily = isIP(host);
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await lookup(host, { all: true, verbatim: true });
  // Reject mixed public/private answers instead of letting selection hide a forbidden destination.
  if (
    !addresses.length ||
    addresses.some(
      ({ address, family }) =>
        (family !== 4 && family !== 6) || isIP(address) !== family || isPrivateAddress(address),
    )
  ) {
    throw new BadRequestException('No valid public-only addresses found for hostname');
  }
  return {
    pinned: addresses[0]!.address,
    family: addresses[0]!.family as 4 | 6,
    all: addresses.map(({ address }) => address),
  };
}

export function verifyAddressPinning(actual: string, expected: string): boolean {
  return !isPrivateAddress(actual) && actual === expected;
}

export interface WebReadScope {
  signal: AbortSignal;
  check: () => void;
  wait: <T>(operation: Promise<T>) => Promise<T>;
  registerCleanup: (cleanup: () => Promise<unknown>) => () => void;
}

function deadlineScope(
  controller: AbortController,
  deadlineAt: number,
  cleanups: Set<() => Promise<unknown>>,
): WebReadScope {
  const check = () => {
    if (Date.now() >= deadlineAt && !controller.signal.aborted) controller.abort();
    if (controller.signal.aborted)
      throw new BadGatewayException('Web scrape timed out or was cancelled');
  };
  return {
    signal: controller.signal,
    check,
    registerCleanup: (cleanup) => {
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
      };
    },
    wait: async <T>(operation: Promise<T>): Promise<T> => {
      let rejectAbort!: (error: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () =>
        rejectAbort(new BadGatewayException('Web scrape timed out or was cancelled'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      // Attach a rejection handler even when the scope was already aborted.
      const pending = Promise.race([operation, aborted]);
      if (controller.signal.aborted) onAbort();
      try {
        const value = await pending;
        check();
        return value;
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** One deadline owns DNS, pinned connections, redirects, streaming, and extraction. */
export async function withGuardedWebResponse<T>(
  url: string,
  consume: (response: Response, finalUrl: string, scope: WebReadScope) => Promise<T>,
  options: {
    deadlineMs?: number;
    maxRedirects?: number;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const deadlineMs = options.deadlineMs ?? 10_000;
  const maxRedirects = options.maxRedirects ?? 5;
  if (
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= 0 ||
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0
  )
    throw new BadRequestException('Invalid web request bounds');
  const controller = new AbortController();
  const cleanups = new Set<() => Promise<unknown>>();
  const scope = deadlineScope(controller, Date.now() + deadlineMs, cleanups);
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const agents: Agent[] = [];
  let response: Response | undefined;
  try {
    let current = validateUrlBeforeRequest(url);
    const visited = new Set<string>();
    for (let hop = 0; ; hop += 1) {
      scope.check();
      if (visited.has(current.href)) throw new BadRequestException('Redirect cycle detected');
      visited.add(current.href);
      const { pinned, family } = await scope.wait(resolveAndPinAddress(current.hostname));
      scope.check();
      const agent = new Agent({
        connect: {
          autoSelectFamily: false,
          family,
          lookup: (_hostname, _options, callback) => callback(null, pinned, family),
        },
      });
      agents.push(agent);
      // Keep the hostname in the URL: Host, certificate validation, and TLS SNI stay correct.
      response = await scope.wait(
        fetch(current.href, {
          method: 'GET',
          headers: options.headers,
          redirect: 'manual',
          signal: scope.signal,
          dispatcher: agent,
        } as RequestInit & { dispatcher: Agent }),
      );
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return await scope.wait(consume(response, current.href, scope));
      }
      const location = response.headers.get('location');
      await scope.wait(response.body?.cancel() ?? Promise.resolve());
      if (!location) throw new BadRequestException('Redirect response missing Location header');
      if (hop >= maxRedirects) throw new BadRequestException('Too many redirects');
      current = validateUrlBeforeRequest(new URL(location, current).href);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    await Promise.allSettled([...cleanups].map((cleanup) => cleanup()));
    await Promise.all(agents.map((agent) => agent.destroy()));
  }
}

export async function readBodyWithSizeLimit(
  response: Response,
  maxBytes: number,
  scope: WebReadScope,
): Promise<Uint8Array> {
  scope.check();
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes)
    throw new BadRequestException('Response body exceeds maximum size');
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await scope.wait(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new BadRequestException('Response body exceeds maximum size');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  scope.check();
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function getContentType(response: Response): string {
  return (response.headers.get('content-type') ?? '').toLowerCase();
}
export function looksLikePdf(contentType: string, url: string | null | undefined): boolean {
  if (contentType.includes('application/pdf') || contentType.includes('application/x-pdf'))
    return true;
  if (['text/', 'html', 'xml', 'json'].some((part) => contentType.includes(part)) || !url)
    return false;
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}
export function sha256Bytes(data: Uint8Array | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
export function sha256String(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
