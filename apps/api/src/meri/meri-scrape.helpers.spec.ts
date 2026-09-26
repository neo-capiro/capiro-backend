import type { LookupFunction } from 'node:net';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Agent, Response, buildConnector, fetch as undiciFetch } from 'undici';
import {
  fetchPublicScrape,
  guardPublicConnector,
  isPublicIpAddress,
  looksLikePdf,
  parseAndValidatePublicUrl,
  createPublicLookup,
  MERI_SCRAPE_MAX_HTML_BYTES,
} from './meri-scrape.helpers.js';

describe('looksLikePdf', () => {
  it('detects the PDF content type regardless of params/case', () => {
    expect(looksLikePdf('application/pdf', 'https://example.com/doc')).toBe(true);
    expect(looksLikePdf('application/pdf; charset=binary', 'https://example.com/doc')).toBe(true);
    expect(looksLikePdf('Application/PDF', 'https://example.com/doc')).toBe(true);
    expect(looksLikePdf('application/x-pdf', 'https://example.com/doc')).toBe(true);
  });

  it('falls back to a .pdf URL path when the content type is generic', () => {
    expect(looksLikePdf('application/octet-stream', 'https://gao.gov/assets/report.pdf')).toBe(true);
    expect(looksLikePdf('', 'https://gao.gov/assets/REPORT.PDF')).toBe(true);
    expect(looksLikePdf(null, 'https://gao.gov/assets/report.pdf?download=1')).toBe(true);
  });

  it('is false for HTML pages and non-pdf URLs', () => {
    expect(looksLikePdf('text/html', 'https://example.com/page')).toBe(false);
    expect(looksLikePdf('text/html; charset=utf-8', 'https://example.com/page.pdf.html')).toBe(false);
    expect(looksLikePdf('', 'https://example.com/page')).toBe(false);
    expect(looksLikePdf(null, null)).toBe(false);
  });

  it('does not treat a .pdf query param as a pdf path', () => {
    expect(looksLikePdf('text/html', 'https://example.com/view?file=report.pdf')).toBe(false);
  });
});

describe('scrape_web_page public destination boundary', () => {
  it('rejects local URL spellings, mapped IPv6, and URL credentials before fetching', () => {
    for (const raw of [
      'http://127.0.0.1/',
      'http://0177.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost./',
      'https://user:pass@public.example/',
    ]) {
      expect(() => parseAndValidatePublicUrl(raw)).toThrow();
    }
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
    for (const address of [
      '10.0.0.1', '100.64.0.1', '192.168.1.1', '198.18.0.1',
      '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1', '2002:0a00:0001::',
    ]) {
      expect(isPublicIpAddress(address)).toBe(false);
    }
  });

  it('rejects the actual DNS answer at connection time, including a rebinding answer', () => {
    const answers = ['8.8.8.8', '10.0.0.1'];
    const resolver: LookupFunction = (_hostname, _options, callback) => {
      const address = answers.shift()!;
      callback(null, address, 4);
    };
    const lookup = createPublicLookup(resolver);
    const first = jest.fn();
    lookup('public.example', {}, first);
    expect(first.mock.calls[0]?.[0]).toBeNull();
    expect(first.mock.calls[0]?.[1]).toBe('8.8.8.8');
    const rebound = jest.fn();
    lookup('public.example', {}, rebound);
    expect(rebound.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(rebound.mock.calls[0]?.[1]).toBe('');
  });

  it('rejects mixed public/private DNS answers and checks the connected peer', () => {
    const resolver: LookupFunction = (_hostname, _options, callback) => {
      callback(null, [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);
    };
    const dnsResult = jest.fn();
    createPublicLookup(resolver)('public.example', { all: true }, dnsResult);
    expect(dnsResult.mock.calls[0]?.[0]).toBeInstanceOf(Error);

    const destroy = jest.fn();
    const connector = ((_options, callback) => {
      callback(null, { remoteAddress: '::ffff:127.0.0.1', destroy } as never);
    }) as ReturnType<typeof buildConnector>;
    const connected = jest.fn();
    guardPublicConnector(connector)({ hostname: 'public.example', protocol: 'https:', port: '443' }, connected);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(connected.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('does not fetch a private redirect target', async () => {
    const fetchImpl = jest.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/admin' },
    })) as unknown as typeof undiciFetch;
    await expect(fetchPublicScrape('https://public.example/start', { fetchImpl }))
      .rejects.toThrow('Private/local network URLs are not allowed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://public.example/start',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('stops redirect loops and accepts a bounded HTML response', async () => {
    const loopFetch = jest.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/b' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/a' } }));
    await expect(fetchPublicScrape('https://public.example/a', {
      fetchImpl: loopFetch as typeof undiciFetch,
    })).rejects.toThrow('Web scrape redirect loop');
    expect(loopFetch).toHaveBeenCalledTimes(2);

    const okFetch = jest.fn(async () => new Response('<title>OK</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const resource = await fetchPublicScrape('https://public.example/page', {
      fetchImpl: okFetch as typeof undiciFetch,
    });
    expect(resource.url).toBe('https://public.example/page');
    expect(resource.body.toString('utf8')).toContain('<title>OK</title>');
  });

  it('stops a streamed HTML body when it crosses the byte cap', async () => {
    let pulls = 0;
    const cancel = jest.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (pulls > 6) controller.close();
      },
      cancel,
    });
    const fetchImpl = jest.fn(async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    await expect(fetchPublicScrape('https://public.example/large', {
      fetchImpl: fetchImpl as typeof undiciFetch,
    })).rejects.toThrow('HTML too large to scrape (limit 4MB)');
    expect(pulls).toBeLessThanOrEqual(MERI_SCRAPE_MAX_HTML_BYTES / (1024 * 1024) + 2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized declared PDF without buffering it', async () => {
    const fetchImpl = jest.fn(async () => new Response(null, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(15 * 1024 * 1024 + 1),
      },
    }));
    await expect(fetchPublicScrape('https://public.example/report.pdf', {
      fetchImpl: fetchImpl as typeof undiciFetch,
    })).rejects.toThrow('PDF too large to extract (limit 15MB)');
  });

  it('keeps one total timeout across the network request and body', async () => {
    const fetchImpl = jest.fn((_url: unknown, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
    await expect(fetchPublicScrape('https://public.example/slow', {
      fetchImpl: fetchImpl as typeof undiciFetch,
      timeoutMs: 5,
    })).rejects.toThrow('Web scrape timed out');

    const bodyFetch = jest.fn((_url: unknown, init: { signal: AbortSignal }) => {
      let sentFirstChunk = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sentFirstChunk) {
            sentFirstChunk = true;
            controller.enqueue(new Uint8Array([65]));
            return;
          }
          return new Promise<void>((resolve) => {
            init.signal.addEventListener('abort', () => {
              controller.error(new Error('aborted while streaming'));
              resolve();
            }, { once: true });
          });
        },
      });
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/html' } }));
    });
    await expect(fetchPublicScrape('https://public.example/slow-body', {
      fetchImpl: bodyFetch as typeof undiciFetch,
      timeoutMs: 5,
    })).rejects.toThrow('Web scrape timed out');
  });
});

describe('scrape_web_page Undici connection acceptance', () => {
  it('blocks a private DNS answer in the real scraper before opening a local connection', async () => {
    let connections = 0;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end('never requested');
    });
    server.on('connection', () => { connections++; });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const destroy = jest.spyOn(Agent.prototype, 'destroy');
    try {
      const lookup: LookupFunction = (_hostname, options, callback) => {
        callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
      };
      await expect(fetchPublicScrape(`http://public.example:${address.port}/private`, {
        lookup,
        timeoutMs: 1000,
      })).rejects.toThrow('Web scrape request failed');
      expect(connections).toBe(0);
      expect(requests).toBe(0);
      expect(destroy).toHaveBeenCalled();
    } finally {
      destroy.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('blocks a local connected peer in real Undici even if a resolver is incorrectly permissive', async () => {
    let connections = 0;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end('never requested');
    });
    server.on('connection', () => { connections++; });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const permissiveLookup: LookupFunction = (_hostname, options, callback) => {
      callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
    };
    const agent = new Agent({
      connect: guardPublicConnector(buildConnector({ lookup: permissiveLookup })),
    });
    try {
      const failure = await undiciFetch(`http://public.example:${address.port}/private`, {
        dispatcher: agent,
        signal: AbortSignal.timeout(1000),
      }).catch((error: unknown) => error);
      expect(String((failure as { cause?: unknown }).cause))
        .toContain('Private/local network connection blocked');
      // The socket is accepted locally, but no HTTP bytes may pass the peer guard.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(connections).toBe(1);
      expect(requests).toBe(0);
    } finally {
      await agent.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('handles real HTTP redirects, streamed size limits, and body timeouts through controlled loopback fixtures', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'http://127.0.0.1/private' });
        response.end();
      } else if (request.url === '/large') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write(Buffer.alloc(MERI_SCRAPE_MAX_HTML_BYTES + 1024));
        response.end();
      } else if (request.url === '/slow') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('partial body');
        // Deliberately leave the response open until the scrape's abort signal fires.
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const localAgent = new Agent();
    // Only this test shim changes the dispatcher and origin. Production calls use
    // fetchPublicScrape's guarded Agent; the local endpoint never leaves loopback.
    const localFetch = ((url: Parameters<typeof undiciFetch>[0], init: Parameters<typeof undiciFetch>[1]) => {
      const pathname = new URL(String(url)).pathname;
      return undiciFetch(`http://127.0.0.1:${address.port}${pathname}`, {
        ...init,
        dispatcher: localAgent,
      });
    }) as typeof undiciFetch;
    try {
      await expect(fetchPublicScrape('https://public.example/redirect', {
        fetchImpl: localFetch,
      })).rejects.toThrow('Private/local network URLs are not allowed');
      expect(requests).toEqual(['/redirect']);

      await expect(fetchPublicScrape('https://public.example/large', {
        fetchImpl: localFetch,
      })).rejects.toThrow('HTML too large to scrape (limit 4MB)');
      expect(requests).toEqual(['/redirect', '/large']);

      await expect(fetchPublicScrape('https://public.example/slow', {
        fetchImpl: localFetch,
        timeoutMs: 250,
      })).rejects.toThrow('Web scrape timed out');
      expect(requests).toEqual(['/redirect', '/large', '/slow']);
    } finally {
      await localAgent.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
