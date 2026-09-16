import {
  assertUrlAllowed,
  guardedFetchText,
  guardedProbe,
  isHostAllowed,
  isPrivateIp,
  SsrfError,
} from '../src/hearing/net-guard.js';

/**
 * P8 SSRF guard: host allowlist + private/link-local IP deny. Pure functions are
 * tested directly; `assertUrlAllowed` is tested with `skipDnsCheck` (the DNS/IP
 * resolution branch needs the network and is exercised implicitly by the
 * literal-IP cases).
 */
describe('isHostAllowed', () => {
  const ORIGINAL_CSPAN = process.env.RESOLVER_ENABLE_CSPAN;
  afterEach(() => {
    if (ORIGINAL_CSPAN === undefined) delete process.env.RESOLVER_ENABLE_CSPAN;
    else process.env.RESOLVER_ENABLE_CSPAN = ORIGINAL_CSPAN;
  });

  it('allows the gov/broadcast origins + their subdomains', () => {
    expect(isHostAllowed('www.senate.gov')).toBe(true);
    expect(isHostAllowed('judiciary.senate.gov')).toBe(true);
    expect(isHostAllowed('www-senate-gov-media-srs.akamaized.net')).toBe(true);
    expect(isHostAllowed('appropriations.house.gov')).toBe(true);
    expect(isHostAllowed('docs.house.gov')).toBe(true);
    expect(isHostAllowed('www.youtube.com')).toBe(true);
    // googlevideo.com is NOT allowlisted by default (gated behind
    // RESOLVER_ENABLE_YOUTUBE_LIVE — covered by its own test below).
    expect(isHostAllowed('api.congress.gov')).toBe(true);
  });

  it('allows the Florida legislative hosts + their subdomains', () => {
    expect(isHostAllowed('www.flhouse.gov')).toBe(true);
    expect(isHostAllowed('flhouse.gov')).toBe(true);
    expect(isHostAllowed('www.flsenate.gov')).toBe(true);
    expect(isHostAllowed('flsenate.gov')).toBe(true);
  });

  it('denies Florida lookalike hosts (suffix-spoof must stay anchored)', () => {
    expect(isHostAllowed('flhouse.gov.evil.com')).toBe(false);
    expect(isHostAllowed('notflhouse.gov')).toBe(false);
    expect(isHostAllowed('flsenate.gov.evil.com')).toBe(false);
    expect(isHostAllowed('notflsenate.gov')).toBe(false);
  });

  it('gates C-SPAN hosts behind RESOLVER_ENABLE_CSPAN (default DENY)', () => {
    delete process.env.RESOLVER_ENABLE_CSPAN;
    expect(isHostAllowed('www.c-span.org')).toBe(false);
    expect(isHostAllowed('m3u8-0.c-spanvideo.org')).toBe(false);
    process.env.RESOLVER_ENABLE_CSPAN = 'false';
    expect(isHostAllowed('www.c-span.org')).toBe(false);
    expect(isHostAllowed('m3u8-0.c-spanvideo.org')).toBe(false);
  });

  it('admits C-SPAN hosts only with explicit opt-in', () => {
    process.env.RESOLVER_ENABLE_CSPAN = 'true';
    expect(isHostAllowed('www.c-span.org')).toBe(true);
    expect(isHostAllowed('m3u8-0.c-spanvideo.org')).toBe(true);
  });

  it('is case- and trailing-dot-insensitive', () => {
    expect(isHostAllowed('WWW.SENATE.GOV.')).toBe(true);
  });

  it('denies non-allowlisted hosts and lookalikes', () => {
    expect(isHostAllowed('evil.com')).toBe(false);
    expect(isHostAllowed('localhost')).toBe(false);
    // suffix-spoof: allowlisted string is not a real suffix boundary
    expect(isHostAllowed('senate.gov.evil.com')).toBe(false);
    expect(isHostAllowed('notsenate.gov')).toBe(false);
    expect(isHostAllowed('fakec-span.org')).toBe(false);
    expect(isHostAllowed('')).toBe(false);
  });
});

describe('isPrivateIp', () => {
  it('flags loopback / private / link-local / metadata / CGNAT', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.0.0.5')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true); // cloud metadata
    expect(isPrivateIp('100.64.0.1')).toBe(true); // CGNAT
    expect(isPrivateIp('0.0.0.0')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true); // v4-mapped loopback
  });

  it('allows public IPs', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('23.55.100.20')).toBe(false); // akamai-range public
    expect(isPrivateIp('2606:4700::1')).toBe(false); // public v6
  });

  it('returns false for non-IP strings', () => {
    expect(isPrivateIp('www.senate.gov')).toBe(false);
  });
});

describe('assertUrlAllowed', () => {
  it('rejects a non-http(s) scheme', async () => {
    await expect(
      assertUrlAllowed('file:///etc/passwd', { skipDnsCheck: true }),
    ).rejects.toBeInstanceOf(SsrfError);
    await expect(
      assertUrlAllowed('ftp://senate.gov/x', { skipDnsCheck: true }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a non-allowlisted host', async () => {
    await expect(assertUrlAllowed('https://evil.com/x', { skipDnsCheck: true })).rejects.toThrow(
      /not allowed/i,
    );
  });

  it('rejects a raw IP host (never allowlisted — cloud metadata / loopback)', async () => {
    // A bare IP is not an allowlisted host, so it's refused at the allowlist step
    // (before the IP-deny branch). Either way the URL never opens.
    await expect(
      assertUrlAllowed('http://169.254.169.254/latest/meta-data'),
    ).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed('http://127.0.0.1:9200/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('accepts an allowlisted host (allowlist branch, DNS skipped)', async () => {
    const url = await assertUrlAllowed(
      'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036788/judiciary/judiciary051926/master.m3u8',
      { skipDnsCheck: true },
    );
    expect(url.hostname).toBe('www-senate-gov-media-srs.akamaized.net');
  });

  it('rejects the userinfo trick (host parse uses URL.hostname, not the authority)', async () => {
    // `https://***@evil.com/…` — the AUTHORITY starts with an allowlisted
    // string, but URL.hostname is `evil.com`. Must be refused.
    await expect(
      assertUrlAllowed('https://***@evil.com/x', { skipDnsCheck: true }),
    ).rejects.toThrow(/not allowed/i);
    await expect(
      assertUrlAllowed('https://***@169.254.169.254/latest', { skipDnsCheck: true }),
    ).rejects.toThrow(/not allowed/i);
  });

  it('rejects a credentials-bearing lookalike authority at the allowlist step', async () => {
    // URL.hostname is flhouse.gov.evil.com (NOT allowlisted) — refused before
    // any fetch. Credentials on a REAL allowlisted host are rejected by the
    // resolver-side URL parsers (covered in the stream-extractors specs).
    await expect(
      assertUrlAllowed('https://user:pass@flhouse.gov.evil.com/x', { skipDnsCheck: true }),
    ).rejects.toThrow(/not allowed/i);
  });

  it('tightened allowlist: broad *.akamaized.net is gone, pinned Senate hosts remain', () => {
    // The two pinned Senate Akamai hosts the resolver constructs stay allowed…
    expect(isHostAllowed('www-senate-gov-media-srs.akamaized.net')).toBe(true);
    expect(isHostAllowed('www-senate-gov-msl3archive.akamaized.net')).toBe(true);
    // …but any OTHER akamaized.net tenant is now refused (multi-tenant CDN).
    expect(isHostAllowed('attacker-tenant.akamaized.net')).toBe(false);
    expect(isHostAllowed('evil.akamaized.net')).toBe(false);
  });

  it('googlevideo.com is off the allowlist while youtube-live is disabled (default)', () => {
    const prev = process.env.RESOLVER_ENABLE_YOUTUBE_LIVE;
    delete process.env.RESOLVER_ENABLE_YOUTUBE_LIVE;
    try {
      expect(isHostAllowed('rr5---sn-abc.googlevideo.com')).toBe(false);
      process.env.RESOLVER_ENABLE_YOUTUBE_LIVE = 'true';
      expect(isHostAllowed('rr5---sn-abc.googlevideo.com')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.RESOLVER_ENABLE_YOUTUBE_LIVE;
      else process.env.RESOLVER_ENABLE_YOUTUBE_LIVE = prev;
    }
  });
});

/**
 * guardedProbe follows redirects MANUALLY, re-validating each hop, and returns the
 * FINAL post-redirect URL — so a redirect off the allowlist is rejected and the
 * caller gets the validated endpoint (not the original redirecting URL).
 * `fetch` is stubbed; `skipDnsCheck` bypasses the DNS/IP branch (host allowlist
 * still applies).
 */
describe('guardedProbe — redirect handling', () => {
  const realFetch = global.fetch;
  const ORIGINAL_CSPAN = process.env.RESOLVER_ENABLE_CSPAN;
  afterEach(() => {
    global.fetch = realFetch;
    if (ORIGINAL_CSPAN === undefined) delete process.env.RESOLVER_ENABLE_CSPAN;
    else process.env.RESOLVER_ENABLE_CSPAN = ORIGINAL_CSPAN;
  });

  function stubFetch(
    responder: (url: string, method: string) => { status: number; headers?: Record<string, string> },
  ) {
    global.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET') as string;
      const { status, headers } = responder(url, method);
      // Case-insensitive header lookup (mimics the Headers.get contract the code
      // relies on) without depending on a global Headers impl in the test env.
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers ?? {})) lower[k.toLowerCase()] = v;
      return {
        status,
        headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
        body: null,
        text: async () => '',
      } as unknown as Response;
    }) as typeof fetch;
  }

  it('follows an allowed redirect chain and returns the FINAL validated URL', async () => {
    process.env.RESOLVER_ENABLE_CSPAN = 'true'; // C-SPAN hosts are gated — opt in for this chain
    const start =
      'https://www.c-span.org/redirect/program.m3u8';
    const final =
      'https://m3u8-0.c-spanvideo.org/program/program.999.tsc.m3u8';
    stubFetch((url) => {
      if (url === start) return { status: 302, headers: { location: final } };
      if (url === final) return { status: 200, headers: { 'content-type': 'application/x-mpegURL' } };
      return { status: 404 };
    });
    const res = await guardedProbe(start, { skipDnsCheck: true });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.url).toBe(final); // callers get the final, not the original
  });

  it('rejects a redirect to a DENIED host (SsrfError, not "reachable")', async () => {
    process.env.RESOLVER_ENABLE_CSPAN = 'true'; // start host gated — opt in; target stays denied
    const start = 'https://www.c-span.org/program/x/y/123.m3u8';
    stubFetch((url) => {
      if (url === start) return { status: 302, headers: { location: 'https://evil.com/x.m3u8' } };
      return { status: 200 };
    });
    await expect(guardedProbe(start, { skipDnsCheck: true })).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a redirect to an internal IP (169.254 metadata)', async () => {
    const start = 'https://www.senate.gov/x.m3u8';
    stubFetch((url) => {
      if (url === start)
        return { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } };
      return { status: 200 };
    });
    // The metadata host isn't allowlisted → refused at the host-allowlist step.
    await expect(guardedProbe(start, { skipDnsCheck: true })).rejects.toBeInstanceOf(SsrfError);
  });

  it('a non-redirect 200 returns ok + the same (validated) URL', async () => {
    process.env.RESOLVER_ENABLE_CSPAN = 'true'; // C-SPAN hosts are gated — opt in for this probe
    const url = 'https://m3u8-0.c-spanvideo.org/program/program.5.tsc.m3u8';
    stubFetch(() => ({ status: 200, headers: { 'content-type': 'application/x-mpegURL' } }));
    const res = await guardedProbe(url, { skipDnsCheck: true });
    expect(res.ok).toBe(true);
    expect(res.url).toBe(url);
  });
});

describe('guardedFetchText — absolute deadline', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('an ALREADY-EXPIRED deadline never starts a fetch', async () => {
    let called = 0;
    global.fetch = (async () => {
      called++;
      return {
        status: 200,
        headers: { get: () => null },
        body: null,
        text: async () => '',
      } as unknown as Response;
    }) as typeof fetch;
    await expect(
      guardedFetchText('https://www.senate.gov/x', {
        skipDnsCheck: true,
        deadlineAt: Date.now() - 1,
      }),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(called).toBe(0);
  });

  it('a deadline expiring mid-chain stops the next redirect hop from starting', async () => {
    const realNow = Date.now;
    let fake = realNow();
    try {
      Date.now = () => fake;
      let called = 0;
      global.fetch = (async () => {
        called++;
        fake += 5_000; // each hop burns 5s of wall clock
        return {
          status: 302,
          headers: { get: (n: string) => (n.toLowerCase() === 'location' ? 'https://www.senate.gov/next' : null) },
          body: null,
          text: async () => '',
        } as unknown as Response;
      }) as typeof fetch;
      await expect(
        guardedFetchText('https://www.senate.gov/start', {
          skipDnsCheck: true,
          deadlineAt: fake + 8_000, // expires after the second hop starts
        }),
      ).rejects.toBeInstanceOf(SsrfError);
      expect(called).toBe(2); // the third hop never started
    } finally {
      Date.now = realNow;
    }
  });
});
