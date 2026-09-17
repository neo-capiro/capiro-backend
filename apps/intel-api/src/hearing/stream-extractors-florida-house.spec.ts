/**
 * Florida House notice → VideoPlayer pairing extractors (MeetingId=15193 regression).
 *
 * A Florida House meeting notice page does not carry its own VideoPlayer link.
 * The official daily schedule page for the same date pairs the exact MeetingId
 * with a VideoPlayer link. These pure functions implement the bounded chain:
 *
 *   notice URL → parse MeetingId + date → daily schedule page → find the
 *   schedule-event block containing the exact MeetingId → accept ONLY the
 *   VideoPlayer link inside that same block.
 *
 * No title matching, no neighbor acceptance, no hardcoded ids.
 *
 * The fixtures below are REDUCED BUT VERBATIM from the real downloaded public
 * pages (root review supplied them):
 *   - official-fl-house-notice-15193.html    (40 215 bytes, flhouse.gov)
 *   - official-fl-house-schedule-20260226.html (87 111 bytes, flhouse.gov)
 * The schedule fixture keeps the REAL nested structure (meeting-info divs,
 * empty <li> placeholders, data-eventid anchors) and adds a PRECEDING neighbor
 * event before the target — the shape the old regex chain got wrong (it
 * crossed closing divs and returned the neighbor's player).
 */
import {
  extractFloridaHouseNoticeDate,
  findFloridaHouseVideoPlayerForMeeting,
  floridaHouseDailyScheduleUrl,
  isRequestRejectedPage,
  parseFloridaHouseNoticeUrl,
  parseFloridaSenateVideoPlayerUrl,
} from './stream-extractors.js';

const NOTICE_URL = 'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15193';
const MEETING_ID = '15193';

/**
 * VERBATIM-reduced slice of the real notice's Meeting Information <dl>
 * (official-fl-house-notice-15193.html lines ~792-812): classed dt/dd, newline
 * + whitespace before the nested <time datetime> element, and an End Date dd
 * that must NEVER be used.
 */
const REAL_NOTICE_HTML = `<div class="cm_contents">

    <dl aria-label="Meeting Information">
        <dt class="textBold label">Start Date and Time:</dt>
        <dd class="value">

            <time datetime="2026-02-26T08:00:00-05:00">
            Thursday, February 26, 2026 8:00 AM</time>

                </dd>

        <dt class="textBold label">End Date and Time:</dt>
        <dd class="value">


            <time datetime="2026-02-27T12:00:00-05:00">
                Friday, February 27, 2026 12:00 PM</time>

            </dd>

        <dt class="textBold label">Location:</dt>
        <dd class="value">Morris Hall (17 HOB)</dd>
    </dl>
</div>`;

/**
 * VERBATIM-reduced slice of the real daily schedule page
 * (official-fl-house-schedule-20260226.html): the target State Affairs event
 * (MeetingId=15193 → eventID=11179) PLUS a preceding neighbor (the real
 * Commerce Committee event MeetingId=15186 → eventID=11185, transcribed from
 * the same page) BEFORE it, and a following neighbor after it. Nested
 * structure (col-12 / meeting-info divs, empty <li>, data-eventid anchors)
 * preserved.
 */
const REAL_SCHEDULE_HTML = `<div class="schedule-list">

<div class="row row-striped schedule-event">
    <div class="col-12">
        <h2 class="scheduled-event-title">
            Commerce Committee

        </h2>
        <div class="meeting-info">
            <span class="list-inline-item schedule_ids">02/26/2026</span><span class="list-inline-item schedule_ids">3:30 PM - 6:30 PM</span>
        </div>
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
        data-start=" 3:30 PM"
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
        <h2 class="scheduled-event-title">
            State Affairs Committee

        </h2>
        <div class="meeting-info">
            <span class="list-inline-item schedule_ids">02/26/2026</span><span class="list-inline-item schedule_ids">8:00 AM - 12:00 PM</span>
        </div>
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
        data-start=" 8:00 AM"
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


<div class="row row-striped schedule-event">
    <div class="col-12">
        <h2 class="scheduled-event-title">
            Judiciary Committee

        </h2>
        <div class="meeting-info">
            <span class="list-inline-item schedule_ids">02/26/2026</span><span class="list-inline-item schedule_ids">8:30 AM - 12:00 PM</span>
        </div>
        <div>

            <ul class="event-action-list">

                <li class="">

                    <a class="btn btn-warning btn-meeting-notice" href="/Sections/Committees/meetingnotice.aspx?MeetingId=15195">Meeting Notice</a>

                </li>

<li>
    <a data-eventid="11180"
        data-title="House Judiciary Committee"
        data-start=" 8:30 AM"
        role="button"
        class="btn on-demand-status"
        href="/VideoPlayer.aspx?eventID=11180"
        title="Watch Archived Stream">
        Watch Archived Stream
    </a>
</li>

            </ul>
        </div>

</div>
</div>

</div>`;

describe('parseFloridaHouseNoticeUrl', () => {
  it('parses a valid Florida House notice URL', () => {
    expect(parseFloridaHouseNoticeUrl(NOTICE_URL)).toEqual({ meetingId: MEETING_ID, date: null });
  });

  it('accepts a case-insensitive MeetingId key and http scheme', () => {
    expect(
      parseFloridaHouseNoticeUrl(
        'http://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?meetingid=15193',
      ),
    ).toEqual({ meetingId: MEETING_ID, date: null });
  });

  it('rejects a non-flhouse host', () => {
    expect(
      parseFloridaHouseNoticeUrl('https://www.example.com/Sections/Committees/meetingnotice.aspx?MeetingId=15193'),
    ).toBeNull();
  });

  it('rejects a lookalike host suffix attack', () => {
    expect(
      parseFloridaHouseNoticeUrl('https://flhouse.gov.evil.example/Sections/Committees/meetingnotice.aspx?MeetingId=15193'),
    ).toBeNull();
    expect(
      parseFloridaHouseNoticeUrl('https://notflhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15193'),
    ).toBeNull();
  });

  it('rejects a non-notice path', () => {
    expect(
      parseFloridaHouseNoticeUrl('https://www.flhouse.gov/VideoPlayer.aspx?MeetingId=15193'),
    ).toBeNull();
  });

  it('rejects credentials and non-http(s) schemes', () => {
    expect(
      parseFloridaHouseNoticeUrl('https://user:pass@www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15193'),
    ).toBeNull();
    expect(
      parseFloridaHouseNoticeUrl('ftp://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15193'),
    ).toBeNull();
  });

  it('rejects a missing or non-numeric MeetingId', () => {
    expect(parseFloridaHouseNoticeUrl('https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx')).toBeNull();
    expect(parseFloridaHouseNoticeUrl('https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=abc')).toBeNull();
  });
});

describe('extractFloridaHouseNoticeDate', () => {
  it('extracts the date from the REAL notice markup (classed dt/dd, nested <time datetime>)', () => {
    // The old implementation matched dd([^<]+) and returned NULL on this exact
    // markup because the dd opens with whitespace then a nested <time> tag.
    expect(extractFloridaHouseNoticeDate(REAL_NOTICE_HTML)).toBe('2026-02-26');
  });

  it('never uses the End Date dd (end-date trap in the fixture is 2026-02-27)', () => {
    const html = `
      <dt class="textBold label">Start Date and Time:</dt>
      <dd class="value"><time datetime="2026-02-26T08:00:00-05:00">Thursday, February 26, 2026 8:00 AM</time></dd>
      <dt class="textBold label">End Date and Time:</dt>
      <dd class="value"><time datetime="2026-02-27T12:00:00-05:00">Friday, February 27, 2026 12:00 PM</time></dd>`;
    expect(extractFloridaHouseNoticeDate(html)).toBe('2026-02-26');
  });

  it('falls back to the rendered date text when datetime is absent', () => {
    const html = `
      <dt class="textBold label">Start Date and Time:</dt>
      <dd class="value">
          Thursday, February 26, 2026 8:00 AM
      </dd>`;
    expect(extractFloridaHouseNoticeDate(html)).toBe('2026-02-26');
  });

  it('extracts a slash date from the notice Start Date and Time', () => {
    const html = `
      <dl aria-label="Meeting Information">
        <dt>Start Date and Time:</dt><dd>2/26/2026 8:00 AM</dd>
      </dl>`;
    expect(extractFloridaHouseNoticeDate(html)).toBe('2026-02-26');
  });

  it('rejects February 30 in the datetime attribute (calendar validation)', () => {
    const html = `
      <dt class="textBold label">Start Date and Time:</dt>
      <dd class="value"><time datetime="2026-02-30T08:00:00-05:00">Monday, February 30, 2026 8:00 AM</time></dd>`;
    expect(extractFloridaHouseNoticeDate(html)).toBeNull();
  });

  it('rejects February 30 in the rendered text (calendar validation)', () => {
    const html = `
      <dt class="textBold label">Start Date and Time:</dt>
      <dd class="value">February 30, 2026 8:00 AM</dd>`;
    expect(extractFloridaHouseNoticeDate(html)).toBeNull();
  });

  it('rejects malformed dates (month 13, day 0, garbage)', () => {
    expect(
      extractFloridaHouseNoticeDate(
        '<dt>Start Date and Time:</dt><dd><time datetime="2026-13-01T08:00:00-05:00">x</time></dd>',
      ),
    ).toBeNull();
    expect(
      extractFloridaHouseNoticeDate('<dt>Start Date and Time:</dt><dd>0/0/2026 8:00 AM</dd>'),
    ).toBeNull();
    expect(
      extractFloridaHouseNoticeDate('<dt>Start Date and Time:</dt><dd>TBD</dd>'),
    ).toBeNull();
  });

  it('returns null when the notice lacks a Start Date and Time dd', () => {
    const html = '<dl><dt>Location:</dt><dd>Morris Hall (17 HOB)</dd></dl>';
    expect(extractFloridaHouseNoticeDate(html)).toBeNull();
  });
});

describe('floridaHouseDailyScheduleUrl', () => {
  it('builds the daily schedule URL for an ISO date', () => {
    expect(floridaHouseDailyScheduleUrl('2026-02-26')).toBe(
      'https://www.flhouse.gov/Sections/HouseSchedule/houseschedule.aspx?date=2-26-2026',
    );
  });
});

describe('findFloridaHouseVideoPlayerForMeeting', () => {
  it('finds the player paired with the exact MeetingId in the REAL nested schedule markup', () => {
    // Reduced-verbatim real schedule: nested col-12/meeting-info divs, empty
    // <li> placeholders, data-eventid anchors. The old regex truncated at the
    // first nested closing div and dropped the correct player.
    expect(findFloridaHouseVideoPlayerForMeeting(REAL_SCHEDULE_HTML, MEETING_ID)).toBe(
      'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179',
    );
  });

  it('NEVER returns the PRECEDING neighbor event player (11185 is the wrong event)', () => {
    // The neighbor Commerce event (MeetingId=15186 → eventID=11185) sits BEFORE
    // the target in the fixture. Asking for the neighbor's own MeetingId must
    // return the neighbor's player; asking for 15193 must never return 11185.
    expect(findFloridaHouseVideoPlayerForMeeting(REAL_SCHEDULE_HTML, '15186')).toBe(
      'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11185',
    );
    const out = findFloridaHouseVideoPlayerForMeeting(REAL_SCHEDULE_HTML, MEETING_ID);
    expect(out).not.toContain('11185');
  });

  it('does not prefix-match MeetingId=151930 when looking for 15193', () => {
    const html = `
      <div class="row row-striped schedule-event">
        <div class="col-12">
          <a href="/Sections/Committees/meetingnotice.aspx?MeetingId=151930">Notice</a>
          <a href="/VideoPlayer.aspx?eventID=99999">Watch</a>
        </div>
      </div>`;
    expect(findFloridaHouseVideoPlayerForMeeting(html, MEETING_ID)).toBeNull();
  });

  it('matches the MeetingId query key case-insensitively', () => {
    const html = `
      <div class="row row-striped schedule-event">
        <div class="col-12">
          <a href="/Sections/Committees/meetingnotice.aspx?meetingid=15193">Notice</a>
          <a href="/VideoPlayer.aspx?eventID=11179">Watch</a>
        </div>
      </div>`;
    expect(findFloridaHouseVideoPlayerForMeeting(html, MEETING_ID)).toBe(
      'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179',
    );
  });

  it('accepts single-quoted hrefs', () => {
    const html = `
      <div class="row row-striped schedule-event">
        <div class="col-12">
          <a href='/Sections/Committees/meetingnotice.aspx?MeetingId=15193'>Notice</a>
          <a href='/VideoPlayer.aspx?eventID=11179'>Watch</a>
        </div>
      </div>`;
    expect(findFloridaHouseVideoPlayerForMeeting(html, MEETING_ID)).toBe(
      'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179',
    );
  });

  it('rejects a spoofed notice host even inside the owning block', () => {
    const html = `
      <div class="row row-striped schedule-event">
        <div class="col-12">
          <a href="https://flhouse.gov.evil.example/Sections/Committees/meetingnotice.aspx?MeetingId=15193">Notice</a>
          <a href="/VideoPlayer.aspx?eventID=11179">Watch</a>
        </div>
      </div>`;
    expect(findFloridaHouseVideoPlayerForMeeting(html, MEETING_ID)).toBeNull();
  });

  it('rejects a spoofed/player external host', () => {
    const html = `
      <div class="row row-striped schedule-event">
        <div class="col-12">
          <a href="/Sections/Committees/meetingnotice.aspx?MeetingId=15193">Notice</a>
          <a href="https://evil.example/VideoPlayer.aspx?eventID=11179">Watch</a>
        </div>
      </div>`;
    expect(findFloridaHouseVideoPlayerForMeeting(html, MEETING_ID)).toBeNull();
  });

  it('rejects non-http(s) and credentials-bearing player URLs', () => {
    const jsHtml = `
      <div class="row row-striped schedule-event">
        <div class="col-12">
          <a href="/Sections/Committees/meetingnotice.aspx?MeetingId=15193">Notice</a>
          <a href="javascript:play(11179)">Watch</a>
        </div>
      </div>`;
    expect(findFloridaHouseVideoPlayerForMeeting(jsHtml, MEETING_ID)).toBeNull();
    const credHtml = `
      <div class="row row-striped schedule-event">
        <div class="col-12">
          <a href="/Sections/Committees/meetingnotice.aspx?MeetingId=15193">Notice</a>
          <a href="https://user:pass@www.flhouse.gov/VideoPlayer.aspx?eventID=11179">Watch</a>
        </div>
      </div>`;
    expect(findFloridaHouseVideoPlayerForMeeting(credHtml, MEETING_ID)).toBeNull();
  });

  it('returns null when the MeetingId is not on the schedule page', () => {
    expect(findFloridaHouseVideoPlayerForMeeting(REAL_SCHEDULE_HTML, '99999')).toBeNull();
  });

  it('returns null when the owning schedule-event block has no VideoPlayer link', () => {
    const html = `
      <div class="row row-striped schedule-event">
        <div class="col-12">
          <a href="/Sections/Committees/meetingnotice.aspx?MeetingId=15193">Notice</a>
        </div>
      </div>
      <div class="row row-striped schedule-event">
        <div class="col-12">
          <a href="/Sections/Committees/meetingnotice.aspx?MeetingId=15186">Other</a>
          <a href="/VideoPlayer.aspx?eventID=11185">Other Watch</a>
        </div>
      </div>`;
    // Owning block has no player — must NOT fall through to the neighbor's.
    expect(findFloridaHouseVideoPlayerForMeeting(html, MEETING_ID)).toBeNull();
  });

  it('rejects a non-numeric MeetingId', () => {
    expect(findFloridaHouseVideoPlayerForMeeting(REAL_SCHEDULE_HTML, 'abc')).toBeNull();
    expect(findFloridaHouseVideoPlayerForMeeting(REAL_SCHEDULE_HTML, '')).toBeNull();
  });
});

describe('isRequestRejectedPage', () => {
  it('recognizes the publisher bot-rejection page (200 + tiny "Request Rejected" body)', () => {
    // The live flhouse.gov WAF answers the guarded default Chrome UA with
    // HTTP 200 and a ~244-byte rejection page — that is a REJECTED fetch, not
    // a notice missing its date.
    const rejected = '<html><head><title>Request Rejected</title></head><body>Request Rejected</body></html>';
    expect(isRequestRejectedPage(rejected, 200)).toBe(true);
    expect(isRequestRejectedPage(rejected)).toBe(true);
  });

  it('treats explicit 401/403/429 statuses as rejection regardless of body', () => {
    expect(isRequestRejectedPage('', 403)).toBe(true);
    expect(isRequestRejectedPage('whatever', 429)).toBe(true);
  });

  it('does NOT flag a real (large) notice page that happens to contain the phrase', () => {
    const big = `Request Rejected ${'x'.repeat(5000)}`;
    expect(isRequestRejectedPage(big, 200)).toBe(false);
  });

  it('does not flag ordinary content', () => {
    expect(isRequestRejectedPage('<html><body>Meeting notice</body></html>', 200)).toBe(false);
  });
});

describe('parseFloridaSenateVideoPlayerUrl', () => {
  it('parses a valid Florida Senate media player URL', () => {
    expect(parseFloridaSenateVideoPlayerUrl('https://www.flsenate.gov/media/VideoPlayer/6382')).toEqual(
      { eventId: '6382' },
    );
  });

  it('accepts http scheme, a trailing slash, and case-insensitive path', () => {
    expect(parseFloridaSenateVideoPlayerUrl('http://www.flsenate.gov/Media/videoplayer/6382/')).toEqual(
      { eventId: '6382' },
    );
  });

  it('rejects a prefix-extended id (63820 is not 6382)', () => {
    // The function returns the ACTUAL id — a caller checking for 6382 must
    // never be handed 63820 silently.
    expect(parseFloridaSenateVideoPlayerUrl('https://www.flsenate.gov/media/VideoPlayer/63820')).toEqual(
      { eventId: '63820' },
    );
  });

  it('rejects a non-numeric or missing id', () => {
    expect(parseFloridaSenateVideoPlayerUrl('https://www.flsenate.gov/media/VideoPlayer/abc')).toBeNull();
    expect(parseFloridaSenateVideoPlayerUrl('https://www.flsenate.gov/media/VideoPlayer/')).toBeNull();
    expect(parseFloridaSenateVideoPlayerUrl('https://www.flsenate.gov/media/VideoPlayer')).toBeNull();
  });

  it('rejects a lookalike host, credentials, and non-http(s) schemes', () => {
    expect(
      parseFloridaSenateVideoPlayerUrl('https://flsenate.gov.evil.example/media/VideoPlayer/6382'),
    ).toBeNull();
    expect(
      parseFloridaSenateVideoPlayerUrl('https://notflsenate.gov/media/VideoPlayer/6382'),
    ).toBeNull();
    expect(
      parseFloridaSenateVideoPlayerUrl('https://user:pass@www.flsenate.gov/media/VideoPlayer/6382'),
    ).toBeNull();
    expect(parseFloridaSenateVideoPlayerUrl('ftp://www.flsenate.gov/media/VideoPlayer/6382')).toBeNull();
  });
});
