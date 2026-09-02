import { describe, expect, it } from 'vitest';
import {
  addDays,
  fmtDuration,
  fmtTime,
  fmtWeekRange,
  localDateKey,
  localTimeKey,
  mondayOf,
  zonedInstantUtc,
  zonedMidnightUtc,
} from './hillday-time.js';

describe('hillday time helpers', () => {
  it('keys dates in the sponsor zone, not the browser zone', () => {
    // 03:30Z on the 17th is still the evening of the 16th in New York.
    expect(localDateKey('2026-09-17T03:30:00Z', 'America/New_York')).toBe('2026-09-16');
    expect(mondayOf('2026-09-17T03:30:00Z', 'America/New_York')).toBe('2026-09-14');
    expect(mondayOf('2026-09-14T03:00:00Z', 'America/New_York')).toBe('2026-09-07');
  });

  it('computes zoned midnight across DST', () => {
    expect(zonedMidnightUtc('2026-09-14', 'America/New_York')).toBe('2026-09-14T04:00:00.000Z');
    expect(zonedMidnightUtc('2026-12-14', 'America/New_York')).toBe('2026-12-14T05:00:00.000Z');
  });

  it('composes a date + time-of-day into a zoned instant across DST', () => {
    // Same two seasons as the zonedMidnightUtc test, so the DST offset switch
    // (EDT -4 in September, EST -5 in December) is the thing under test.
    expect(zonedInstantUtc('2026-09-14', '13:00', 'America/New_York')).toBe('2026-09-14T17:00:00.000Z');
    expect(zonedInstantUtc('2026-12-14', '13:00', 'America/New_York')).toBe('2026-12-14T18:00:00.000Z');
  });

  it('reads local time-of-day back out of an instant', () => {
    // Cross-checked against the fmtTime test below: "8:45 AM" ET == "08:45".
    expect(localTimeKey('2026-09-16T12:45:00Z', 'America/New_York')).toBe('08:45');
    expect(localTimeKey(zonedInstantUtc('2026-09-14', '13:00', 'America/New_York'), 'America/New_York')).toBe('13:00');
  });

  it('formats times, durations and ranges', () => {
    expect(fmtTime('2026-09-16T12:45:00Z', 'America/New_York')).toBe('8:45 AM');
    expect(fmtDuration('2026-09-16T12:45:00Z', '2026-09-16T13:15:00Z')).toBe('30 min');
    expect(addDays('2026-09-14', 6)).toBe('2026-09-20');
    expect(fmtWeekRange('2026-09-14')).toBe('Sep 14 – 20, 2026');
    expect(fmtWeekRange('2026-09-28')).toBe('Sep 28 – Oct 4, 2026');
  });
});
