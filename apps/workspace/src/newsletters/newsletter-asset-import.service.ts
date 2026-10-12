import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
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
const hostName = (host: string) =>
  host
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');

/** Matches the conservative public-unicast policy used by the main API's web reader.
 * IPv4-mapped/translated IPv6 is deliberately excluded. */
export function newsletterPublicAddress(address: string): boolean {
  const host = hostName(address);
  const family = isIP(host);
  if (family === 4) return !nonPublicV4.check(host, 'ipv4');
  if (family === 6) return globalV6.check(host, 'ipv6') && !nonPublicV6.check(host, 'ipv6');
  return false;
}

export function newsletterImportUrl(value: string, subject = 'image'): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException(`Enter a valid ${subject} URL.`);
  }
  const host = hostName(url.hostname);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password)
    throw new BadRequestException(
      `Use a public HTTPS ${subject} URL without embedded credentials.`,
    );
  if (
    isIP(host)
      ? !newsletterPublicAddress(host)
      : !host.includes('.') ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        host.endsWith('.home.arpa') ||
        host.includes('%')
  )
    throw new BadRequestException('Private and local network URLs cannot be imported.');
  url.hash = '';
  return url;
}

export function newsletterImageMime(buffer: Buffer): string | null {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  return null;
}

/** A single deadline covers DNS, TLS, redirects and the bounded response stream.
 * Each hop resolves public-only addresses, then connects to that pinned answer.
 * URL host, TLS verification and SNI are retained. No cookies or auth are sent. */
async function downloadNewsletterResource(
  value: string,
  deadlineMs = 15_000,
  kind: 'image' | 'page' | 'json' = 'image',
  allowedHosts?: readonly string[],
) {
  const page = kind === 'page',
    json = kind === 'json';
  const subject = json ? 'video metadata' : page ? 'page' : 'image';
  const maxBytes = json ? 256 * 1024 : page ? 2 * 1024 * 1024 : MAX_IMAGE_BYTES;
  const timeoutMessage = json
    ? 'Video thumbnail timed out. Try again.'
    : page
      ? 'Link preview timed out. Try again.'
      : 'Image import timed out. Try again.';
  const sizeError = json
    ? 'Video metadata must be 256 KB or smaller.'
    : page
      ? 'Choose a page of up to 2 MB.'
      : 'Choose an image of up to 10 MB.';
  let current = newsletterImportUrl(value, subject);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const visited = new Set<string>();
  const wait = async <T>(operation: Promise<T>) => {
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new BadGatewayException(timeoutMessage));
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      controller.signal.removeEventListener('abort', abort);
    }
  };
  try {
    for (let hop = 0; ; hop += 1) {
      if (controller.signal.aborted) throw new BadGatewayException(timeoutMessage);
      if (visited.has(current.href))
        throw new BadRequestException(`The ${subject} URL has a redirect loop.`);
      visited.add(current.href);
      const host = hostName(current.hostname);
      if (allowedHosts && !allowedHosts.includes(host))
        throw new BadRequestException('The video metadata host is not supported.');
      const family = isIP(host);
      const addresses = family
        ? [{ address: host, family }]
        : await wait(lookup(host, { all: true, verbatim: true }));
      if (
        !addresses.length ||
        addresses.some(
          (entry) =>
            !newsletterPublicAddress(entry.address) || isIP(entry.address) !== entry.family,
        )
      )
        throw new BadRequestException('Private and local network URLs cannot be imported.');
      const pinned = addresses[0]!;
      const result = await wait(
        new Promise<
          | { redirect: string }
          | { buffer: Buffer; originalname: string; url: string; contentType: string }
        >((resolve, reject) => {
          const req = request(
            current,
            {
              signal: controller.signal,
              agent: false,
              family: pinned.family,
              lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
              headers: {
                Accept: json
                  ? 'application/json'
                  : page
                    ? 'text/html,application/xhtml+xml'
                    : 'image/png,image/jpeg,image/gif,image/webp',
                'Accept-Encoding': 'identity',
              },
            },
            (response) => {
              const fail = (error: Error) => {
                reject(error);
                response.destroy();
                req.destroy();
              };
              // Node may represent an IPv4 TCP peer as an IPv4-mapped IPv6 address.
              const peer = response.socket.remoteAddress?.replace(/^::ffff:/, '');
              if (peer !== pinned.address)
                return fail(new BadGatewayException(`The ${subject} host could not be verified.`));
              if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
                const location = response.headers.location;
                response.destroy();
                req.destroy();
                if (!location)
                  return reject(
                    new BadRequestException(`The ${subject} URL has an invalid redirect.`),
                  );
                return resolve({ redirect: location });
              }
              if (response.statusCode !== 200)
                return fail(new BadGatewayException(`The ${subject} URL could not be downloaded.`));
              const contentLength = Number(response.headers['content-length']);
              if (Number.isFinite(contentLength) && contentLength > maxBytes)
                return fail(new BadRequestException(sizeError));
              const declaredMime = response.headers['content-type']
                ?.split(';')[0]
                ?.trim()
                .toLowerCase();
              if (
                (json && declaredMime !== 'application/json') ||
                (page && !['text/html', 'application/xhtml+xml'].includes(declaredMime || '')) ||
                (kind === 'image' &&
                  declaredMime &&
                  ![
                    'image/png',
                    'image/jpeg',
                    'image/gif',
                    'image/webp',
                    'application/octet-stream',
                  ].includes(declaredMime))
              )
                return fail(
                  new BadRequestException(
                    json
                      ? 'The video provider must return JSON metadata.'
                      : page
                        ? 'The URL must return an HTML page.'
                        : 'The URL must point directly to a PNG, JPEG, GIF or WebP image.',
                  ),
                );
              const encoding = response.headers['content-encoding'];
              if (encoding && encoding !== 'identity')
                return fail(
                  new BadRequestException(
                    `The ${subject} server returned an unsupported compressed response.`,
                  ),
                );
              const chunks: Buffer[] = [];
              let bytes = 0;
              response.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > maxBytes) return fail(new BadRequestException(sizeError));
                chunks.push(chunk);
              });
              response.on('error', () =>
                reject(new BadGatewayException(`The ${subject} download was interrupted.`)),
              );
              response.on('end', () => {
                const buffer = Buffer.concat(chunks, bytes);
                const mime = newsletterImageMime(buffer);
                if (
                  kind === 'image' &&
                  (!mime || (declaredMime?.startsWith('image/') && mime !== declaredMime))
                )
                  return fail(new BadRequestException('The URL did not return a supported image.'));
                let name = current.pathname.split('/').at(-1) || 'Imported image';
                try {
                  name = decodeURIComponent(name);
                } catch {
                  /* Keep the encoded file name. */
                }
                resolve({
                  buffer,
                  url: current.href,
                  contentType: response.headers['content-type'] || '',
                  originalname:
                    name.replace(/[\x00-\x1f<>/\\]/g, '').slice(0, 200) || 'Imported image',
                });
              });
            },
          );
          req.on('error', () =>
            reject(new BadGatewayException(`The ${subject} URL could not be downloaded.`)),
          );
          req.end();
        }),
      );
      if ('buffer' in result) return result;
      if (hop >= 5) throw new BadRequestException(`The ${subject} URL has too many redirects.`);
      current = newsletterImportUrl(new URL(result.redirect, current).href, subject);
    }
  } catch (error) {
    if (error instanceof BadRequestException || error instanceof BadGatewayException) throw error;
    throw new BadGatewayException(`The ${subject} URL could not be downloaded.`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function downloadNewsletterImage(value: string, deadlineMs = 15_000) {
  const { buffer, originalname } = await downloadNewsletterResource(value, deadlineMs);
  return { buffer, originalname };
}

export function downloadNewsletterPage(value: string, deadlineMs = 15_000) {
  return downloadNewsletterResource(value, deadlineMs, 'page');
}

export function downloadNewsletterVideoJson(
  value: string,
  allowedHosts: readonly string[],
  deadlineMs = 15_000,
) {
  return downloadNewsletterResource(value, deadlineMs, 'json', allowedHosts);
}

@Injectable()
export class NewsletterAssetImportService {
  download(url: string) {
    return downloadNewsletterImage(url);
  }
}
