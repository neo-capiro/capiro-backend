/**
 * LW-QA-001 regression suite — the shared hearing date/time contract.
 *
 * Anchored to the two official QA samples and the corruption classes found in
 * the 2026-09-02 report: date-only strings parsed as UTC midnight and rendered
 * as "8:00 PM" on the previous day, and all hearings collapsing to one time.
 */
import {
  calendarBucketIndex,
  calendarDayParts,
  easternDayOf,
  easternWeekDaysFor,
  formatHearingDay,
  formatHearingMoment,
  formatHearingTime,
  parseHearingMoment,
} from './hearing-datetime.js';

describe('calendarDayParts', () => {
  it('parses a plain calendar date without constructing a Date', () => {
    expect(calendarDayParts('2026-09-03')).toEqual({ y: 2026, m: 9, d: 3 });
  });

  it('accepts an ISO prefix (instant string) but only takes the day parts', () => {
    expect(calendarDayParts('2026-09-04T17:00:00.000Z')).toEqual({ y: 2026, m: 9, d: 4 });
  });

  it('rejects garbage and impossible days', () => {
    expect(calendarDayParts('')).toBeNull();
    expect(calendarDayParts('not-a-date')).toBeNull();
    expect(calendarDayParts('2026-13-01')).toBeNull();
    expect(calendarDayParts('2026-09-32')).toBeNull();
    expect(calendarDayParts(null)).toBeNull();
  });

  it('rejects structurally valid but impossible dates by calendar round-trip (QA review C)', () => {
    expect(calendarDayParts('2026-02-31')).toBeNull(); // Feb 31 does not exist
    expect(calendarDayParts('2026-04-31')).toBeNull(); // April has 30 days
    expect(calendarDayParts('2026-02-30')).toBeNull();
    expect(calendarDayParts('2026-06-31')).toBeNull();
    // …while every real day still parses, including leap days.
    expect(calendarDayParts('2026-02-28')).toEqual({ y: 2026, m: 2, d: 28 });
    expect(calendarDayParts('2028-02-29')).toEqual({ y: 2028, m: 2, d: 29 }); // leap year
    expect(calendarDayParts('2026-12-31')).toEqual({ y: 2026, m: 12, d: 31 });
  });
});

describe('parseHearingMoment', () => {
  it('classifies a true instant when startsAt exists', () => {
    const m = parseHearingMoment({
      date: '2026-09-03',
      startsAt: '2026-09-03T13:00:00.000Z',
      time: '9:00 AM',
      timeZone: 'America/New_York',
    });
    expect(m.kind).toBe('instant');
    expect(m.calendarDate).toBe('2026-09-03');
  });

  it('classifies date-only when startsAt is null and never fabricates an instant', () => {
    const m = parseHearingMoment({ date: '2026-09-03', startsAt: null, time: null });
    expect(m.kind).toBe('date-only');
    expect(m.calendarDate).toBe('2026-09-03');
    expect(m.timeZone).toBe('America/New_York');
  });

  it('defaults a missing zone to the product primary zone', () => {
    const m = parseHearingMoment({ date: '2026-09-04', startsAt: '2026-09-04T17:00:00Z' });
    expect(m.timeZone).toBe('America/New_York');
  });
});

describe('formatHearingTime — official QA samples', () => {
  it('Renders the Reliable Water hearing at its official 9:00 AM ET (13:00Z)', () => {
    const m = parseHearingMoment({
      date: '2026-09-03',
      startsAt: '2026-09-03T13:00:00.000Z',
      time: '9:00 AM',
      timeZone: 'America/New_York',
    });
    expect(formatHearingTime(m)).toBe('9:00 AM ET');
  });

  it('Never renders a date-only hearing as 8:00 PM — it says Time not announced', () => {
    const m = parseHearingMoment({ date: '2026-09-03', startsAt: null, time: null });
    expect(formatHearingTime(m)).toBe('Time not announced');
  });

  it('Renders an official clock string verbatim for a date-only event (no conversion)', () => {
    const m = parseHearingMoment({ date: '2026-09-03', startsAt: null, time: '9:00 AM' });
    expect(formatHearingTime(m)).toBe('9:00 AM (official local time)');
  });

  it('Renders a non-Eastern instant with the ET equivalent (dual time)', () => {
    // The Santa Clarita field hearing: 20:00Z is 1:00 PM PT and 4:00 PM ET.
    const m = parseHearingMoment({
      date: '2026-09-04',
      startsAt: '2026-09-04T20:00:00.000Z',
      timeZone: 'America/Los_Angeles',
    });
    const label = formatHearingTime(m);
    expect(label).toMatch(/^1:00 PM PT \(4:00 PM ET\)$/);
  });

  it('REGRESSION (2026-09-04): cm-119-119533 renders 1:00 PM PT / 4:00 PM ET — never 17:00Z-as-ET', () => {
    // The official announcement: September 4, 2026, 1:00 PM PT, College of the
    // Canyons, Santa Clarita. The corrected instant is 20:00Z; the prior
    // fixture (17:00Z → "10:00 AM PT (1:00 PM ET)") canonized the central
    // calendar's mis-zoned encoding.
    const corrected = parseHearingMoment({
      date: '2026-09-04',
      startsAt: '2026-09-04T20:00:00.000Z',
      time: '1:00 PM',
      timeZone: 'America/Los_Angeles',
    });
    expect(formatHearingTime(corrected)).toBe('1:00 PM PT (4:00 PM ET)');
    expect(formatHearingMoment(corrected)).toBe('Fri, Sep 4 · 1:00 PM PT (4:00 PM ET)');
    // The forbidden encoding: 17:00Z would read 10:00 AM PT / 1:00 PM ET.
    const forbidden = parseHearingMoment({
      date: '2026-09-04',
      startsAt: '2026-09-04T17:00:00.000Z',
      timeZone: 'America/Los_Angeles',
    });
    expect(formatHearingTime(forbidden)).toBe('10:00 AM PT (1:00 PM ET)');
    expect(formatHearingTime(forbidden)).not.toBe(formatHearingTime(corrected));
  });

  it('Midnight-UTC regression: a date-only 2026-09-03 record is never "8:00 PM" anything', () => {
    const m = parseHearingMoment({ date: '2026-09-03', startsAt: null, time: null });
    expect(formatHearingTime(m)).not.toMatch(/8:00 PM/i);
  });
});

describe('formatHearingDay — no day shift for date-only rows', () => {
  it('Formats the calendar date from its parts (no timezone conversion)', () => {
    expect(formatHearingDay(parseHearingMoment({ date: '2026-09-03', startsAt: null }))).toBe('Thu, Sep 3');
  });

  it('An instant shows the Eastern day of the instant', () => {
    expect(
      formatHearingDay(
        parseHearingMoment({ date: '2026-09-03', startsAt: '2026-09-03T13:00:00.000Z' }),
      ),
    ).toBe('Thu, Sep 3');
  });

  it('DST boundary: an instant just after the spring-forward gap still buckets on its Eastern day', () => {
    // 2026-03-08 is the US DST transition; 14:00Z = 10:00 AM EDT that day.
    expect(easternDayOf('2026-03-08T14:00:00.000Z')).toBe('2026-03-08');
  });

  it('DST boundary: an Eastern 9:30 AM instant in December (EST, UTC-5) stays on the same day', () => {
    expect(easternDayOf('2026-12-01T14:30:00.000Z')).toBe('2026-12-01');
  });
});

describe('calendarBucketIndex — week bucketing in one frame', () => {
  const week = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'];

  it('buckets an instant by its Eastern day (119528 → Thu Sep 3)', () => {
    const m = parseHearingMoment({ date: '2026-09-03', startsAt: '2026-09-03T13:00:00.000Z' });
    expect(calendarBucketIndex(m, week)).toBe(3);
  });

  it('buckets a date-only row on its official day without shifting backward', () => {
    const m = parseHearingMoment({ date: '2026-09-03', startsAt: null });
    expect(calendarBucketIndex(m, week)).toBe(3);
  });

  it('returns -1 for a hearing outside the week', () => {
    const m = parseHearingMoment({ date: '2026-09-10', startsAt: '2026-09-10T14:00:00Z' });
    expect(calendarBucketIndex(m, week)).toBe(-1);
  });
});

describe('formatHearingMoment — full label shape', () => {
  it('composes day and time for an instant', () => {
    const m = parseHearingMoment({
      date: '2026-09-03',
      startsAt: '2026-09-03T13:00:00.000Z',
      timeZone: 'America/New_York',
    });
    expect(formatHearingMoment(m)).toBe('Thu, Sep 3 · 9:00 AM ET');
  });

  it('date-only keeps the day and refuses a time', () => {
    const m = parseHearingMoment({ date: '2026-09-04', startsAt: null });
    expect(formatHearingMoment(m)).toBe('Fri, Sep 4 · Time not announced');
  });
});

describe('easternWeekDaysFor — pure Eastern week anchor + inclusive Sunday (QA review B/D)', () => {
  it('anchors the week by Eastern calendar day, not the browser local zone', () => {
    // 2026-09-02 20:00Z is Wed Sep 2 in ET but Wed Sep 2 1 PM PT / still Sep 2
    // in UTC — pick an instant whose EASTERN and UTC days disagree with a
    // Pacific reading to prove the anchor is Eastern-only.
    // 2026-08-31T03:30Z is Sun Aug 30 11:30 PM ET — the Eastern day is Aug 30,
    // so the week must anchor on Mon Aug 24, NOT Mon Aug 31 (what a UTC/PT
    // reading of the instant would give).
    const anchor = new Date('2026-08-31T03:30:00.000Z');
    expect(easternDayOf(anchor.toISOString())).toBe('2026-08-30');
    const week = easternWeekDaysFor(anchor);
    expect(week[0]).toBe('2026-08-24'); // Monday of the EASTERN week
    expect(week[6]).toBe('2026-08-30'); // Sunday
  });

  it('the same instant selects the same week under ET, PT and UTC browser zones', () => {
    // Pure functions take an instant; the old implementation leaked the host
    // zone through new Date() getters. Assert the contract directly: one
    // instant, one week, regardless of where the operator sits. (The hook wraps
    // this function in useMemo with no additional zone input.)
    const anchor = new Date('2026-09-02T12:00:00.000Z');
    const expected = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'];
    expect(easternWeekDaysFor(anchor)).toEqual(expected);
    // And a late-evening ET instant that is already "tomorrow" in UTC must
    // still anchor on the Eastern day.
    const lateEt = new Date('2026-09-02T03:30:00.000Z'); // Tue Sep 1 11:30 PM ET, Wed Sep 2 UTC
    expect(easternWeekDaysFor(lateEt)[0]).toBe('2026-08-31');
  });

  it('Sunday is INCLUSIVE at the range end so the final day cannot disappear', () => {
    // 2026-09-06 is a Sunday. The week bucket containing it ends on that day.
    const anchor = new Date('2026-09-06T18:00:00.000Z'); // Sunday Sep 6 2:00 PM ET
    const week = easternWeekDaysFor(anchor);
    expect(week[6]).toBe('2026-09-06');
    expect(new Date(Date.UTC(2026, 8, 6)).getUTCDay()).toBe(0); // sanity: 2026-09-06 IS a Sunday (UTC)
    // A Sunday hearing buckets INTO the week (not shifted out).
    const sundayHearing = parseHearingMoment({ date: '2026-09-06', startsAt: null });
    expect(calendarBucketIndex(sundayHearing, week)).toBe(6);
  });

  it('a Pacific field hearing lands in the calendar by its source zone day (no bucket shift)', () => {
    const week = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'];
    const m = parseHearingMoment({
      date: '2026-09-04',
      startsAt: '2026-09-04T20:00:00.000Z', // 1:00 PM PT Sep 4
      timeZone: 'America/Los_Angeles',
    });
    expect(calendarBucketIndex(m, week)).toBe(4); // Friday, same day in ET too (4:00 PM ET)
  });
});
