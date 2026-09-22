/**
 * Browser-source selection for the browser join plan (hearing-capture reliability).
 *
 * Regression under test: `browserJoinPlan` used to hand the browser session the
 * Congress.gov event-LISTING url (`hearing.url`), which carries no playable
 * media. The pre-regression UI resolved a playable Senate ISVP / House /
 * committee source first. This helper restores that by choosing the browser
 * source from already-discovered `hearing_stream_candidate` rows, preferring
 * the STABLE official player/committee page over the listing URL.
 *
 * Rules proven here:
 *  - a first-party official player/committee page (e.g. Senate ISVP page) is
 *    chosen over the Congress.gov listing;
 *  - the browser session opens the STABLE page; fresh media is resolved later
 *    at session creation/refresh, so a stored `media_url` is NOT handed out
 *    (it may be an expired signed/CDN URL);
 *  - `hearing.url` (Congress.gov listing) is only a last-resort fallback;
 *  - a server-side BLOCKED policy is NOT a blanket browser deny — the user may
 *    still open a public official page; REVIEW_REQUIRED candidates are usable;
 *  - no source is ever fabricated from a title; api.* URLs are never returned.
 */
import {
  officialUrlsEquivalent,
  selectBrowserSource,
  selectOfficialPlaybackSource,
  strictOfficialSourceUrl,
  type BrowserSourceCandidate,
} from './live-hearings-browser-source.js';

const FBI_ISVP_PAGE =
  'https://www.senate.gov/isvp/?comm=judiciary&filename=judiciary091526';
const CONGRESS_GOV_LISTING =
  'https://www.congress.gov/event/119th-congress/senate-event/338740';

function candidate(partial: Partial<BrowserSourceCandidate>): BrowserSourceCandidate {
  return {
    provider: 'unknown',
    officialPageUrl: '',
    mediaUrl: null,
    capturePolicy: 'REVIEW_REQUIRED',
    ...partial,
  };
}

describe('selectBrowserSource', () => {
  it('FBI hearing: prefers the stored Senate ISVP player page over the Congress.gov listing', () => {
    // Exact stored candidate shape from the production investigation
    // (event sen-119-338740 / alias cm-119-338740).
    const chosen = selectBrowserSource({
      hearingUrl: CONGRESS_GOV_LISTING,
      candidates: [
        candidate({
          provider: 'senate-isvp',
          officialPageUrl: FBI_ISVP_PAGE,
          capturePolicy: 'REVIEW_REQUIRED',
        }),
      ],
    });
    expect(chosen).toEqual({
      sourceUrl: FBI_ISVP_PAGE,
      sourceKind: 'official_player_page',
      sourceProvider: 'senate-isvp',
    });
  });

  it('opens the stable official player page, NOT a stored (possibly signed) media_url', () => {
    const chosen = selectBrowserSource({
      hearingUrl: CONGRESS_GOV_LISTING,
      candidates: [
        candidate({
          provider: 'senate-isvp',
          officialPageUrl: FBI_ISVP_PAGE,
          mediaUrl:
            'https://www-senate-gov-media-srs.akamaized.net/xyz/judiciary091526/master.m3u8?sig=abc',
          capturePolicy: 'SERVER_CAPTURE_ALLOWED',
        }),
      ],
    });
    expect(chosen?.sourceUrl).toBe(FBI_ISVP_PAGE);
    expect(chosen?.sourceKind).toBe('official_player_page');
    expect(chosen?.sourceProvider).toBe('senate-isvp');
  });

  it('uses a committee-site official page when no chamber player page exists', () => {
    const committeePage =
      'https://www.judiciary.senate.gov/committee-activity/hearings/oversight-of-the-federal-bureau-of-investigation-09-15-2026';
    const chosen = selectBrowserSource({
      hearingUrl: CONGRESS_GOV_LISTING,
      candidates: [
        candidate({
          provider: 'committee-site',
          officialPageUrl: committeePage,
          capturePolicy: 'REVIEW_REQUIRED',
        }),
      ],
    });
    expect(chosen?.sourceUrl).toBe(committeePage);
    expect(chosen?.sourceKind).toBe('official_player_page');
  });

  it('falls back to the official listing page only when no candidate is usable', () => {
    expect(
      selectBrowserSource({ hearingUrl: CONGRESS_GOV_LISTING, candidates: [] }),
    ).toEqual({
      sourceUrl: CONGRESS_GOV_LISTING,
      sourceKind: 'official_listing_page',
      sourceProvider: null,
    });
  });

  it('a server-side BLOCKED policy is not a blanket browser deny for a public official page', () => {
    const chosen = selectBrowserSource({
      hearingUrl: CONGRESS_GOV_LISTING,
      candidates: [
        candidate({
          provider: 'senate-isvp',
          officialPageUrl: FBI_ISVP_PAGE,
          capturePolicy: 'BLOCKED',
        }),
      ],
    });
    expect(chosen?.sourceUrl).toBe(FBI_ISVP_PAGE);
  });

  it('skips candidates with no official page and no usable identity', () => {
    const chosen = selectBrowserSource({
      hearingUrl: CONGRESS_GOV_LISTING,
      candidates: [candidate({ provider: 'unknown', officialPageUrl: '' })],
    });
    expect(chosen?.sourceUrl).toBe(CONGRESS_GOV_LISTING);
    expect(chosen?.sourceKind).toBe('official_listing_page');
  });

  it('returns null when there is no candidate and no hearing url', () => {
    expect(selectBrowserSource({ hearingUrl: null, candidates: [] })).toBeNull();
  });

  it('never returns an api.* metadata URL as the browser source', () => {
    const chosen = selectBrowserSource({
      hearingUrl: 'https://api.congress.gov/v3/hearing/119/senate/338740',
      candidates: [],
    });
    expect(chosen).toBeNull();
  });

  it('ranks a genuine player page above a Congress.gov listing candidate regardless of stored order', () => {
    const chosen = selectBrowserSource({
      hearingUrl: CONGRESS_GOV_LISTING,
      candidates: [
        candidate({
          provider: 'congress-gov',
          officialPageUrl: CONGRESS_GOV_LISTING,
          capturePolicy: 'REVIEW_REQUIRED',
        }),
        candidate({
          provider: 'senate-isvp',
          officialPageUrl: FBI_ISVP_PAGE,
          capturePolicy: 'REVIEW_REQUIRED',
        }),
      ],
    });
    expect(chosen?.sourceUrl).toBe(FBI_ISVP_PAGE);
    expect(chosen?.sourceKind).toBe('official_player_page');
  });

  it('a known listing host is never a player even when the provider claims committee-site', () => {
    // Mislabeled row: provider says committee-site but the URL is Congress.gov.
    // The listing host must win classification so the Senate player still wins.
    const chosen = selectBrowserSource({
      hearingUrl: CONGRESS_GOV_LISTING,
      candidates: [
        candidate({
          provider: 'committee-site',
          officialPageUrl: CONGRESS_GOV_LISTING,
          capturePolicy: 'REVIEW_REQUIRED',
        }),
        candidate({
          provider: 'senate-isvp',
          officialPageUrl: FBI_ISVP_PAGE,
          capturePolicy: 'REVIEW_REQUIRED',
        }),
      ],
    });
    expect(chosen?.sourceUrl).toBe(FBI_ISVP_PAGE);
    expect(chosen?.sourceKind).toBe('official_player_page');
  });

  it('recognizes Florida chamber watch pages as official player pages', () => {
    const flWatch = 'https://thefloridachannel.org/videos/092626-senate-session/';
    const chosen = selectBrowserSource({
      hearingUrl: 'https://www.flsenate.gov/Calendar',
      candidates: [
        candidate({
          provider: 'florida-senate',
          officialPageUrl: flWatch,
          capturePolicy: 'REVIEW_REQUIRED',
        }),
      ],
    });
    expect(chosen?.sourceUrl).toBe(flWatch);
    expect(chosen?.sourceKind).toBe('official_player_page');
    expect(chosen?.sourceProvider).toBe('florida-senate');
  });

  it('rejects non-http(s) and malformed candidate pages instead of treating them as usable', () => {
    const chosen = selectBrowserSource({
      hearingUrl: CONGRESS_GOV_LISTING,
      candidates: [
        candidate({ provider: 'committee-site', officialPageUrl: 'javascript:alert(1)' }),
        candidate({ provider: 'committee-site', officialPageUrl: 'not a url' }),
        candidate({ provider: 'committee-site', officialPageUrl: 'data:text/html,<b>x</b>' }),
      ],
    });
    expect(chosen?.sourceUrl).toBe(CONGRESS_GOV_LISTING);
    expect(chosen?.sourceKind).toBe('official_listing_page');
  });
});


describe('strict official external links', () => {
  it.each([
    'http://www.flsenate.gov/watch',
    'https://user:pw@www.flsenate.gov/watch',
    'https://www.flsenate.gov:8443/watch',
    'https://localhost/watch',
    'https://127.0.0.1/watch',
    'https://10.0.0.8/watch',
    'https://www.flsenate.gov/live/master.m3u8',
    'https://www.flsenate.gov/watch?token=secret',
    'https://www.flsenate.gov/watch?auth=secret',
    'https://www.flsenate.gov/watch?auth_token=secret',
    'https://www.flsenate.gov/watch?access_token=secret',
    'https://www.flsenate.gov/watch?jwt=secret',
    'https://www.flsenate.gov/watch?hdnea=secret',
    'https://www.flsenate.gov/watch?hdnts=secret',
    'https://thefloridachannel.org/videos/feed/',
    'https://api.congress.gov/v3/hearing/119/house/119504',
  ])('omits unsafe or non-event URL %s', (url) => {
    expect(strictOfficialSourceUrl(url, 'florida-senate')).toBeNull();
  });

  it('rejects unknown provider identities even on a known official host', () => {
    expect(strictOfficialSourceUrl('https://www.flsenate.gov/watch', 'unknown')).toBeNull();
  });

  it('canonicalizes equivalent source identities for de-duplication', () => {
    expect(
      officialUrlsEquivalent(
        'HTTPS://WWW.FLSENATE.GOV:443/Media/VideoPlayer/1/#player',
        'https://www.flsenate.gov/Media/VideoPlayer/1',
      ),
    ).toBe(true);
  });

  it('selects a stable publisher page and never returns the stored media URL', () => {
    const selected = selectOfficialPlaybackSource({
      hearingUrl: 'https://www.flsenate.gov/Calendar/',
      candidates: [
        candidate({
          id: 'fl-1',
          provider: 'florida-senate',
          officialPageUrl: 'https://www.flsenate.gov/Media/VideoPlayer/6382/',
          mediaUrl: 'https://cdn.example/live/master.m3u8?token=secret',
          capturePolicy: 'REVIEW_REQUIRED',
          priority: 1,
        }),
      ],
    });
    expect(selected).toEqual({
      sourceUrl: 'https://www.flsenate.gov/Media/VideoPlayer/6382',
      sourceKind: 'official_player_page',
      sourceProvider: 'florida-senate',
    });
    expect(JSON.stringify(selected)).not.toContain('m3u8');
  });

  it.each(['BLOCKED', 'LICENSE_REQUIRED'])(
    'keeps a safe official playback link visible when capture policy is %s',
    (capturePolicy) => {
      expect(
        selectOfficialPlaybackSource({
          hearingUrl: 'https://www.flsenate.gov/Calendar/',
          candidates: [
            candidate({
              provider: 'florida-senate',
              officialPageUrl: 'https://www.flsenate.gov/Media/VideoPlayer/6382',
              capturePolicy,
            }),
          ],
        }),
      ).toEqual({
        sourceUrl: 'https://www.flsenate.gov/Media/VideoPlayer/6382',
        sourceKind: 'official_player_page',
        sourceProvider: 'florida-senate',
      });
    },
  );
});
