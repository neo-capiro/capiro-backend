import { ALLOWED_HOST_SUFFIXES, isHostAllowed } from './net-guard.js';

/**
 * REGRESSION GUARD — C-SPAN was server-side fetchable with its feature flag OFF.
 *
 * `StreamResolverService` gates C-SPAN page scraping behind RESOLVER_ENABLE_CSPAN
 * (checked in `resolveCspan` and `searchCspan`). But `resolve()` runs a
 * DIRECT-MEDIA PASSTHROUGH first — before host routing and before any flag test —
 * and `classifyMediaUrl` accepts any URL whose path ends in
 * .m3u8/.m3u/.mp3/.aac/.mp4/.ts. Because `c-span.org` and `c-spanvideo.org` sat
 * unconditionally on the host allowlist, this reached C-SPAN's CDN for real:
 *
 *   POST /intel-api/hearings/resolve-stream
 *   { "pageUrl": "https://m3u8-0.c-spanvideo.org/program/program.123.tsc.m3u8" }
 *
 * `cspanManifestForId()` in stream-extractors.ts even hands a caller that exact
 * URL template. Verified against the deployed task definition on 2026-07-29:
 * RESOLVER_ENABLE_CSPAN was not set on `capiro-dev-intel-api`, so the adapter was
 * "off" while this route was open.
 *
 * The fix gates the hosts at the allowlist, which is the single choke point every
 * guarded fetch/probe reaches via `assertUrlAllowed`. These tests assert the gate
 * from both directions and pin the specific bypass shape that was live.
 */
describe('net-guard: C-SPAN is gated behind RESOLVER_ENABLE_CSPAN', () => {
  const ORIGINAL = process.env.RESOLVER_ENABLE_CSPAN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.RESOLVER_ENABLE_CSPAN;
    else process.env.RESOLVER_ENABLE_CSPAN = ORIGINAL;
  });

  const CSPAN_HOSTS = ['c-span.org', 'www.c-span.org', 'c-spanvideo.org', 'm3u8-0.c-spanvideo.org'];

  it('does not carry the C-SPAN hosts on the unconditional allowlist', () => {
    // The literal defect: these two entries used to be in this frozen array.
    expect(ALLOWED_HOST_SUFFIXES).not.toContain('c-span.org');
    expect(ALLOWED_HOST_SUFFIXES).not.toContain('c-spanvideo.org');
  });

  describe.each([undefined, '', '0', 'false', 'no', 'off'])(
    'with RESOLVER_ENABLE_CSPAN=%s (the deployed state)',
    (value) => {
      beforeEach(() => {
        if (value === undefined) delete process.env.RESOLVER_ENABLE_CSPAN;
        else process.env.RESOLVER_ENABLE_CSPAN = value;
      });

      it.each(CSPAN_HOSTS)('rejects %s', (host) => {
        expect(isHostAllowed(host)).toBe(false);
      });
    },
  );

  describe.each(['1', 'true', 'yes', 'on', 'TRUE', ' On '])(
    'with RESOLVER_ENABLE_CSPAN=%s',
    (value) => {
      beforeEach(() => {
        process.env.RESOLVER_ENABLE_CSPAN = value;
      });

      it.each(CSPAN_HOSTS)('admits %s', (host) => {
        expect(isHostAllowed(host)).toBe(true);
      });
    },
  );

  it('keeps every non-C-SPAN host unaffected by the gate', () => {
    delete process.env.RESOLVER_ENABLE_CSPAN;
    for (const host of [
      'www.senate.gov',
      'www-senate-gov-media-srs.akamaized.net',
      'www-senate-gov-msl3archive.akamaized.net',
      'judiciary-f.akamaihd.net',
      'docs.house.gov',
      'api.congress.gov',
      'www.youtube.com',
      'youtu.be',
    ]) {
      expect(isHostAllowed(host)).toBe(true);
    }
  });

  it('does not let a lookalike host slip through the gate', () => {
    process.env.RESOLVER_ENABLE_CSPAN = 'true';
    // Suffix matching must remain anchored on a dot boundary even when enabled.
    expect(isHostAllowed('c-span.org.evil.com')).toBe(false);
    expect(isHostAllowed('notc-span.org')).toBe(false);
    expect(isHostAllowed('xc-spanvideo.org')).toBe(false);
  });
});
