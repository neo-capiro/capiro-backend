import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { Agent } from 'undici';
import {
  validateUrlBeforeRequest,
  isPrivateAddress,
  resolveAndPinAddress,
  verifyAddressPinning,
  getContentType,
  looksLikePdf,
  sha256Bytes,
  sha256String,
  withGuardedWebResponse,
  readBodyWithSizeLimit,
} from './hardenedWebTransport.js';

// Mock DNS lookup
import * as dnsPromises from 'node:dns/promises';
jest.mock('node:dns/promises');

const mockLookup = jest.spyOn(dnsPromises, 'lookup') as unknown as jest.Mock<
  Promise<LookupAddress[]>,
  [string, { all: true; verbatim: boolean }]
>;

jest.mock('undici', () => ({
  Agent: jest.fn().mockImplementation(() => ({ destroy: jest.fn(async () => {}) })),
}));

describe('hardenedWebTransport', () => {
  describe('validateUrlBeforeRequest', () => {
    it('accepts valid http URL', () => {
      const result = validateUrlBeforeRequest('http://example.com/path');
      expect(result.protocol).toBe('http:');
      expect(result.hostname).toBe('example.com');
    });

    it('accepts valid https URL', () => {
      const result = validateUrlBeforeRequest('https://example.com/path');
      expect(result.protocol).toBe('https:');
    });

    it('rejects non http/https protocols', () => {
      expect(() => validateUrlBeforeRequest('ftp://example.com')).toThrow(
        'Only http/https URLs are allowed',
      );
      expect(() => validateUrlBeforeRequest('file:///etc/passwd')).toThrow(
        'Only http/https URLs are allowed',
      );
      expect(() => validateUrlBeforeRequest('javascript:alert(1)')).toThrow(
        'Only http/https URLs are allowed',
      );
    });

    it('rejects URLs with embedded credentials', () => {
      expect(() => validateUrlBeforeRequest('http://user:pass@example.com')).toThrow(
        'URLs with embedded credentials are not allowed',
      );
    });

    it('rejects private IP addresses', () => {
      expect(() => validateUrlBeforeRequest('http://127.0.0.1/test')).toThrow(
        'Private/local network URLs are not allowed',
      );
      expect(() => validateUrlBeforeRequest('http://localhost/test')).toThrow(
        'Private/local network URLs are not allowed',
      );
      expect(() => validateUrlBeforeRequest('http://10.0.0.1/test')).toThrow(
        'Private/local network URLs are not allowed',
      );
      expect(() => validateUrlBeforeRequest('http://192.168.1.1/test')).toThrow(
        'Private/local network URLs are not allowed',
      );
    });

    it('rejects private IPv6 addresses', () => {
      expect(() => validateUrlBeforeRequest('http://[::1]/test')).toThrow(
        'Private/local network URLs are not allowed',
      );
      expect(() => validateUrlBeforeRequest('http://[fc00::1]/test')).toThrow(
        'Private/local network URLs are not allowed',
      );
      expect(() => validateUrlBeforeRequest('http://[fe80::1]/test')).toThrow(
        'Private/local network URLs are not allowed',
      );
    });

    it('requires valid URL format', () => {
      expect(() => validateUrlBeforeRequest('not-a-url')).toThrow(
        'url must be a valid absolute URL',
      );
    });
  });

  describe('isPrivateAddress', () => {
    it('identifies localhost and .local domains', () => {
      expect(isPrivateAddress('localhost')).toBe(true);
      expect(isPrivateAddress('myhost.local')).toBe(true);
    });

    it('identifies private IPv4 ranges', () => {
      expect(isPrivateAddress('127.0.0.1')).toBe(true);
      expect(isPrivateAddress('10.0.0.1')).toBe(true);
      expect(isPrivateAddress('192.168.1.1')).toBe(true);
      expect(isPrivateAddress('172.16.0.1')).toBe(true);
      expect(isPrivateAddress('172.31.255.255')).toBe(true);
      expect(isPrivateAddress('169.254.1.1')).toBe(true);
      expect(isPrivateAddress('0.0.0.0')).toBe(true);
    });

    it('identifies public IPv4 addresses', () => {
      expect(isPrivateAddress('8.8.8.8')).toBe(false);
      expect(isPrivateAddress('1.1.1.1')).toBe(false);
      expect(isPrivateAddress('172.15.0.1')).toBe(false);
      expect(isPrivateAddress('172.32.0.1')).toBe(false);
    });

    it('identifies private IPv6 addresses', () => {
      expect(isPrivateAddress('[::1]')).toBe(true);
      expect(isPrivateAddress('[fc00::1]')).toBe(true);
      expect(isPrivateAddress('[fd00::1]')).toBe(true);
      expect(isPrivateAddress('[fe80::1]')).toBe(true);
    });

    it('identifies public IPv6 addresses', () => {
      expect(isPrivateAddress('[2001:4860:4860::8888]')).toBe(false);
      expect(isPrivateAddress('[2606:4700:4700::1111]')).toBe(false);
    });
  });

  describe('resolveAndPinAddress', () => {
    beforeEach(() => {
      mockLookup.mockResolvedValue([]);
    });

    it('resolves and pins a public address', async () => {
      mockLookup.mockResolvedValue([{ family: 4, address: '93.184.216.34' } as any]);
      const result = await resolveAndPinAddress('example.com');
      expect(result.pinned).toBe('93.184.216.34');
      expect(result.all).toEqual(['93.184.216.34']);
    });

    it('rejects if only private addresses are available', async () => {
      mockLookup.mockResolvedValue([
        { family: 4, address: '127.0.0.1' } as any,
        { family: 4, address: '10.0.0.1' } as any,
      ]);
      await expect(resolveAndPinAddress('no-public.example.com')).rejects.toThrow(
        'No valid public-only addresses found',
      );
    });

    it('rejects mixed private and public DNS answers', async () => {
      mockLookup.mockResolvedValue([
        { family: 4, address: '127.0.0.1' } as any,
        { family: 4, address: '93.184.216.34' } as any,
        { family: 4, address: '192.168.1.1' } as any,
      ]);
      await expect(resolveAndPinAddress('mixed.example.com')).rejects.toThrow('public-only');
    });
  });

  describe('verifyAddressPinning', () => {
    it('confirms pinned address matches', () => {
      expect(verifyAddressPinning('93.184.216.34', '93.184.216.34')).toBe(true);
    });

    it('rejects private address in actual resolution', () => {
      expect(verifyAddressPinning('127.0.0.1', '93.184.216.34')).toBe(false);
    });

    it('rejects mismatched addresses', () => {
      expect(verifyAddressPinning('1.2.3.4', '93.184.216.34')).toBe(false);
    });
  });

  describe('sha256 functions', () => {
    it('computes SHA-256 hash of bytes', () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const hash = sha256Bytes(data);
      expect(hash).toBe('185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969');
    });

    it('computes SHA-256 hash of string', () => {
      const hash = sha256String('Hello');
      expect(hash).toBe('185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969');
    });
  });

  describe('getContentType', () => {
    it('extracts content type from response headers', () => {
      const response = new Response('', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      expect(getContentType(response)).toBe('text/html; charset=utf-8');
    });

    it('returns the content type when set', () => {
      const response = new Response('', {
        headers: { 'content-type': 'text/plain' },
      });
      expect(getContentType(response)).toBe('text/plain');
    });
  });

  describe('looksLikePdf', () => {
    it('detects PDF content type', () => {
      expect(looksLikePdf('application/pdf', 'https://example.com/doc')).toBe(true);
      expect(looksLikePdf('application/x-pdf', 'https://example.com/doc')).toBe(true);
    });

    it('falls back to .pdf URL path', () => {
      expect(looksLikePdf('application/octet-stream', 'https://example.com/report.pdf')).toBe(true);
      expect(looksLikePdf('', 'https://example.com/report.pdf')).toBe(true);
    });

    it('rejects HTML content type', () => {
      expect(looksLikePdf('text/html', 'https://example.com/page')).toBe(false);
      expect(looksLikePdf('text/html', 'https://example.com/page.pdf.html')).toBe(false);
    });

    it('does not treat .pdf query param as PDF', () => {
      expect(looksLikePdf('text/html', 'https://example.com/view?file=report.pdf')).toBe(false);
    });
  });
});

// Restore original lookup after tests
afterAll(() => {
  mockLookup.mockRestore();
});

describe('guarded transport lifecycle', () => {
  const originalFetch = global.fetch;
  const agentMock = Agent as unknown as jest.Mock;
  beforeEach(() => {
    jest.clearAllMocks();
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  test.each([
    '100.64.0.1',
    '192.0.0.8',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.9',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'fe90::1',
    'febf::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '64:ff9b::7f00:1',
    '3fff::1',
    'example.localhost',
  ])('rejects non-public destination %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  test('preserves HTTPS hostname and pins the connection lookup independently for each redirect host', async () => {
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '2606:4700:4700::1111', family: 6 }]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://other.example/page' } }),
      )
      .mockResolvedValueOnce(new Response('hello'));
    const seen = await withGuardedWebResponse(
      'https://first.example/start',
      async (response, url, scope) => ({
        url,
        bytes: [...(await readBodyWithSizeLimit(response, 5, scope))],
      }),
    );
    expect(seen.url).toBe('https://other.example/page');
    expect(seen.bytes).toHaveLength(5);
    expect((global.fetch as jest.Mock).mock.calls.map(([url]) => url)).toEqual([
      'https://first.example/start',
      'https://other.example/page',
    ]);
    expect(mockLookup.mock.calls.map(([host]) => host)).toEqual(['first.example', 'other.example']);
    for (const [index, expected] of [
      [0, '93.184.216.34'],
      [1, '2606:4700:4700::1111'],
    ] as const) {
      const callback = jest.fn();
      agentMock.mock.calls[index][0].connect.lookup('ignored-dns-rebind.example', {}, callback);
      expect(callback).toHaveBeenCalledWith(null, expected, index === 0 ? 4 : 6);
      expect((global.fetch as jest.Mock).mock.calls[index][1]).toMatchObject({
        dispatcher: agentMock.mock.results[index]!.value,
        redirect: 'manual',
      });
      expect(agentMock.mock.results[index]!.value.destroy).toHaveBeenCalledTimes(1);
    }
  });

  test('rejects a private redirect before opening its connection', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    await expect(
      withGuardedWebResponse('https://first.example/', async () => null),
    ).rejects.toThrow('Private/local');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  test('rejects a hostname redirect whose DNS contains a private answer', async () => {
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://rebound.example/' } }),
      );
    await expect(
      withGuardedWebResponse('https://first.example/', async () => null),
    ).rejects.toThrow('public-only');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('starts the deadline before DNS and never dispatches a late DNS result', async () => {
    jest.useFakeTimers();
    let resolveDns!: (addresses: LookupAddress[]) => void;
    mockLookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDns = resolve;
        }),
    );
    global.fetch = jest.fn();
    const pending = withGuardedWebResponse('https://first.example/', async () => null, {
      deadlineMs: 50,
    });
    const rejected = expect(pending).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(51);
    await rejected;
    resolveDns([{ address: '93.184.216.34', family: 4 }]);
    await Promise.resolve();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('keeps the same deadline through a stalled body and cancels the reader', async () => {
    jest.useFakeTimers();
    const cancel = jest.fn();
    global.fetch = jest.fn().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const pending = withGuardedWebResponse(
      'https://first.example/',
      (response, _url, scope) => readBodyWithSizeLimit(response, 5, scope),
      { deadlineMs: 50 },
    );
    const rejected = expect(pending).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(51);
    await rejected;
    expect(cancel).toHaveBeenCalled();
    expect(agentMock.mock.results[0]!.value.destroy).toHaveBeenCalledTimes(1);
  });

  test('keeps the deadline active while extraction is pending', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn().mockResolvedValue(new Response('body'));
    const pending = withGuardedWebResponse(
      'https://first.example/',
      async () => new Promise(() => {}),
      { deadlineMs: 50 },
    );
    const rejected = expect(pending).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(51);
    await rejected;
  });

  test('enforces streamed bytes even when content-length understates the body', async () => {
    const cancel = jest.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response(body, { headers: { 'content-length': '1' } }));
    await expect(
      withGuardedWebResponse('https://first.example/', (response, _url, scope) =>
        readBodyWithSizeLimit(response, 5, scope),
      ),
    ).rejects.toThrow('maximum size');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
