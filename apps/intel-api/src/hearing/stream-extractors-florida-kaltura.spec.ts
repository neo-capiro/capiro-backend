/**
 * The Florida Channel (Kaltura partner 2593311) HLS master extraction from the
 * official flsenate.gov / flhouse.gov VideoPlayer pages. The two manifest URLs
 * below are the literal strings observed on the live player pages
 * (flsenate.gov/media/VideoPlayer/6382 and flhouse.gov/VideoPlayer.aspx?eventID=…).
 */
import {
  FLORIDA_CHANNEL_KALTURA_PARTNER_ID,
  isKalturaFloridaChannelMediaUrl,
  parseKalturaHlsManifestUrl,
} from './stream-extractors.js';

const SENATE_MANIFEST =
  'https://cdnapi.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_abohhovv/protocol/https/format/applehttp/a.m3u8';
const HOUSE_MANIFEST =
  'https://cdnapisec.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_q58g4s8q/format/applehttp/protocol/https/a.m3u8';

const SENATE_PLAYER_HTML = `<!DOCTYPE html><html><head><title>The Florida Senate - Video Player</title></head>
<body><div id="player"></div>
<script type="text/javascript">
  var mediaUrl = "${SENATE_MANIFEST}";
  kalturaPlayer.loadMedia({ src: mediaUrl });
</script></body></html>`;

const HOUSE_PLAYER_HTML = `<html><head><title>Florida House of Representatives - Video Player</title></head>
<body>
<video id="videoPlayer" class="video-js" data-setup='{}'>
  <source src='${HOUSE_MANIFEST}' type='application/x-mpegURL' />
</video>
</body></html>`;

describe('parseKalturaHlsManifestUrl', () => {
  it('returns the literal Senate player manifest (protocol before format)', () => {
    expect(parseKalturaHlsManifestUrl(SENATE_PLAYER_HTML)).toBe(SENATE_MANIFEST);
  });

  it('returns the literal House player manifest (format before protocol, cdnapisec host)', () => {
    expect(parseKalturaHlsManifestUrl(HOUSE_PLAYER_HTML)).toBe(HOUSE_MANIFEST);
  });

  it('returns the first Florida Channel manifest when several literals are present', () => {
    const html = `${SENATE_PLAYER_HTML}\n<a href="${HOUSE_MANIFEST}">alt</a>`;
    expect(parseKalturaHlsManifestUrl(html)).toBe(SENATE_MANIFEST);
  });

  it('decodes an entity-encoded query suffix without disturbing the path', () => {
    const html = `<source src="${HOUSE_MANIFEST}?playSessionId=abc&amp;clientTag=html5" />`;
    expect(parseKalturaHlsManifestUrl(html)).toBe(
      `${HOUSE_MANIFEST}?playSessionId=abc&clientTag=html5`,
    );
  });

  it('rejects a manifest from another Kaltura partner', () => {
    const foreign = SENATE_MANIFEST.replace('/p/2593311/', '/p/1234567/');
    expect(parseKalturaHlsManifestUrl(`<script>src="${foreign}"</script>`)).toBeNull();
  });

  it('rejects a non-applehttp playManifest (progressive mp4 / DASH)', () => {
    const mp4 =
      'https://cdnapisec.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_q58g4s8q/format/url/protocol/https/a.mp4';
    const dash =
      'https://cdnapisec.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_q58g4s8q/format/mpegdash/protocol/https/a.m3u8';
    expect(parseKalturaHlsManifestUrl(`"${mp4}" "${dash}"`)).toBeNull();
  });

  it('skips a foreign-partner literal and still returns the Florida Channel one behind it', () => {
    const foreign = SENATE_MANIFEST.replace('/p/2593311/', '/p/99/');
    expect(parseKalturaHlsManifestUrl(`"${foreign}" "${HOUSE_MANIFEST}"`)).toBe(HOUSE_MANIFEST);
  });

  it.each([
    ['empty page', ''],
    ['no manifest', '<html><body>Request Rejected</body></html>'],
    ['http scheme', `"${SENATE_MANIFEST.replace('https://', 'http://')}"`],
    ['other kaltura host', `"${SENATE_MANIFEST.replace('cdnapi.kaltura.com', 'cfvod.kaltura.com')}"`],
    ['lookalike host', `"${SENATE_MANIFEST.replace('cdnapi.kaltura.com', 'cdnapi.kaltura.com.evil.example')}"`],
  ])('returns null for %s', (_label, html) => {
    expect(parseKalturaHlsManifestUrl(html)).toBeNull();
  });
});

describe('isKalturaFloridaChannelMediaUrl', () => {
  it('accepts both observed manifest shapes', () => {
    expect(isKalturaFloridaChannelMediaUrl(SENATE_MANIFEST)).toBe(true);
    expect(isKalturaFloridaChannelMediaUrl(HOUSE_MANIFEST)).toBe(true);
    expect(FLORIDA_CHANNEL_KALTURA_PARTNER_ID).toBe('2593311');
  });

  it.each([
    ['wrong partner', SENATE_MANIFEST.replace('/p/2593311/', '/p/25933110/')],
    ['partner not in position', 'https://cdnapi.kaltura.com/x/p/2593311/playManifest/format/applehttp/a.m3u8'],
    ['no playManifest', 'https://cdnapi.kaltura.com/p/2593311/sp/259331100/format/applehttp/a.m3u8'],
    ['not applehttp', SENATE_MANIFEST.replace('format/applehttp', 'format/mpegdash')],
    ['format before playManifest only', 'https://cdnapi.kaltura.com/p/2593311/format/applehttp/playManifest/entryId/1_x/a.m3u8'],
    ['not a.m3u8', SENATE_MANIFEST.replace('/a.m3u8', '/a.mp4')],
    ['http', SENATE_MANIFEST.replace('https://', 'http://')],
    ['credentials', SENATE_MANIFEST.replace('https://', 'https://user:pw@')],
    ['subdomain of an allowed host', SENATE_MANIFEST.replace('cdnapi.kaltura.com', 'x.cdnapi.kaltura.com')],
    ['other CDN host', SENATE_MANIFEST.replace('cdnapi.kaltura.com', 'cfvod.kaltura.com')],
    ['not a url', 'playManifest/format/applehttp/a.m3u8'],
  ])('rejects %s', (_label, url) => {
    expect(isKalturaFloridaChannelMediaUrl(url)).toBe(false);
  });
});
