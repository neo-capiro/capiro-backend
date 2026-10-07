import { plannerTimerDays } from './planner-timers.js';

describe('Timer elapsed-time allocation', () => {
  it('rounds the total once and assigns the larger midnight remainder first', () => {
    expect(
      plannerTimerDays(new Date('2026-10-07T23:59:40Z'), new Date('2026-10-08T00:00:40Z'), 'UTC'),
    ).toEqual([{ workedOn: '2026-10-08', milliseconds: 40_000, minutes: 1 }]);
    expect(
      plannerTimerDays(new Date('2026-10-07T23:59:30Z'), new Date('2026-10-08T00:00:30Z'), 'UTC'),
    ).toEqual([{ workedOn: '2026-10-07', milliseconds: 30_000, minutes: 1 }]);
  });
  it('uses the captured calendar zone, including a 23-hour spring day', () => {
    expect(
      plannerTimerDays(
        new Date('2026-03-08T05:00:00Z'),
        new Date('2026-03-09T04:00:00Z'),
        'America/New_York',
      ),
    ).toEqual([{ workedOn: '2026-03-08', milliseconds: 82_800_000, minutes: 1380 }]);
  });
  it('keeps the complete 25-hour fall day and fractional-hour zone boundaries', () => {
    expect(
      plannerTimerDays(
        new Date('2026-11-01T04:00:00Z'),
        new Date('2026-11-02T05:00:00Z'),
        'America/New_York',
      ),
    ).toEqual([{ workedOn: '2026-11-01', milliseconds: 90_000_000, minutes: 1500 }]);
    expect(
      plannerTimerDays(
        new Date('2026-10-07T18:14:00Z'),
        new Date('2026-10-07T18:16:00Z'),
        'Asia/Kathmandu',
      ),
    ).toEqual([
      { workedOn: '2026-10-07', milliseconds: 60_000, minutes: 1 },
      { workedOn: '2026-10-08', milliseconds: 60_000, minutes: 1 },
    ]);
  });
  it('handles a skipped midnight without counting an extra calendar day', () => {
    expect(
      plannerTimerDays(
        new Date('2011-12-29T10:00:00Z'),
        new Date('2011-12-30T10:01:00Z'),
        'Pacific/Apia',
      ),
    ).toEqual([
      { workedOn: '2011-12-29', milliseconds: 86_400_000, minutes: 1440 },
      { workedOn: '2011-12-31', milliseconds: 60_000, minutes: 1 },
    ]);
  });
  it('keeps nonzero sub-minute work and permits a zero-duration close without entries', () => {
    const start = new Date('2026-10-07T12:00:00Z');
    expect(plannerTimerDays(start, new Date(start.getTime() + 1), 'UTC')[0]!.minutes).toBe(1);
    expect(plannerTimerDays(start, start, 'UTC')).toEqual([]);
    expect(() => plannerTimerDays(start, new Date(start.getTime() - 1), 'UTC')).toThrow();
    expect(() =>
      plannerTimerDays(start, new Date(start.getTime() + 1_000_000 * 60_000 + 1), 'UTC'),
    ).toThrow();
  });
});
