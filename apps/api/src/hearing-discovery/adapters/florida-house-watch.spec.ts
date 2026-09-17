/**
 * Florida House notice↔watch pairing (release-blocking regression).
 *
 * Production finding: `houseDailyCalendar` explicitly SKIPPED any
 * `.schedule-event` carrying a MeetingId link, and `houseNoticeLinks` returned
 * bare URL strings — so the WatchArchivedStream VideoPlayer link living in the
 * SAME schedule-event was discarded. Real page (houseschedule.aspx?date=
 * 2-26-2026): State Affairs MeetingId=15193 with SAME-event watch
 * VideoPlayer.aspx?eventID=11179 (NOT the neighboring event's 11185). The
 * bare meetingnotice.aspx?MeetingId=15193 page carries no video, so 18 prod
 * House records have no watch despite available video.
 *
 * Fix proven here: pair the notice URL/id with the watch URL WITHIN the exact
 * `.schedule-event` element — never a title match, never a cross-neighbor
 * borrow. Missing video stays null. Relative links resolve against flhouse.gov.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  houseNoticeWatchPairs,
  houseNoticeObservation,
} from './florida-calendar.adapter.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../__fixtures__/florida', name), 'utf8');

const SCHEDULE = `
<div class="schedule-list">
  <div class="schedule-event">
    <h2 class="scheduled-event-title">State Affairs Committee</h2>
    <div class="meeting-info"><span>02/26/2026</span><span>9:00 AM</span><span>404 HOB</span></div>
    <a href="/Sections/Committees/meetingnotice.aspx?MeetingId=15193">Meeting Notice</a>
    <a href="/VideoPlayer.aspx?eventID=11179">Watch Archived Stream</a>
  </div>
  <div class="schedule-event">
    <h2 class="scheduled-event-title">Judiciary Committee</h2>
    <div class="meeting-info"><span>02/26/2026</span><span>11:00 AM</span><span>404 HOB</span></div>
    <a href="/Sections/Committees/meetingnotice.aspx?MeetingId=15194">Meeting Notice</a>
    <a href="/VideoPlayer.aspx?eventID=11185">Watch Archived Stream</a>
  </div>
  <div class="schedule-event">
    <h2 class="scheduled-event-title">No Video Committee</h2>
    <div class="meeting-info"><span>02/26/2026</span><span>1:00 PM</span><span>404 HOB</span></div>
    <a href="/Sections/Committees/meetingnotice.aspx?MeetingId=15195">Meeting Notice</a>
  </div>
</div>`;

describe('houseNoticeWatchPairs', () => {
  it('pairs each notice with the watch URL inside its OWN schedule-event, never a neighbor', () => {
    const pairs = houseNoticeWatchPairs(SCHEDULE);
    expect(pairs).toEqual([
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15193',
        watchUrl: 'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179',
      },
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15194',
        watchUrl: 'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11185',
      },
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15195',
        watchUrl: null,
      },
    ]);
  });

  it('resolves relative notice and watch links against flhouse.gov', () => {
    const pairs = houseNoticeWatchPairs(
      '<div class="schedule-list"><div class="schedule-event">' +
        '<a href="meetingnotice.aspx?MeetingId=16001">Notice</a>' +
        '<a href="/VideoPlayer.aspx?eventID=11200">Watch</a>' +
        '</div></div>',
    );
    expect(pairs[0]?.noticeUrl).toBe(
      'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=16001',
    );
    expect(pairs[0]?.watchUrl).toBe('https://www.flhouse.gov/VideoPlayer.aspx?eventID=11200');
  });

  it('rejects a watch link with a non-numeric eventID or wrong host without crashing the page', () => {
    const pairs = houseNoticeWatchPairs(
      '<div class="schedule-list">' +
        '<div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?MeetingId=16002">Notice</a>' +
        '<a href="/VideoPlayer.aspx?eventID=abc">Watch</a>' +
        '</div>' +
        '<div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?MeetingId=16003">Notice</a>' +
        '<a href="https://evil.example/VideoPlayer.aspx?eventID=11200">Watch</a>' +
        '</div>' +
        '<div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?MeetingId=16004">Notice</a>' +
        '<a href="javascript:alert(1)">Watch</a>' +
        '</div>' +
        '</div>',
    );
    expect(pairs).toEqual([
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=16002',
        watchUrl: null,
      },
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=16003',
        watchUrl: null,
      },
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=16004',
        watchUrl: null,
      },
    ]);
  });

  it('pairs on the normalized numeric MeetingId despite query casing/order differences', () => {
    const pairs = houseNoticeWatchPairs(
      '<div class="schedule-list">' +
        '<div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?MEETINGID=16005&x=1">Notice</a>' +
        '<a href="/VideoPlayer.aspx?EventId=11201">Watch</a>' +
        '</div>' +
        '<div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?x=1&meetingid=16005">Dup notice</a>' +
        '</div>' +
        '</div>',
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.noticeUrl).toBe(
      'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=16005',
    );
    expect(pairs[0]?.watchUrl).toBe('https://www.flhouse.gov/VideoPlayer.aspx?eventID=11201');
  });

  it('ignores notice links with a non-numeric MeetingId', () => {
    const pairs = houseNoticeWatchPairs(
      '<div class="schedule-list"><div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?MeetingId=abc">Notice</a>' +
        '<a href="/VideoPlayer.aspx?eventID=11200">Watch</a>' +
        '</div></div>',
    );
    expect(pairs).toEqual([]);
  });

  it('REAL 2-26-2026 page: State Affairs 15193 pairs with eventID 11179, not a neighbor', () => {
    // The actual official houseschedule.aspx?date=2-26-2026 HTML (87,111 bytes),
    // downloaded by root. The release-blocking production case.
    const pairs = houseNoticeWatchPairs(fixture('house-schedule-20260226.html'));
    const byMeeting = new Map(
      pairs.map((p) => [p.noticeUrl.match(/MeetingId=(\d+)/)?.[1], p.watchUrl]),
    );
    expect(byMeeting.get('15193')).toBe('https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179');
    // Every pair's watch URL, when present, is a validated flhouse VideoPlayer
    // with a numeric eventID — and no two notices share one eventID.
    const eventIds = pairs.map((p) => p.watchUrl?.match(/eventID=(\d+)/)?.[1]).filter(Boolean);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    for (const p of pairs) {
      if (p.watchUrl)
        expect(p.watchUrl).toMatch(/^https:\/\/www\.flhouse\.gov\/VideoPlayer\.aspx\?eventID=\d+$/);
    }
  });

  it('matches the notice/watch path case-insensitively (advertised ASPX behavior)', () => {
    const pairs = houseNoticeWatchPairs(
      '<div class="schedule-list"><div class="schedule-event">' +
        '<a href="/Sections/Committees/MEETINGNOTICE.ASPX?MeetingId=16010">Notice</a>' +
        '<a href="/VIDEOPLAYER.ASPX?eventID=11210">Watch</a>' +
        '</div></div>',
    );
    expect(pairs).toEqual([
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=16010',
        watchUrl: 'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11210',
      },
    ]);
  });

  it('upgrades a duplicated notice from no-video to the SAME notice event with its own video', () => {
    // First entry for MeetingId 16011 has no video; a later duplicate of the
    // SAME notice carries the video. The emitted pair must pick up that SAME
    // event's own watch (never a neighbor's player).
    const pairs = houseNoticeWatchPairs(
      '<div class="schedule-list">' +
        '<div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?MeetingId=16011">Notice</a>' +
        '</div>' +
        '<div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?MeetingId=16011">Same notice</a>' +
        '<a href="/VideoPlayer.aspx?eventID=11211">Watch</a>' +
        '</div>' +
        '</div>',
    );
    expect(pairs).toEqual([
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=16011',
        watchUrl: 'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11211',
      },
    ]);
  });

  it('never borrows a NEIGHBOR event video for a notice that has none of its own', () => {
    // MeetingId 16011 has no video; a DIFFERENT MeetingId's player must not be
    // adopted for it.
    const pairs = houseNoticeWatchPairs(
      '<div class="schedule-list">' +
        '<div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?MeetingId=16011">Notice</a>' +
        '</div>' +
        '<div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?MeetingId=16012">Other</a>' +
        '<a href="/VideoPlayer.aspx?eventID=11212">Watch</a>' +
        '</div>' +
        '</div>',
    );
    expect(pairs).toEqual([
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=16011',
        watchUrl: null,
      },
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=16012',
        watchUrl: 'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11212',
      },
    ]);
  });

  it('rejects credential-bearing and non-http(s) watch links without borrowing a neighbor', () => {
    const pairs = houseNoticeWatchPairs(
      '<div class="schedule-list">' +
        '<div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?MeetingId=16012">Notice</a>' +
        '<a href="https://user:pass@www.flhouse.gov/VideoPlayer.aspx?eventID=11212">Watch</a>' +
        '</div>' +
        '<div class="schedule-event">' +
        '<a href="/Sections/Committees/meetingnotice.aspx?MeetingId=16013">Notice</a>' +
        '<a href="/VideoPlayer.aspx?eventID=11213">Watch</a>' +
        '</div>' +
        '</div>',
    );
    expect(pairs).toEqual([
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=16012',
        watchUrl: null,
      },
      {
        noticeUrl:
          'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=16013',
        watchUrl: 'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11213',
      },
    ]);
  });
});

describe('houseNoticeObservation watchUrl', () => {
  const NOTICE_HTML = `
    <html><body>
      <h1 class="ribbon">State Affairs Committee</h1>
      <nav aria-label="Breadcrumb"><a href="?sessionId=104">2026</a></nav>
      <select id="ddlBillFinderSession"><option value="104">2026</option></select>
      <dl aria-label="Meeting Information">
        <dt>Start Date and Time:</dt><dd>February 26, 2026 9:00 AM</dd>
        <dt>Location:</dt><dd>404 HOB</dd>
        <time datetime="2026-02-26T09:00:00-05:00"></time>
      </dl>
      <div class="cm_contents">Agenda</div>
      <div class="meeting-actions-bills"><section><ul><li>HB 123 Test</li></ul></section></div>
    </body></html>`;

  it('carries a supplied watchUrl into fields.watchUrl and completeFields', () => {
    const o = houseNoticeObservation(
      NOTICE_HTML,
      'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15193',
      null,
      'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179',
    );
    expect(o.fields.watchUrl).toBe('https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179');
    expect(o.completeFields).toContain('watchUrl');
  });

  it('leaves watchUrl unset when the schedule-event had no video link', () => {
    const o = houseNoticeObservation(
      NOTICE_HTML,
      'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15195',
      null,
    );
    expect(o.fields.watchUrl ?? null).toBeNull();
    expect(o.completeFields).not.toContain('watchUrl');
  });

  it('parses the real downloaded State Affairs notice (Start Date/time/ID/location/agenda)', () => {
    // Actual official meetingnotice.aspx?MeetingId=15193 HTML downloaded by root.
    const o = houseNoticeObservation(
      fixture('house-notice-15193.html'),
      'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15193',
      null,
      'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179',
    );
    expect(o.officialIdentity).toBe('fl:house:meeting:15193');
    expect(o.bodyName).toBe('State Affairs Committee');
    expect(o.chamber).toBe('house');
    expect(o.fields.time?.date).toBe('2026-02-26');
    expect(o.fields.time?.startsAt).toBe('2026-02-26T13:00:00.000Z'); // 8:00 AM -05:00
    expect(o.fields.location).toBe('Morris Hall (17 HOB)');
    expect(o.fields.agenda?.some((a) => a.kind === 'unresolved_bill')).toBe(true);
    expect(o.fields.watchUrl).toBe('https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179');
    expect(o.completeFields).toContain('watchUrl');
  });
});
