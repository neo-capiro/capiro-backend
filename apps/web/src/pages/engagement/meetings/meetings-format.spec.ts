import { describe, it, expect } from 'vitest';
import { dayKey, isAllDayMeeting, meetingDayKey } from './meetings-format.js';

describe('isAllDayMeeting', () => {
  it('detects a single-day all-day event (both ends exact UTC midnight, 1-day span)', () => {
    expect(isAllDayMeeting('2026-07-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z')).toBe(true);
  });

  it('detects a multi-day all-day event (whole-day span)', () => {
    expect(isAllDayMeeting('2026-07-15T00:00:00.000Z', '2026-07-18T00:00:00.000Z')).toBe(true);
  });

  it('is false for a normal timed event', () => {
    expect(isAllDayMeeting('2026-07-15T14:30:00.000Z', '2026-07-15T15:00:00.000Z')).toBe(false);
  });

  it('is false for a zero-length event at UTC midnight', () => {
    expect(isAllDayMeeting('2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')).toBe(false);
  });

  it('is false for a sub-day block that merely starts/ends at UTC midnight', () => {
    // 12h span — not a whole number of days.
    expect(isAllDayMeeting('2026-07-15T00:00:00.000Z', '2026-07-15T12:00:00.000Z')).toBe(false);
  });

  it('is false when only one end is UTC midnight', () => {
    expect(isAllDayMeeting('2026-07-15T00:00:00.000Z', '2026-07-16T09:00:00.000Z')).toBe(false);
  });
});

describe('meetingDayKey', () => {
  it('buckets an all-day event on its UTC calendar date regardless of viewer timezone', () => {
    // The core fix: an all-day event stored at UTC midnight must NOT shift to the
    // previous local day for west-of-UTC viewers. Its nominal date is the fix,
    // in every timezone.
    expect(meetingDayKey('2026-07-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z')).toBe('2026-07-15');
  });

  it('buckets a timed event by the viewer local day (delegates to dayKey)', () => {
    const startsAt = '2026-07-15T14:30:00.000Z';
    expect(meetingDayKey(startsAt, '2026-07-15T15:00:00.000Z')).toBe(dayKey(new Date(startsAt)));
  });
});
