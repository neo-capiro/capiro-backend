import {
  classifyMediaUrl,
  congressMeetingApiUrl,
  constructSenateIsvpUrl,
  cspanManifestForId,
  extractCongressVideoUrls,
  extractCspanLdJson,
  extractYoutubeHlsManifest,
  findIsvpInHtml,
  findLiteralMediaInHtml,
  findYoutubeIdInHtml,
  parseCongressEventUrl,
  parseCspanProgramId,
  parseCspanSearchResults,
  parseGooglevideoExpiry,
  parseHearingRowId,
  parseIsvpParams,
  parseIso8601DurationSec,
  senateIsvpFallbackUrls,
} from '../src/hearing/stream-extractors.js';

/**
 * P8 pure extraction functions — tested with sample strings, no network. These
 * back the StreamResolverService adapters (URL parsing, ISVP construction,
 * JSON-LD / hlsManifestUrl mining, congress-event id parsing).
 */

describe('classifyMediaUrl', () => {
  it('classifies by extension, tolerating query/hash', () => {
    expect(classifyMediaUrl('https://x.akamaized.net/a/master.m3u8')).toBe('hls');
    expect(classifyMediaUrl('https://x.akamaized.net/a/master.m3u8?token=1')).toBe('hls');
    expect(classifyMediaUrl('https://x/audio.mp3')).toBe('mp3');
    expect(classifyMediaUrl('https://x/audio.aac')).toBe('mp3');
    expect(classifyMediaUrl('https://x/video.mp4#t=10')).toBe('mp4');
    expect(classifyMediaUrl('https://x/seg.ts')).toBe('mp4');
  });
  it('returns null for a page URL', () => {
    expect(classifyMediaUrl('https://www.c-span.org/program/x/y/12345')).toBeNull();
    expect(classifyMediaUrl('not a url')).toBeNull();
  });
});

describe('senate ISVP', () => {
  it('parses comm+filename from a full isvp URL', () => {
    const p = parseIsvpParams(
      'https://www.senate.gov/isvp/?comm=judiciary&filename=judiciary051926',
    );
    expect(p).toEqual(expect.objectContaining({ comm: 'judiciary', filename: 'judiciary051926' }));
  });
  it('parses from a bare query string', () => {
    expect(parseIsvpParams('?comm=armed&filename=armed010125')).toEqual(
      expect.objectContaining({ comm: 'armed', filename: 'armed010125' }),
    );
  });
  it('returns null when params missing', () => {
    expect(parseIsvpParams('https://www.senate.gov/isvp/?comm=judiciary')).toBeNull();
  });
  it('finds an ISVP embed inside committee-page HTML', () => {
    const html = `<div><iframe src="//www.senate.gov/isvp/?comm=epw&filename=epw062025&type=live"></iframe></div>`;
    expect(findIsvpInHtml(html)).toEqual(
      expect.objectContaining({ comm: 'epw', filename: 'epw062025' }),
    );
  });
  it('constructs the Akamai master.m3u8 from the streamId table', () => {
    // judiciary → 2036788 (proven in the spec)
    expect(constructSenateIsvpUrl({ comm: 'judiciary', filename: 'judiciary051926' })).toBe(
      'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036788/judiciary/judiciary051926/master.m3u8',
    );
    // armed → 2036800
    expect(constructSenateIsvpUrl({ comm: 'armed', filename: 'armed010125' })).toBe(
      'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036800/armed/armed010125/master.m3u8',
    );
  });
  it('returns null for an unknown committee (falls to probes/paste)', () => {
    expect(constructSenateIsvpUrl({ comm: 'nonexistent', filename: 'x' })).toBeNull();
  });
  it('builds allowlisted fallback probe URLs', () => {
    const urls = senateIsvpFallbackUrls({ comm: 'finance', filename: 'finance010125' });
    expect(urls[0]).toContain('www-senate-gov-msl3archive.akamaized.net');
    expect(urls[1]).toContain('finance-f.akamaihd.net');
  });
});

describe('C-SPAN', () => {
  it('parses a program id from a program page URL', () => {
    expect(
      parseCspanProgramId('https://www.c-span.org/program/senate-committee/hearing/679630'),
    ).toBe('679630');
  });
  it('parses a program id from the legacy ?id form', () => {
    expect(parseCspanProgramId('https://www.c-span.org/video/?12345-1/x')).toBe('12345');
  });
  it('returns null for a non-C-SPAN host', () => {
    expect(parseCspanProgramId('https://evil.com/program/x/y/1')).toBeNull();
  });
  it('derives the deterministic m3u8 from an id', () => {
    expect(cspanManifestForId('679630')).toBe(
      'https://m3u8-0.c-spanvideo.org/program/program.679630.tsc.m3u8',
    );
  });
  it('mines contentUrl + name + duration from JSON-LD', () => {
    const html = `
      <script type="application/ld+json">
      {"@type":"VideoObject","name":"Judiciary Hearing","contentUrl":"https://m3u8-0.c-spanvideo.org/program/program.679630.tsc.m3u8","duration":"PT2H5M30S","uploadDate":"2026-05-19"}
      </script>`;
    const ld = extractCspanLdJson(html);
    expect(ld?.contentUrl).toContain('program.679630.tsc.m3u8');
    expect(ld?.title).toBe('Judiciary Hearing');
    expect(ld?.durationSec).toBe(2 * 3600 + 5 * 60 + 30);
    expect(ld?.uploadDate).toBe('2026-05-19');
  });
  it('handles an LD-JSON array', () => {
    const html = `<script type="application/ld+json">[{"@type":"BreadcrumbList"},{"@type":"VideoObject","contentUrl":"https://x/y.m3u8"}]</script>`;
    expect(extractCspanLdJson(html)?.contentUrl).toBe('https://x/y.m3u8');
  });
  it('parses search results into candidates, de-duped by id', () => {
    const html = `
      <a href="https://www.c-span.org/program/senate-committee/hearing/679630">Armed Services Hearing</a>
      <a href="https://www.c-span.org/program/senate-committee/hearing/679630">dup</a>
      <a href="https://www.c-span.org/program/house-committee/markup/700001">Approps Markup</a>`;
    const c = parseCspanSearchResults(html);
    expect(c.map((x) => x.programId)).toEqual(['679630', '700001']);
    expect(c[0]!.title).toBe('Armed Services Hearing');
  });
});

describe('parseIso8601DurationSec', () => {
  it('parses HMS forms', () => {
    expect(parseIso8601DurationSec('PT1H')).toBe(3600);
    expect(parseIso8601DurationSec('PT90M')).toBe(5400);
    expect(parseIso8601DurationSec('PT45S')).toBe(45);
    expect(parseIso8601DurationSec('garbage')).toBeNull();
  });
});

describe('YouTube', () => {
  it('extracts a live hlsManifestUrl and unescapes it', () => {
    const html = `var ytInitialPlayerResponse = {"videoDetails":{"isLiveNow":true},"streamingData":{"hlsManifestUrl":"https:\\/\\/rr5.googlevideo.com\\/api\\/manifest\\/hls_variant\\/expire\\/1799999999\\/ip\\/1.2.3.4\\/file\\/index.m3u8"}};`;
    const info = extractYoutubeHlsManifest(html);
    expect(info?.isLive).toBe(true);
    expect(info?.hlsManifestUrl).toBe(
      'https://rr5.googlevideo.com/api/manifest/hls_variant/expire/1799999999/ip/1.2.3.4/file/index.m3u8',
    );
  });
  it('handles the \\u0026 escaping and reports not-live', () => {
    const html = `{"isLiveNow":false,"hlsManifestUrl":"https://x.googlevideo.com/m.m3u8?a=1\\u0026b=2"}`;
    const info = extractYoutubeHlsManifest(html);
    expect(info?.isLive).toBe(false);
    expect(info?.hlsManifestUrl).toBe('https://x.googlevideo.com/m.m3u8?a=1&b=2');
  });
  it('returns null when no manifest present', () => {
    expect(extractYoutubeHlsManifest('<html>nope</html>')).toBeNull();
  });
  it('parses the googlevideo expiry into an ISO timestamp', () => {
    const iso = parseGooglevideoExpiry(
      'https://rr5.googlevideo.com/api/manifest/hls_variant/expire/1799999999/ip/1.2.3.4/index.m3u8',
    );
    expect(iso).toBe(new Date(1799999999 * 1000).toISOString());
  });
  it('extracts a YouTube video id from an embed / short / watch link', () => {
    expect(
      findYoutubeIdInHtml('<iframe src="https://www.youtube.com/embed/qxl7kz0WQP8"></iframe>'),
    ).toBe('qxl7kz0WQP8');
    expect(findYoutubeIdInHtml('link https://youtu.be/qxl7kz0WQP8 here')).toBe('qxl7kz0WQP8');
    expect(findYoutubeIdInHtml('https://www.youtube.com/watch?v=qxl7kz0WQP8&t=1')).toBe(
      'qxl7kz0WQP8',
    );
  });
});

describe('committee-page generic scan', () => {
  it('finds a data-videofile m3u8 (C-SPAN classic live template)', () => {
    expect(
      findLiteralMediaInHtml(`<div data-videofile='https://x.akamaized.net/live/master.m3u8'>`),
    ).toBe('https://x.akamaized.net/live/master.m3u8');
  });
  it('finds a literal m3u8/mp4 URL', () => {
    expect(findLiteralMediaInHtml('play https://x/stream.m3u8?x=1 now')).toBe(
      'https://x/stream.m3u8?x=1',
    );
    expect(findLiteralMediaInHtml('<source src="https://x/v.mp4">')).toBe('https://x/v.mp4');
  });
  it('returns null when nothing matches', () => {
    expect(findLiteralMediaInHtml('<p>no media here</p>')).toBeNull();
  });
});

describe('congress.gov event', () => {
  it('parses congress/chamber/eventId from an event URL', () => {
    expect(
      parseCongressEventUrl('https://www.congress.gov/event/119th-Congress/house-event/119385'),
    ).toEqual({ congress: 119, chamber: 'house', eventId: '119385' });
    expect(
      parseCongressEventUrl('https://www.congress.gov/event/118th-congress/senate-event/55555'),
    ).toEqual({ congress: 118, chamber: 'senate', eventId: '55555' });
  });
  it('returns null for a non-event congress.gov URL', () => {
    expect(
      parseCongressEventUrl('https://www.congress.gov/bill/119th-congress/house-bill/1'),
    ).toBeNull();
  });
  it('parses our internal cm-{congress}-{eventId} row id', () => {
    expect(parseHearingRowId('cm-119-119385')).toEqual({ congress: 119, eventId: '119385' });
    expect(parseHearingRowId('not-a-row-id')).toBeNull();
  });
  it('builds the api.congress.gov meeting URL with an encoded key', () => {
    const url = congressMeetingApiUrl(
      { congress: 119, chamber: 'House', eventId: '119385' },
      'KEY 1',
    );
    expect(url).toBe(
      'https://api.congress.gov/v3/committee-meeting/119/house/119385?api_key=KEY%201&format=json',
    );
  });
  it('extracts external video links from videos[], skipping the event self-link', () => {
    const payload = {
      committeeMeeting: {
        videos: [
          { url: 'https://www.congress.gov/event/119th-Congress/house-event/119385' },
          { url: 'https://www.youtube.com/watch?v=qxl7kz0WQP8' },
        ],
      },
    };
    expect(extractCongressVideoUrls(payload)).toEqual([
      'https://www.youtube.com/watch?v=qxl7kz0WQP8',
    ]);
  });
  it('returns [] when no videos', () => {
    expect(extractCongressVideoUrls({ committeeMeeting: {} })).toEqual([]);
    expect(extractCongressVideoUrls(null)).toEqual([]);
  });
});
