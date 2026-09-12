import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  floridaDate,
  floridaBillNumberAliases,
  houseNoticeObservation,
  senateNoticeObservation,
  senateNoticeRefs,
  senateDailyCalendar,
  houseDailyCalendar,
  type SenateNoticeRef,
} from './florida-calendar.adapter.js';
import { legislativeEventId, validateCalendarObservation } from '../legislative-calendar.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../__fixtures__/florida', name), 'utf8');
const ref: SenateNoticeRef = {
  id: '6880',
  bodyCode: 'FP',
  bodyName: 'Fiscal Policy',
  date: '2026-02-24',
  rawTime: '9:00 AM',
  sourceUrl: 'https://www.flsenate.gov/Committees/Show/FP/MeetingNotice/6880',
  documents: [],
  watchUrl: null,
  canceled: false,
};
describe('Florida first-party calendar contract', () => {
  it('matches zero-padded Florida bill labels without changing proposal or resolution types', () => {
    expect(floridaBillNumberAliases('CS/CS/SB 174')).toEqual(['SB174', 'S174', 'SB0174', 'S0174']);
    expect(floridaBillNumberAliases('HB 0032')).toEqual(['HB32', 'H32', 'HB0032', 'H0032']);
    expect(floridaBillNumberAliases('SPB 7046')).toEqual(['SPB7046']);
    expect(floridaBillNumberAliases('SJR 12')).toEqual(['SJR12']);
  });
  it('preserves repeated proposed-bill headings with unique, replay-stable identities', () => {
    const text = 'COMMITTEE MEETING NOTICE\nTIME: 9:00—11:00 a.m.\nConsideration of proposed bill:\nSPB 7046 by Finance and Tax—Taxation\nConsideration of proposed bill:\nSPB 7048 by Finance and Tax—Internal Revenue Code';
    const noticeRef = { ...ref, id: '6890', bodyCode: 'FT', bodyName: 'Finance and Tax' };
    const observation = senateNoticeObservation(noticeRef, text, '2026');
    validateCalendarObservation(observation);
    expect(observation.fields.agenda?.map((item) => item.evidence.identifier ?? item.title)).toEqual([
      'Consideration of proposed bill:', 'SPB 7046',
      'Consideration of proposed bill:', 'SPB 7048',
    ]);
    expect(new Set(observation.fields.agenda?.map((item) => item.key)).size).toBe(4);
    expect(senateNoticeObservation(noticeRef, text, '2026').fields.agenda).toEqual(observation.fields.agenda);
  });
  it('discovers the daily-only Special Order notice and qualifies floor timing without inventing a bill agenda', () => {
    const html = `<div class="calHeader"><h2>Thursday, February 26, 2026 Open Calendar</h2></div><div id="CalendarContents">
      <div class="eventGroupContainer"><h4>9:00 AM — 6:00 PM</h4><div class="event"><span class="eventtitle">SESSION</span><div class="location">Location: The Senate Chamber</div><div class="MeetingRecords"><li class="FLOORBILLS"><a href="/Home/2-26-2026?Tab=SenateFloor">Senate Floor</a></li><a href="/Session/Calendar/2026/Daily%20Calendar.PDF">Daily Calendar</a></div></div></div>
      <div class="eventGroupContainer"><h4>15 minutes after the completion of the Sitting — Until completion</h4><div class="event"><span class="eventtitle">Special Order Calendar Group</span><div class="location">Meeting cancelled</div><div class="MeetingRecords"><a href="/Committees/Show/SOCG/MeetingNotice/6892">Meeting Notice</a></div></div></div></div>`;
    const result = senateDailyCalendar(html, '2026-02-26', '2026');
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({ id: '6892', bodyCode: 'SOCG', canceled: true });
    expect(result.floors).toHaveLength(1);
    expect(result.floors[0]!.fields.time).toMatchObject({
      startsAt: '2026-02-26T14:00:00.000Z',
      endsAt: '2026-02-26T23:00:00.000Z',
    });
    expect(result.floors[0]!.completeness).toBe('partial');
    expect(result.floors[0]!.fields.agenda).toBeUndefined();
    validateCalendarObservation(result.floors[0]!);
    expect(() => senateDailyCalendar(html, '2026-02-27', '2026')).toThrow('date mismatch');
    expect(senateDailyCalendar(html, '2026-02-26', '2027').unresolved).toBe(1);
    expect(
      senateDailyCalendar(
        '<div class="calHeader"><h2>Friday, February 27, 2026 Open Calendar</h2></div><div id="tabCalendar">No events scheduled for this day.</div>',
        '2026-02-27',
        '2026',
      ),
    ).toEqual({ notices: [], floors: [], issues: [], unresolved: 0 });
  });
  it('counts House schedule entries without notice identities as unresolved coverage', () => {
    expect(
      houseDailyCalendar(
        '<div class="schedule-list"><div class="schedule-event"><h2 class="scheduled-event-title">Floor sitting</h2></div><div class="schedule-event"><a href="/meetingnotice.aspx?MeetingId=1">Notice</a></div></div>',
        '2026-02-25',
        '2026',
      ).unresolved,
    ).toBe(1);
    const day = houseDailyCalendar(
      '<div class="schedule-list"><div class="schedule-event"><h2 class="scheduled-event-title">House - 44th Day of Regular Session</h2><div class="meeting-info"><span>02/25/2026</span><span>10:00 AM - 9:20 PM</span></div></div></div>',
      '2026-02-25',
      '2026',
    );
    expect(day.floors[0]).toMatchObject({
      officialIdentity: 'fl:house:regular:2026:day:44',
      completeness: 'partial',
    });
    expect(day.floors[0]!.fields.time).toMatchObject({
      startsAt: '2026-02-25T15:00:00.000Z',
      endsAt: '2026-02-26T02:20:00.000Z',
    });
    validateCalendarObservation(day.floors[0]!);
  });
  it('qualifies the published Rules noon range and the canceled relative-time Special Order notice', () => {
    // Live first-party notices 6881 and 6892, read September 11, 2026.
    const rules = senateNoticeObservation(
      { ...ref, id: '6881' },
      'COMMITTEE MEETING NOTICE\nTIME: 12:00 noon—6:00 p.m.\nPresentation',
      '2026',
    );
    expect(rules.fields.time).toMatchObject({
      precision: 'instant',
      startsAt: '2026-02-24T17:00:00.000Z',
      endsAt: '2026-02-24T23:00:00.000Z',
      rawTime: '12:00 noon—6:00 p.m.',
    });
    const special = senateNoticeObservation(
      {
        ...ref,
        id: '6892',
        date: '2026-02-26',
        bodyCode: 'SOCG',
        bodyName: 'Special Order Calendar Group',
      },
      'MEETING NOTICE\nTIME: 15 minutes after the completion of the Sitting—Until completion\nMEETING CANCELLED',
      '2026',
    );
    expect(special.fields.status).toBe('canceled');
    expect(special.fields.time).toMatchObject({
      precision: 'relative',
      startsAt: null,
      endsAt: null,
    });
    validateCalendarObservation(special);
  });
  it('extracts all 18 Fiscal Policy bills across both notice pages and the actual published end', () => {
    const o = senateNoticeObservation(ref, fixture('senate-6880.txt'), '2026');
    expect(o.fields.agenda).toHaveLength(18);
    expect(o.fields.agenda?.at(-1)?.evidence.identifier).toBe('CS/SB 1686');
    expect(o.fields.time?.startsAt).toBe('2026-02-24T14:00:00.000Z');
    expect(o.fields.time?.endsAt).toBe('2026-02-24T16:00:00.000Z');
    const archived = senateNoticeObservation(
      {
        ...ref,
        documents: [
          {
            key: ref.sourceUrl,
            title: 'Notice',
            url: ref.sourceUrl,
            kind: 'notice',
            publishedAt: null,
          },
        ],
      },
      fixture('senate-6880.txt'),
      '2026',
    );
    expect(archived.fields.documents?.[0]?.deadlines?.join(' ')).toContain(
      'Monday, February 23, 2026 at 9:00 a.m.',
    );
    expect(archived.fields.documents?.[0]?.publishedText).toContain('CS/SB 1686');
    validateCalendarObservation(o);
  });
  it('retains published no-bill confirmation business', () => {
    const o = senateNoticeObservation({ ...ref, id: '6878' }, fixture('senate-6878.txt'), '2026');
    expect(
      o.fields.agenda?.some((a) => a.kind === 'other' && /Confirmation Hearing/.test(a.title)),
    ).toBe(true);
    expect(o.fields.agenda?.some((a) => a.bill)).toBe(false);
  });
  it('reads House bill sections and resolves the notice breadcrumb session, not the globally selected year', () => {
    const o = houseNoticeObservation(
      fixture('house-15190.html'),
      'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15190',
      null,
    );
    expect(o.session).toBe('2026');
    expect(o.fields.agenda?.map((a) => a.evidence.identifier)).toEqual(['CS/HB 975']);
    expect(o.fields.time?.endsAt).toBe('2026-02-23T20:30:00.000Z');
    validateCalendarObservation(o);
  });
  it('preserves joint no-bill notices and their stable identity', () => {
    const o = houseNoticeObservation(
      fixture('house-15223.html'),
      'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15223',
      null,
    );
    expect(o.chamber).toBe('joint');
    expect(o.bodySourceKey).toBe('fl:joint:lbc');
    expect(o.fields.agenda!.length).toBeGreaterThan(1);
    expect(o.fields.agenda!.every((i) => !i.bill)).toBe(true);
    const senate = senateNoticeObservation(
      {
        ...ref,
        id: '6914',
        bodyCode: 'JLBC',
        bodyName: 'Joint Legislative Budget Commission',
        sourceUrl: 'https://www.flsenate.gov/Committees/Show/JLBC/MeetingNotice/6914',
        date: '2026-09-11',
      },
      '2027 Regular Session The Florida Senate\nJOINT COMMITTEE MEETING NOTICE\nTIME: 11:00 a.m.—2:00 p.m.\nConsideration of the Long-Range Financial Outlook',
      '2026',
    );
    expect(o.session).toBeNull();
    expect(senate.session).toBeNull();
    expect(legislativeEventId(senate)).toBe(legislativeEventId(o));
    expect(o.fields.documents).toHaveLength(2);
  });
  it('reports missing in-window notice identities but excludes out-of-window rows from the coverage denominator', () => {
    const html =
      '<table id="meetingsTbl"><tbody><tr><td>1/1/2026</td><td>9 AM</td></tr><tr><td>2/24/2026</td><td>9 AM</td></tr></tbody></table>';
    expect(
      senateNoticeRefs(html, 'FP', 'Fiscal Policy', { from: '2026-02-23', to: '2026-03-01' })
        .issues,
    ).toHaveLength(1);
  });
  it('rejects date rollover and does not invent an end for relative timing', () => {
    expect(floridaDate('2/30/2026')).toBeNull();
    const o = senateNoticeObservation(
      { ...ref, rawTime: 'Upon adjournment' },
      'COMMITTEE MEETING NOTICE\nTIME: Upon adjournment\nPresentation on infrastructure',
      '2026',
    );
    expect(o.fields.time).toMatchObject({ precision: 'relative', startsAt: null, endsAt: null });
  });
  it('keeps an explicit House relative time and missing end without converting a date to midnight', () => {
    const html = fixture('house-15190.html')
      .replace('2026-02-23T15:00:00-05:00', '2026-02-23')
      .replace('2026-02-23T15:30:00-05:00', '')
      .replace(
        'Start Date and Time:</dt>',
        'Start Date and Time:</dt><dd>Monday, February 23, 2026 Upon adjournment</dd>',
      );
    const o = houseNoticeObservation(
      html,
      'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15190',
      null,
    );
    expect(o.fields.time).toMatchObject({
      date: '2026-02-23',
      precision: 'relative',
      startsAt: null,
      endsAt: null,
    });
    validateCalendarObservation(o);
  });
  it('requires explicit cancellation and preserves reinstatement of the same Senate notice', () => {
    const text = fixture('senate-6880.txt');
    const canceled = senateNoticeObservation({ ...ref, canceled: true }, text, '2026');
    const reinstated = senateNoticeObservation(ref, text, '2026');
    expect(canceled.fields.status).toBe('canceled');
    expect(reinstated.fields.status).toBe('scheduled');
    expect(canceled.officialIdentity).toBe(reinstated.officialIdentity);
  });
});
