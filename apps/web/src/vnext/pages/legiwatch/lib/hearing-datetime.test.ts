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
    // 17:00Z is 10:00 AM PT and 1:00 PM ET — dual label required by the contract.
    const m = parseHearingMoment({
      date: '2026-09-04',
      startsAt: '2026-09-04T17:00:00.000Z',
      timeZone: 'America/Los_Angeles',
    });
    const label = formatHearingTime(m);
    expect(label).toMatch(/^10:00 AM PT \(1:00 PM ET\)$/);
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
