import { ALLOWED_HOST_SUFFIXES, assertUrlAllowed, isHostAllowed, SsrfError } from './net-guard.js';

/**
 * The Florida Channel's Kaltura manifest hosts follow the C-SPAN/googlevideo
 * pattern: never on the frozen allowlist, admitted only while state server
 * capture is enabled, and exact-host only (kaltura.com is a multi-tenant CDN).
 */
describe('net-guard: Florida Channel Kaltura hosts are gated behind LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED', () => {
  const FLAG = 'LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED';
  const ORIGINAL = process.env[FLAG];
  const KALTURA_HOSTS = ['cdnapi.kaltura.com', 'cdnapisec.kaltura.com'];
  const MANIFEST =
    'https://cdnapisec.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_q58g4s8q/format/applehttp/protocol/https/a.m3u8';

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[FLAG];
    else process.env[FLAG] = ORIGINAL;
  });

  it('does not carry the Kaltura hosts on the unconditional allowlist', () => {
    expect(ALLOWED_HOST_SUFFIXES.some((suffix) => suffix.includes('kaltura'))).toBe(false);
  });

  describe.each([undefined, '', '0', 'false', 'off'])('with the switch=%s (default deny)', (value) => {
    beforeEach(() => {
      if (value === undefined) delete process.env[FLAG];
      else process.env[FLAG] = value;
    });

    it.each(KALTURA_HOSTS)('rejects %s', (host) => {
      expect(isHostAllowed(host)).toBe(false);
    });

    it('refuses the manifest URL at the single choke point', async () => {
      await expect(assertUrlAllowed(MANIFEST, { skipDnsCheck: true })).rejects.toBeInstanceOf(
        SsrfError,
      );
    });
  });

  describe.each(['1', 'true', 'yes', 'on', 'enabled'])('with the switch=%s', (value) => {
    beforeEach(() => {
      process.env[FLAG] = value;
    });

    it.each(KALTURA_HOSTS)('admits %s', (host) => {
      expect(isHostAllowed(host)).toBe(true);
    });

    it('admits the manifest URL at the single choke point', async () => {
      await expect(assertUrlAllowed(MANIFEST, { skipDnsCheck: true })).resolves.toBeInstanceOf(URL);
    });

    it('stays exact-host: no subdomains, no other kaltura hosts, no lookalikes', () => {
      for (const host of [
        'x.cdnapisec.kaltura.com',
        'cfvod.kaltura.com',
        'kaltura.com',
        'cdnapisec.kaltura.com.evil.example',
        'notcdnapi.kaltura.com',
      ]) {
        expect(isHostAllowed(host)).toBe(false);
      }
    });
  });

  it('leaves the Florida publisher pages and federal hosts unaffected by the switch', () => {
    delete process.env[FLAG];
    for (const host of ['www.flsenate.gov', 'www.flhouse.gov', 'www.senate.gov', 'docs.house.gov']) {
      expect(isHostAllowed(host)).toBe(true);
    }
  });
});
