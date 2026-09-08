import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const NativeDateTimeFormat = Intl.DateTimeFormat;

// Reproduce the audited browser condition: native Date fields can use a
// different zone from Intl's default. Explicit timeZone options still win.
function useViewerZone(zone: string) {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
    return new NativeDateTimeFormat(locales, { timeZone: zone, ...options });
  } as typeof Intl.DateTimeFormat);
}

beforeEach(() => vi.resetModules());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('QA-02 consistent calendar civil dates and meeting instants', () => {
  test('September 8 headings, weekday strip, timed buckets, clock and Today agree in Eastern time', async () => {
    useViewerZone('America/New_York');
    const f = await import('./meetings-format.js');
    const cursor = f.localDateFromKey('2026-09-08');
    expect(f.formatDayTitle(cursor)).toBe('Tue, Sep 8');
    expect(f.formatWeekdayShort(cursor)).toBe('TUE');
    expect(f.formatDayHeader(cursor)).toContain('Tuesday, September 8');
    expect(f.formatWeekRange(f.startOfWeek(cursor), f.addDays(f.startOfWeek(cursor), 6))).toBe('Sep 7 – Sep 13');
    const start = '2026-09-08T19:00:00Z';
    const end = '2026-09-08T19:30:00Z';
    expect(f.meetingDayKey(start, end)).toBe('2026-09-08');
    expect(f.formatMeetingDayTitle(start, end)).toBe(f.formatDayTitle(cursor));
    expect(f.formatTime(start).replace(/\s/g, ' ')).toBe('3:00 PM');
    expect(f.meetingDayKey('invalid', end)).toBe('');
    expect(f.formatMeetingDayTitle('invalid', end)).toBe('—');
    expect(f.meetingDateTimeToIso('2026-09-08', '15:00')).toBe('2026-09-08T19:00:00.000Z');
    // 00:30Z is still the previous civil evening in Eastern time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:30:00Z'));
    expect(f.dayKey(f.calendarToday())).toBe('2026-09-07');
    expect(f.isToday(f.localDateFromKey('2026-09-07'))).toBe(true);
  });

  test('an evening meeting after UTC midnight and all-day event retain distinct correct dates', async () => {
    useViewerZone('America/New_York');
    const f = await import('./meetings-format.js');
    expect(f.meetingDayKey('2026-09-09T00:30:00Z', '2026-09-09T01:00:00Z')).toBe('2026-09-08');
    expect(f.formatMeetingDayTitle('2026-09-09T00:30:00Z', '2026-09-09T01:00:00Z')).toBe('Tue, Sep 8');
    expect(f.formatMeetingDayTitle('2026-09-08T00:00:00Z', '2026-09-09T00:00:00Z')).toBe('Tue, Sep 8');
  });

  test.each([
    ['2026-03-08', '2026-03-09T04:00:00.000Z', '2026-03-08T19:00:00.000Z'],
    ['2026-11-01', '2026-11-02T05:00:00.000Z', '2026-11-01T20:00:00.000Z'],
  ])('query and composer use the actual DST offset on %s', async (day, exclusiveEnd, meetingInstant) => {
    useViewerZone('America/New_York');
    const f = await import('./meetings-format.js');
    const cursor = f.localDateFromKey(day);
    const query = f.meetingQueryRange(cursor, cursor);
    expect(query.from).toBe(`${day}T00:00:00.000Z`); // Includes UTC-stored all-day records.
    expect(query.to).toBe(exclusiveEnd);
    expect(f.meetingDateTimeToIso(day, '15:00')).toBe(meetingInstant);
    expect(f.dayKey(f.addDays(cursor, 1))).toBe(exclusiveEnd.slice(0, 10));
  });

  test('east-of-UTC query includes both early timed and final-day all-day records', async () => {
    useViewerZone('Asia/Tokyo');
    const f = await import('./meetings-format.js');
    const cursor = f.localDateFromKey('2026-09-08');
    expect(f.meetingQueryRange(cursor, cursor)).toEqual({ from: '2026-09-07T15:00:00.000Z', to: '2026-09-09T00:00:00.000Z' });
    expect(f.meetingDayKey('2026-09-07T15:30:00Z', '2026-09-07T16:00:00Z')).toBe('2026-09-08');
    expect(f.formatMonthTitle(f.localDateFromKey('2026-09-01'))).toBe('September 2026');
  });
});
