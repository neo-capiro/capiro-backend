import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  downloadNewsletterImage,
  downloadNewsletterPage,
  downloadNewsletterVideoJson,
  newsletterImportUrl,
  newsletterPublicAddress,
} from './newsletter-asset-import.service.js';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));
const dns = lookup as jest.Mock;
const network = request as jest.Mock;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
function response({
  body = png,
  status = 200,
  headers = { 'content-type': 'image/png' },
  peer = '1.1.1.1',
  stall = false,
}: {
  body?: Buffer;
  status?: number;
  headers?: Record<string, string>;
  peer?: string;
  stall?: boolean;
} = {}) {
  network.mockImplementationOnce(
    (_url: URL, _options: object, receive: (response: PassThrough) => void) => {
      const stream = Object.assign(new PassThrough(), {
        statusCode: status,
        headers,
        socket: { remoteAddress: peer },
      });
      const req = Object.assign(new EventEmitter(), {
        destroy: jest.fn(),
        end: () => {
          queueMicrotask(() => {
            receive(stream);
            if (!stall && !stream.destroyed) stream.end(body);
          });
        },
      });
      return req;
    },
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
});

describe('bounded HTML page download', () => {
  it('uses the pinned public transport and keeps the final URL for relative metadata', async () => {
    response({ status: 302, headers: { location: '/final' } });
    response({
      body: Buffer.from('<head><title>Article</title></head>'),
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    expect(await downloadNewsletterPage('https://news.example/article')).toMatchObject({
      url: 'https://news.example/final',
      contentType: 'text/html; charset=utf-8',
    });
    expect(network.mock.calls[0][1].headers).toMatchObject({
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Encoding': 'identity',
    });
  });
  it.each<{ headers: Record<string, string>; body?: Buffer }>([
    { headers: { 'content-type': 'image/png' } },
    { headers: {} },
    { headers: { 'content-type': 'text/html', 'content-length': String(2 * 1024 * 1024 + 1) } },
    { headers: { 'content-type': 'text/html' }, body: Buffer.alloc(2 * 1024 * 1024 + 1) },
    { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } },
  ])('rejects unsupported or oversized HTML responses', async (options) => {
    response(options);
    await expect(downloadNewsletterPage('https://news.example/article')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('rejects private DNS answers, private redirects, peer mismatch and a stalled page', async () => {
    dns.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(downloadNewsletterPage('https://news.example/article')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    response({ status: 302, headers: { location: 'https://10.0.0.1/private' } });
    await expect(downloadNewsletterPage('https://news.example/article')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    response({ peer: '10.0.0.1' });
    await expect(downloadNewsletterPage('https://news.example/article')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    response({ stall: true, headers: { 'content-type': 'text/html' } });
    await expect(downloadNewsletterPage('https://news.example/article', 20)).rejects.toThrow(
      'timed out',
    );
  });
});
describe('image URL import', () => {
  it.each([
    'http://public.example/image.png',
    'file:///image.png',
    'https://a:b@public.example/image.png',
    'https://public.example:8443/image.png',
    'https://localhost/image.png',
    'https://service.internal/image.png',
    'https://169.254.169.254/image.png',
    'https://2130706433/image.png',
    'https://[::ffff:169.254.169.254]/image.png',
    'https://[2001:db8::1]/image.png',
    'https://[2002:7f00:1::]/image.png',
  ])('rejects forbidden destination %s before DNS or a request', async (url) => {
    await expect(downloadNewsletterImage(url)).rejects.toBeInstanceOf(BadRequestException);
    expect(dns).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it('pins a public-only DNS answer while retaining the original TLS host and stores no URL query in the name', async () => {
    response();
    const image = await downloadNewsletterImage(
      'https://images.example/Bill%20briefing.png?signature=private#caption',
    );
    expect(image).toEqual({ buffer: png, originalname: 'Bill briefing.png' });
    expect(network.mock.calls[0][0].hostname).toBe('images.example');
    const options = network.mock.calls[0][1];
    expect(options).toMatchObject({ agent: false, family: 4 });
    expect(options.rejectUnauthorized).toBeUndefined();
    const connected = jest.fn();
    options.lookup('images.example', {}, connected);
    expect(connected).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(options.headers).not.toHaveProperty('Cookie');
  });
  it('rejects a hostname with mixed public/private answers and refuses a different TCP peer', async () => {
    dns.mockResolvedValueOnce([
      { address: '1.1.1.1', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(downloadNewsletterImage('https://images.example/one.png')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(network).not.toHaveBeenCalled();
    response({ peer: '10.0.0.1' });
    await expect(downloadNewsletterImage('https://images.example/one.png')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
  it('checks every redirect before following it', async () => {
    response({ status: 302, headers: { location: 'https://127.0.0.1/private' } });
    await expect(downloadNewsletterImage('https://images.example/one.png')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(network).toHaveBeenCalledTimes(1);
    response({ status: 302, headers: { location: '/two.png' } });
    response();
    expect((await downloadNewsletterImage('https://images.example/one.png')).buffer).toEqual(png);
    expect(network.mock.calls[2][0].pathname).toBe('/two.png');
  });
  it('caps redirects and detects a redirect loop', async () => {
    response({ status: 302, headers: { location: '/one.png' } });
    await expect(downloadNewsletterImage('https://images.example/one.png')).rejects.toThrow(
      'redirect loop',
    );
    for (let i = 0; i < 6; i++) response({ status: 302, headers: { location: `/${i + 1}.png` } });
    await expect(downloadNewsletterImage('https://images.example/0.png')).rejects.toThrow(
      'too many redirects',
    );
  });
  it.each([
    ['HTTP failure', { status: 404 }],
    ['HTML content', { headers: { 'content-type': 'text/html' } }],
    ['MIME mismatch', { headers: { 'content-type': 'image/jpeg' } }],
    ['invalid bytes', { body: Buffer.from('<html>not an image</html>') }],
    [
      'compressed response',
      { headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' } },
    ],
    [
      'oversized header',
      { headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024 + 1) } },
    ],
    ['oversized stream', { body: Buffer.alloc(10 * 1024 * 1024 + 1) }],
  ] as const)('refuses %s without returning bytes', async (_name, options) => {
    response(options);
    await expect(downloadNewsletterImage('https://images.example/one.png')).rejects.toBeInstanceOf(
      Error,
    );
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('uses one deadline for DNS and stalled downloads', async () => {
    dns.mockImplementationOnce(() => new Promise(() => {}));
    await expect(downloadNewsletterImage('https://images.example/one.png', 20)).rejects.toThrow(
      'timed out',
    );
    expect(network).not.toHaveBeenCalled();
    response({ stall: true });
    await expect(downloadNewsletterImage('https://images.example/one.png', 20)).rejects.toThrow(
      'timed out',
    );
    expect(network.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('accepts only public unicast literals and removes the URL fragment', () => {
    expect(newsletterPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(newsletterPublicAddress('100.64.0.1')).toBe(false);
    expect(newsletterPublicAddress('224.0.0.1')).toBe(false);
    expect(newsletterImportUrl('https://images.example/image.png#caption').href).toBe(
      'https://images.example/image.png',
    );
  });
});

describe('bounded provider JSON download', () => {
  const endpoint = 'https://www.youtube.com/oembed',
    hosts = ['www.youtube.com'];
  it('pins the public provider, follows only approved hosts and sends no credentials', async () => {
    response({ status: 302, headers: { location: '/oembed?new=1' } });
    response({
      body: Buffer.from('{}'),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect((await downloadNewsletterVideoJson(endpoint, hosts)).buffer.toString()).toBe('{}');
    expect(network.mock.calls[1]![1].headers).toEqual(
      expect.objectContaining({ Accept: 'application/json', 'Accept-Encoding': 'identity' }),
    );
    expect(network.mock.calls[1]![1].headers).not.toHaveProperty('Cookie');
  });
  it('rejects a provider redirect to another public host before resolving it', async () => {
    response({ status: 302, headers: { location: 'https://evil.example/metadata' } });
    await expect(downloadNewsletterVideoJson(endpoint, hosts)).rejects.toThrow('metadata host');
    expect(dns).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it.each<Record<string, string>>([
    { 'content-type': 'text/html' },
    { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    { 'content-type': 'application/json', 'content-length': String(256 * 1024 + 1) },
  ])('rejects incompatible/oversized JSON response %#', async (headers) => {
    response({ headers });
    await expect(downloadNewsletterVideoJson(endpoint, hosts)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('bounds streamed bytes and the full deadline', async () => {
    response({
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(256 * 1024 + 1),
    });
    await expect(downloadNewsletterVideoJson(endpoint, hosts)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    response({ headers: { 'content-type': 'application/json' }, stall: true });
    await expect(downloadNewsletterVideoJson(endpoint, hosts, 20)).rejects.toThrow('timed out');
  });
  it('refuses private DNS answers and a different connected peer', async () => {
    dns.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(downloadNewsletterVideoJson(endpoint, hosts)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(network).not.toHaveBeenCalled();
    response({ headers: { 'content-type': 'application/json' }, peer: '10.0.0.1' });
    await expect(downloadNewsletterVideoJson(endpoint, hosts)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
