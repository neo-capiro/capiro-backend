/**
 * SERVICE-level tests for StreamResolverService's two bounded source chains,
 * with the network layer (net-guard) mocked — no real I/O:
 *
 *   Federal (observed live chain, Congress event 119529):
 *     congress.gov/event/119th-Congress/house-event/119529
 *       → docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529
 *       → naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048
 *         (links the EXACT docs 119529 + embeds YouTube a-NiTQf_8Zs)
 *
 *   Florida (observed live chain, MeetingId 15193):
 *     flhouse.gov meetingnotice?MeetingId=15193
 *       → notice date 2026-02-26
 *       → houseschedule.aspx?date=2-26-2026
 *       → VideoPlayer.aspx?eventID=11179 (same schedule-event block)
 *
 * The HTML fixtures are REDUCED-BUT-VERBATIM from the real downloaded public
 * pages root supplied (official-fl-house-notice-15193.html /
 * official-fl-house-schedule-20260226.html). No title matching, no hardcoded
 * event ids in the resolver logic — the ids below are INPUTS and fixture
 * contents, exactly what the live pages carried.
 */
import { ConfigService } from '@nestjs/config';
import type { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { StreamResolverService } from './stream-resolver.service.js';

// ── net-guard mock ──────────────────────────────────────────────────────────
// jest.mock is hoisted; the factory must not reference outer variables, so the
// mock fns are exposed on the mocked module itself.
jest.mock('./net-guard.js', () => ({
  guardedFetchText: jest.fn(),
  guardedProbe: jest.fn(),
  assertUrlAllowed: jest.fn(async () => new URL('https://www.flhouse.gov/')),
  SsrfError: class SsrfError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SsrfError';
    }
  },
}));
import * as netGuard from './net-guard.js';

const fetchMock = netGuard.guardedFetchText as unknown as jest.Mock;
const probeMock = netGuard.guardedProbe as unknown as jest.Mock;

// ── fixtures (reduced-verbatim real HTML) ───────────────────────────────────

/** Real notice 15193 slice: classed dt/dd, nested <time datetime>, End Date trap. */
const FL_NOTICE_HTML = `<div class="cm_contents">
    <dl aria-label="Meeting Information">
        <dt class="textBold label">Start Date and Time:</dt>
        <dd class="value">

            <time datetime="2026-02-26T08:00:00-05:00">
            Thursday, February 26, 2026 8:00 AM</time>

                </dd>

        <dt class="textBold label">End Date and Time:</dt>
        <dd class="value">

            <time datetime="2026-02-26T12:00:00-05:00">
                Thursday, February 26, 2026 12:00 PM</time>

            </dd>
    </dl>
</div>`;

/**
 * Real schedule 2026-02-26 slice: preceding neighbor Commerce event
 * (MeetingId=15186 → eventID=11185) BEFORE the target State Affairs event
 * (MeetingId=15193 → eventID=11179), nested structure preserved.
 */
const FL_SCHEDULE_HTML = `<div class="schedule-list">

<div class="row row-striped schedule-event">
    <div class="col-12">
        <h2 class="scheduled-event-title">Commerce Committee</h2>
        <div class="meeting-info"><span>02/26/2026</span></div>
        <div>
            <ul class="event-action-list">
                <li class="">
                    <a class="btn btn-warning btn-meeting-notice" href="/Sections/Committees/meetingnotice.aspx?MeetingId=15186">Meeting Notice</a>
                </li>
                <li class="">
                </li>
<li>
    <a data-eventid="11185"
        data-title="House Commerce Committee"
        role="button"
        class="btn on-demand-status"
        href="/VideoPlayer.aspx?eventID=11185"
        title="Watch Archived Stream">
        Watch Archived Stream
    </a>
</li>
            </ul>
        </div>
</div>
</div>

<div class="row row-striped schedule-event">
    <div class="col-12">
        <h2 class="scheduled-event-title">State Affairs Committee</h2>
        <div class="meeting-info"><span>02/26/2026</span></div>
        <div>
            <ul class="event-action-list">
                <li class="">
                    <a class="btn btn-warning btn-meeting-notice" href="/Sections/Committees/meetingnotice.aspx?MeetingId=15193">Meeting Notice</a>
                </li>
                <li class="">
                </li>
<li>
    <a data-eventid="11179"
        data-title="House State Affairs Committee"
        role="button"
        class="btn on-demand-status"
        href="/VideoPlayer.aspx?eventID=11179"
        title="Watch Archived Stream">
        Watch Archived Stream
    </a>
</li>
            </ul>
        </div>
</div>
</div>

</div>`;

/** docs.house.gov event page linking the owning committee's event page. */
const DOCS_EVENT_HTML = `<html><body>
  <a href="https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048">
    Natural Resources Committee Hearing
  </a>
  <a href="https://www.congress.gov/event/119th-congress/house-event/119529">Congress.gov</a>
</body></html>`;

/**
 * The ACTUAL live docs event page shape (event 119529): the only committee
 * pointer is the "Visit Committee Site" anchor to the committee HOMEPAGE over
 * http with a bare origin (no character after the final slash).
 */
const DOCS_HOMEPAGE_HTML = `<html><body>
  <div class="button-row">
    <a id="MainContent_LinkButtonDownloadMtgXML" class="btn" href="javascript:__doPostBack(&#39;ctl00$MainContent$LinkButtonDownloadMtgXML&#39;,&#39;&#39;)">Download Meeting XML (.xml)</a>&nbsp;&nbsp;
    <a id="MainContent_HyperLinKCommittee" class="btn" href="http://naturalresources.house.gov/" target="_blank">Visit Committee Site</a>
  </div>
  <div class="footer-text">
    <a href="http://clerk.house.gov/" title="Office of the Clerk">Office of the Clerk</a>
    <a href="https://www.house.gov/accessibility" target="_blank">Accessibility</a>
  </div>
</body></html>`;

/** The committee HOMEPAGE: same-origin event link, no exact-id backlink. */
const COMMITTEE_HOMEPAGE_HTML = `<html><body>
  <a href="/calendar/eventsingle.aspx?EventID=419048">Oversight Hearing</a>
  <a href="/about">About</a>
  <a href="https://waysandmeans.house.gov/calendar/eventsingle.aspx?EventID=777">neighbor committee</a>
</body></html>`;

/**
 * The committee event page: links the EXACT docs repository event 119529 and
 * embeds YouTube a-NiTQf_8Zs (the observed live chain).
 */
const COMMITTEE_EVENT_HTML = `<html><body>
  <h1>Oversight Hearing</h1>
  <iframe src="https://www.youtube.com/embed/a-NiTQf_8Zs"></iframe>
  <a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529">House Repository</a>
</body></html>`;

/** A NEIGHBOR committee event page — different docs EventID, different embed. */
const NEIGHBOR_EVENT_HTML = `<html><body>
  <h1>Unrelated Hearing</h1>
  <iframe src="https://www.youtube.com/embed/ZZZZZZZZZZZ"></iframe>
  <a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=999999">House Repository</a>
</body></html>`;

const CONGRESS_EVENT_URL = 'https://www.congress.gov/event/119th-Congress/house-event/119529';
const DOCS_URL = 'https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529';
const COMMITTEE_URL = 'https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048';
const FL_NOTICE_URL =
  'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15193';
const FL_SCHEDULE_URL =
  'https://www.flhouse.gov/Sections/HouseSchedule/houseschedule.aspx?date=2-26-2026';

// ── harness ─────────────────────────────────────────────────────────────────

function makeService(env: Record<string, string | undefined> = {}): StreamResolverService {
  const config = new ConfigService(env);
  const source = {
    getCommitteeHearingById: jest.fn(async () => null),
  } as unknown as SourceDataRepository;
  return new StreamResolverService(config, source);
}

function okHtml(url: string, text: string) {
  return { status: 200, url, text };
}

beforeEach(() => {
  fetchMock.mockReset();
  probeMock.mockReset();
  fetchMock.mockRejectedValue(new Error(`unexpected fetch: no mock registered`));
  probeMock.mockRejectedValue(new Error(`unexpected probe: no mock registered`));
});

// ── Federal chain: Congress 119529 → docs → committee ───────────────────────

describe('federal House fallback chain (Congress event 119529)', () => {
  it('resolves WITHOUT a Congress API key via docs.house.gov → committee exact-id match', async () => {
    const svc = makeService(); // no CONGRESS_API_KEY
    fetchMock.mockImplementation(async (url: string) => {
      if (url === DOCS_URL) return okHtml(url, DOCS_EVENT_HTML);
      if (url === COMMITTEE_URL) return okHtml(url, COMMITTEE_EVENT_HTML);
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    // YouTube extraction is disabled by default → the verified committee
    // page's EXACT YouTube embed comes back as a stable REFERENCE (never a
    // neighbor page, never a made-up or unprobed media URL).
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe('https://www.youtube.com/watch?v=a-NiTQf_8Zs');
    expect(r.note).toContain('official player');
    expect(r.note).toContain('tab audio');
    // Exactly two budgeted fetches: docs page + committee page (the verified
    // HTML is used IN PLACE — no recursion, no third refetch).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the official committee page reference when no YouTube embed exists', async () => {
    const svc = makeService();
    const noEmbed = `<html><body>
      <h1>Oversight Hearing</h1>
      <a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529">House Repository</a>
    </body></html>`;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === DOCS_URL) return okHtml(url, DOCS_EVENT_HTML);
      if (url === COMMITTEE_URL) return okHtml(url, noEmbed);
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe(COMMITTEE_URL);
  });

  it('follows the ACTUAL live chain: docs → committee HOMEPAGE → same-origin event page', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === DOCS_URL) return okHtml(url, DOCS_HOMEPAGE_HTML);
      if (url === 'https://naturalresources.house.gov/') return okHtml(url, COMMITTEE_HOMEPAGE_HTML);
      if (url === COMMITTEE_URL) return okHtml(url, COMMITTEE_EVENT_HTML);
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe('https://www.youtube.com/watch?v=a-NiTQf_8Zs');
    // docs + homepage + event page = 3 budgeted fetches; the off-origin
    // neighbor committee link on the homepage is never fetched.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain(
      'https://waysandmeans.house.gov/calendar/eventsingle.aspx?EventID=777',
    );
  });

  it('serves a verified reference from the event-id cache with ZERO network calls', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === DOCS_URL) return okHtml(url, DOCS_EVENT_HTML);
      if (url === COMMITTEE_URL) return okHtml(url, COMMITTEE_EVENT_HTML);
      throw new Error(`unexpected fetch ${url}`);
    });
    const first = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    expect(first.reference).toBe('https://www.youtube.com/watch?v=a-NiTQf_8Zs');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second resolve of the SAME event id: cache hit, no additional fetch.
    const second = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    expect(second.reference).toBe('https://www.youtube.com/watch?v=a-NiTQf_8Zs');
    expect(second.note).toContain('cached');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expires a cached reference after the 6h TTL', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === DOCS_URL) return okHtml(url, DOCS_EVENT_HTML);
      if (url === COMMITTEE_URL) return okHtml(url, COMMITTEE_EVENT_HTML);
      throw new Error(`unexpected fetch ${url}`);
    });
    await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    expect(svc.cachedHouseFallbackRef('119529')).toBe(
      'https://www.youtube.com/watch?v=a-NiTQf_8Zs',
    );
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 6 * 60 * 60 * 1000 + 1;
      expect(svc.cachedHouseFallbackRef('119529')).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('bounds the cache at 64 entries with FIFO eviction', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) => {
      const m = url.match(/EventID=(\d+)/);
      if (url.startsWith('https://docs.house.gov/') && m) {
        return okHtml(
          url,
          `<a href="https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=4${m[1]}">c</a>`,
        );
      }
      if (url.includes('eventsingle')) {
        const ev = url.match(/EventID=4(\d+)/)![1]!;
        return okHtml(
          url,
          `<a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=${ev}">r</a>`,
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    for (let i = 0; i < 70; i++) {
      await svc.resolve({
        pageUrl: `https://www.congress.gov/event/119th-Congress/house-event/${100000 + i}`,
      });
    }
    // The oldest entries were evicted; the most recent survive.
    expect(svc.cachedHouseFallbackRef('100000')).toBeNull();
    expect(svc.cachedHouseFallbackRef('100069')).not.toBeNull();
  });

  it('accepts a DIRECT docs.house.gov event link (no congress.gov hop)', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === DOCS_URL) return okHtml(url, DOCS_EVENT_HTML);
      if (url === COMMITTEE_URL) return okHtml(url, COMMITTEE_EVENT_HTML);
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: DOCS_URL });
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe('https://www.youtube.com/watch?v=a-NiTQf_8Zs');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('runs the same fallback when the Congress API FAILS (videos lookup error)', async () => {
    const svc = makeService({ CONGRESS_API_KEY: 'test-key' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://api.congress.gov/')) throw new Error('API 500');
      if (url === DOCS_URL) return okHtml(url, DOCS_EVENT_HTML);
      if (url === COMMITTEE_URL) return okHtml(url, COMMITTEE_EVENT_HTML);
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe('https://www.youtube.com/watch?v=a-NiTQf_8Zs');
  });

  it('runs the same fallback when videos[] is EMPTY', async () => {
    const svc = makeService({ CONGRESS_API_KEY: 'test-key' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://api.congress.gov/')) {
        return okHtml(url, JSON.stringify({ committeeMeeting: { videos: [] } }));
      }
      if (url === DOCS_URL) return okHtml(url, DOCS_EVENT_HTML);
      if (url === COMMITTEE_URL) return okHtml(url, COMMITTEE_EVENT_HTML);
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe('https://www.youtube.com/watch?v=a-NiTQf_8Zs');
  });

  it('preserves the verified YouTube REFERENCE when extraction is disabled (default)', async () => {
    const svc = makeService({ CONGRESS_API_KEY: 'test-key' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://api.congress.gov/')) {
        return okHtml(
          url,
          JSON.stringify({
            committeeMeeting: {
              videos: [{ url: 'https://www.youtube.com/watch?v=a-NiTQf_8Zs' }],
            },
          }),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe('https://www.youtube.com/watch?v=a-NiTQf_8Zs');
    expect(r.note).toContain('RESOLVER_ENABLE_YOUTUBE_LIVE');
  });

  it('REJECTS a neighbor committee event page (different docs EventID)', async () => {
    const svc = makeService();
    const docsWithTwoLinks = `<html><body>
      <a href="https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=111111">neighbor</a>
      <a href="https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048">target</a>
    </body></html>`;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === DOCS_URL) return okHtml(url, docsWithTwoLinks);
      if (url.includes('EventID=111111')) return okHtml(url, NEIGHBOR_EVENT_HTML);
      if (url === COMMITTEE_URL) return okHtml(url, COMMITTEE_EVENT_HTML);
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    // The neighbor (EventID=999999 back-link) must NOT be accepted; the chain
    // continues to the exact-match page.
    expect(r.reference).toBe('https://www.youtube.com/watch?v=a-NiTQf_8Zs');
    expect(r.reference).not.toContain('111111');
  });

  it('bounds the chain by the page budget and STOPS calling the network once exhausted', async () => {
    const svc = makeService();
    // Docs page links 10 committee pages, none of which ever matches.
    const links = Array.from(
      { length: 10 },
      (_, i) =>
        `<a href="https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=${200000 + i}">e${i}</a>`,
    ).join('\n');
    const docsHtml = `<html><body>${links}</body></html>`;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === DOCS_URL) return okHtml(url, docsHtml);
      if (url.includes('eventsingle')) return okHtml(url, NEIGHBOR_EVENT_HTML);
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    expect(r.status).toBe('unresolvable');
    // 1 docs fetch + at most 7 committee fetches = 8 total (maxPages default).
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8);
    const callsAfterExhaustion = fetchMock.mock.calls.length;
    // A second resolve with an already-dead budget must not sneak extra calls
    // into the SAME chain — here we simply assert the count is stable when the
    // service is asked again (fresh chain, fresh budget, but bounded again).
    await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    expect(fetchMock.mock.calls.length - callsAfterExhaustion).toBeLessThanOrEqual(8);
  });

  it('enforces the fallback DEADLINE across fetches (clock advances between calls)', async () => {
    const svc = makeService();
    const links = Array.from(
      { length: 6 },
      (_, i) =>
        `<a href="https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=${300000 + i}">e${i}</a>`,
    ).join('\n');
    const docsHtml = `<html><body>${links}</body></html>`;
    const realNow = Date.now;
    let fake = realNow();
    try {
      Date.now = () => fake;
      fetchMock.mockImplementation(async (url: string) => {
        // Every network call burns 9s of wall clock → the 20s deadline lets
        // the docs page + ONE committee fetch through, then latches.
        fake += 9_000;
        if (url === DOCS_URL) return okHtml(url, docsHtml);
        if (url.includes('eventsingle')) return okHtml(url, NEIGHBOR_EVENT_HTML);
        throw new Error(`unexpected fetch ${url}`);
      });
      const r = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
      expect(r.status).toBe('unresolvable');
      // docs (t=9s) + two committee fetches (t=18s, t=27s — started at 18s,
      // before the deadline); the next would start at 27s — past the 20s
      // deadline — so the chain stops at 3 fetches.
      expect(fetchMock.mock.calls.length).toBe(3);
    } finally {
      Date.now = realNow;
    }
  });

  it('returns null-ish unresolvable (not throw) when the docs fetch itself fails', async () => {
    const svc = makeService();
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const r = await svc.resolve({ pageUrl: CONGRESS_EVENT_URL });
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe(CONGRESS_EVENT_URL);
  });
});

// ── Florida chain: notice 15193 → date → schedule → player 11179 ────────────

describe('florida House notice chain (MeetingId 15193)', () => {
  it('resolves the notice to the official VideoPlayer reference via the real chain', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === FL_NOTICE_URL) return okHtml(url, FL_NOTICE_HTML);
      if (url === FL_SCHEDULE_URL) return okHtml(url, FL_SCHEDULE_HTML);
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: FL_NOTICE_URL });
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe('https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179');
    expect(r.note).toContain('official player');
    expect(r.note).toContain('tab audio');
    // Never the preceding neighbor's player.
    expect(r.reference).not.toContain('11185');
    // Exactly two fetches: notice + schedule.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetches Florida pages with the narrow honest node UA (the WAF rejects the Chrome UA)', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === FL_NOTICE_URL) return okHtml(url, FL_NOTICE_HTML);
      if (url === FL_SCHEDULE_URL) return okHtml(url, FL_SCHEDULE_HTML);
      throw new Error(`unexpected fetch ${url}`);
    });
    await svc.resolve({ pageUrl: FL_NOTICE_URL });
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers?.['user-agent']).toBe('node');
    }
  });

  it('reports a publisher "Request Rejected" page TRUTHFULLY (not as a missing date)', async () => {
    const svc = makeService();
    const rejected =
      '<html><head><title>Request Rejected</title></head><body>Request Rejected</body></html>';
    fetchMock.mockImplementation(async (url: string) => okHtml(url, rejected));
    const r = await svc.resolve({ pageUrl: FL_NOTICE_URL });
    expect(r.status).toBe('unresolvable');
    expect(r.note).toContain('rejected');
    expect(r.note).not.toContain('lacks a qualified calendar date');
    // The schedule page is never fetched after a rejected notice.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a usable error (not a crash) when the schedule has no pairing', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === FL_NOTICE_URL) return okHtml(url, FL_NOTICE_HTML);
      if (url === FL_SCHEDULE_URL) {
        return okHtml(url, '<div class="schedule-list"><p>No events</p></div>');
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: FL_NOTICE_URL });
    expect(r.status).toBe('unresolvable');
    expect(r.note).toContain('15193');
  });

  it('fails closed on an unrecognized notice URL shape', async () => {
    const svc = makeService();
    const r = await svc.resolve({ pageUrl: 'https://www.flhouse.gov/Sections/Committees/notices.aspx' });
    expect(r.status).toBe('unresolvable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a KNOWN Florida House VideoPlayer URL returns the stable player reference (never "unrecognized notice")', async () => {
    const svc = makeService();
    const r = await svc.resolve({ pageUrl: 'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179' });
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe('https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179');
    expect(r.note).toContain('official player');
    expect(r.note).toContain('tab audio');
    expect(r.note).not.toContain('Unrecognized');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Florida Senate media player ─────────────────────────────────────────────

describe('florida Senate media player (event 6382)', () => {
  it('returns the stable official player reference with NO network call', async () => {
    const svc = makeService();
    const r = await svc.resolve({ pageUrl: 'https://www.flsenate.gov/media/VideoPlayer/6382' });
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe('https://www.flsenate.gov/media/VideoPlayer/6382');
    expect(r.note).toContain('official player');
    expect(r.note).toContain('tab audio');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('fails closed on an unrecognized flsenate path', async () => {
    const svc = makeService();
    const r = await svc.resolve({ pageUrl: 'https://www.flsenate.gov/media/VideoPlayer/' });
    expect(r.status).toBe('unresolvable');
    expect(r.note).toContain('Unrecognized Florida Senate');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Florida players with state server capture ON ────────────────────────────

describe('florida players with LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED=true', () => {
  const FLAG = 'LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED';
  const previous = process.env[FLAG];
  const SENATE_PLAYER = 'https://www.flsenate.gov/media/VideoPlayer/6382';
  const SENATE_MANIFEST =
    'https://cdnapi.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_abohhovv/protocol/https/format/applehttp/a.m3u8';
  const HOUSE_PLAYER = 'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179';
  const HOUSE_MANIFEST =
    'https://cdnapisec.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_q58g4s8q/format/applehttp/protocol/https/a.m3u8';
  const playerHtml = (manifest: string) =>
    `<html><head><title>Video Player</title></head><body><script>var src = "${manifest}";</script></body></html>`;
  const FLORIDA_MEDIA = (url: string) => ({
    url,
    kind: 'hls',
    provider: 'florida-channel-kaltura',
    ipBound: false,
  });

  beforeEach(() => {
    process.env[FLAG] = 'true';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous;
  });

  it('resolves the Senate player page to The Florida Channel HLS master via the guarded node-UA fetch', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === SENATE_PLAYER) return okHtml(url, playerHtml(SENATE_MANIFEST));
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: SENATE_PLAYER });
    expect(r.status).toBe('resolved');
    expect(r.media).toEqual(FLORIDA_MEDIA(SENATE_MANIFEST));
    expect(r.reference).toBe(SENATE_PLAYER);
    expect(r.meta?.title).toBe('Video Player');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]?.headers?.['user-agent']).toBe('node');
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('resolves a direct House VideoPlayer page the same way', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === HOUSE_PLAYER) return okHtml(url, playerHtml(HOUSE_MANIFEST));
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: HOUSE_PLAYER });
    expect(r.status).toBe('resolved');
    expect(r.media).toEqual(FLORIDA_MEDIA(HOUSE_MANIFEST));
    expect(r.reference).toBe(HOUSE_PLAYER);
  });

  it('follows the House notice chain to the paired player and extracts its manifest (three fetches)', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === FL_NOTICE_URL) return okHtml(url, FL_NOTICE_HTML);
      if (url === FL_SCHEDULE_URL) return okHtml(url, FL_SCHEDULE_HTML);
      if (url === HOUSE_PLAYER) return okHtml(url, playerHtml(HOUSE_MANIFEST));
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await svc.resolve({ pageUrl: FL_NOTICE_URL });
    expect(r.status).toBe('resolved');
    expect(r.media?.url).toBe(HOUSE_MANIFEST);
    expect(r.reference).toBe(HOUSE_PLAYER);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('falls back to the verified player reference when the page carries no Florida Channel manifest', async () => {
    const svc = makeService();
    const foreign = SENATE_MANIFEST.replace('/p/2593311/', '/p/1234567/');
    fetchMock.mockImplementation(async (url: string) => okHtml(url, playerHtml(foreign)));
    const r = await svc.resolve({ pageUrl: SENATE_PLAYER });
    expect(r.status).toBe('unresolvable');
    expect(r.media).toBeUndefined();
    expect(r.reference).toBe(SENATE_PLAYER);
    expect(r.note).toContain('official player');
  });

  it('reports a publisher "Request Rejected" player page truthfully', async () => {
    const svc = makeService();
    fetchMock.mockImplementation(async (url: string) =>
      okHtml(url, '<html><head><title>Request Rejected</title></head><body>Request Rejected</body></html>'),
    );
    const r = await svc.resolve({ pageUrl: SENATE_PLAYER });
    expect(r.status).toBe('unresolvable');
    expect(r.note).toContain('publisher bot policy');
    expect(r.reference).toBe(SENATE_PLAYER);
  });

  it('reports a network-policy block honestly instead of inventing media', async () => {
    const svc = makeService();
    fetchMock.mockRejectedValue(new netGuard.SsrfError('Host not allowed: www.flsenate.gov'));
    const r = await svc.resolve({ pageUrl: SENATE_PLAYER });
    expect(r.status).toBe('unresolvable');
    expect(r.note).toContain('Blocked by network policy');
  });

  it('keeps the reference-only behaviour (no network) when the switch is off', async () => {
    delete process.env[FLAG];
    const svc = makeService();
    for (const pageUrl of [SENATE_PLAYER, HOUSE_PLAYER]) {
      const r = await svc.resolve({ pageUrl });
      expect(r.status).toBe('unresolvable');
      expect(r.reference).toBe(pageUrl);
      expect(r.note).toContain('tab audio');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── The Florida Channel per-event page ──────────────────────────────────────

describe('the Florida Channel per-event page', () => {
  const TFC_EVENT =
    'https://thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission/';

  it('returns the exact /videos/<slug>/ page as the stable publisher reference with NO network call', async () => {
    const svc = makeService();
    const r = await svc.resolve({ pageUrl: TFC_EVENT });
    expect(r.status).toBe('unresolvable');
    expect(r.reference).toBe(TFC_EVENT);
    expect(r.note).toContain('publisher player');
    expect(r.note).toContain('record that tab’s audio');
    expect(r.note).toContain('browser capture');
    // Structural validation only — no existence/playability claim.
    expect(r.note).not.toContain('Verified');
    // Never the old dead-end.
    expect(r.note).not.toContain('No resolver adapter');
    // Structural validation only — no fetch, no probe, no extraction.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('accepts the same page without the trailing slash', async () => {
    const svc = makeService();
    const r = await svc.resolve({
      pageUrl: 'https://thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission',
    });
    expect(r.status).toBe('unresolvable');
    expect(r.note).toContain('publisher player');
    expect(r.note).not.toContain('No resolver adapter');
  });

  it.each([
    ['http scheme', 'http://thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission/'],
    ['credentials', 'https://user:pw@thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission/'],
    ['non-standard port', 'https://thefloridachannel.org:8443/videos/9-11-26-joint-legislative-budget-commission/'],
    ['videos index', 'https://thefloridachannel.org/videos/'],
    ['other TFC path', 'https://thefloridachannel.org/about/'],
    ['subdomain', 'https://www.thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission/'],
    ['other host', 'https://thefloridachannel.com/videos/9-11-26-joint-legislative-budget-commission/'],
    ['slug with underscore', 'https://thefloridachannel.org/videos/joint_budget/'],
    ['slug with empty segment', 'https://thefloridachannel.org/videos//'],
  ])('rejects a non-exact page (%s) truthfully, with no network', async (_label, url) => {
    const svc = makeService();
    const r = await svc.resolve({ pageUrl: url });
    expect(r.status).toBe('unresolvable');
    expect(r.note).not.toContain('publisher player');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('keeps the generic no-adapter outcome for a non-exact TFC host variant', async () => {
    const svc = makeService();
    const r = await svc.resolve({ pageUrl: 'https://www.thefloridachannel.org/videos/x/' });
    expect(r.status).toBe('unresolvable');
    expect(r.note).toContain('No resolver adapter for host www.thefloridachannel.org');
  });
});
