import {
  buildStreamPreflightSchedule,
  classifyStreamPreflightWindow,
  nextStreamPreflightAt,
  sourceErrorBackoff,
} from './stream-preflight-policy.js';

describe('stream preflight policy', () => {
  const start = new Date('2026-08-21T14:00:00Z');

  it('builds the standard 24h, 1h, 15m, and 5m checkpoints', () => {
    expect(buildStreamPreflightSchedule(start).map((date) => date.toISOString())).toEqual([
      '2026-08-20T14:00:00.000Z',
      '2026-08-21T13:00:00.000Z',
      '2026-08-21T13:45:00.000Z',
      '2026-08-21T13:55:00.000Z',
    ]);
  });

  it('returns the next future checkpoint after the prior checkpoint was attempted', () => {
    expect(
      nextStreamPreflightAt({
        now: new Date('2026-08-20T15:00:00Z'),
        scheduledStart: start,
        resolutionState: 'WAITING_FOR_STREAM',
        lastAttemptAt: new Date('2026-08-20T14:00:00Z'),
      })?.toISOString(),
    ).toBe('2026-08-21T13:00:00.000Z');
  });

  it('attempts a due or missed early checkpoint once rather than skipping to the next one', () => {
    for (const time of ['2026-08-20T14:00:00Z', '2026-08-21T13:05:00Z']) {
      const now = new Date(time);
      expect(nextStreamPreflightAt({ now, scheduledStart: start, resolutionState: 'NOT_CHECKED' })).toEqual(now);
    }
    expect(nextStreamPreflightAt({
      now: new Date('2026-08-21T13:05:01Z'), scheduledStart: start,
      resolutionState: 'WAITING_FOR_STREAM', lastAttemptAt: new Date('2026-08-21T13:05:00Z'),
    })).toEqual(new Date('2026-08-21T13:45:00Z'));
  });

  it.each([
    ['WAITING_FOR_STREAM', 0, 20_000],
    ['SOURCE_ERROR', 2, 120_000],
  ] as const)('anchors %s retries to the last actual attempt', (resolutionState, consecutiveSourceErrors, delay) => {
    const lastAttemptAt = new Date('2026-08-21T13:55:00Z');
    const due = new Date(lastAttemptAt.getTime() + delay);
    const input = { scheduledStart: start, resolutionState, consecutiveSourceErrors, lastAttemptAt };
    expect(nextStreamPreflightAt({ ...input, now: new Date(due.getTime() - 1) })).toEqual(due);
    expect(nextStreamPreflightAt({ ...input, now: due })).toEqual(due);
    const late = new Date(due.getTime() + 60_000);
    expect(nextStreamPreflightAt({ ...input, now: late })).toEqual(late);
  });

  it('rapid-polls every 20 seconds near and after the nominal start', () => {
    expect(classifyStreamPreflightWindow(new Date('2026-08-21T13:59:00Z'), start)).toBe(
      'RAPID_POLL',
    );
    expect(
      nextStreamPreflightAt({
        now: new Date('2026-08-21T13:59:00Z'),
        scheduledStart: start,
        resolutionState: 'WAITING_FOR_STREAM',
        lastAttemptAt: new Date('2026-08-21T13:59:00Z'),
      })?.toISOString(),
    ).toBe('2026-08-21T13:59:20.000Z');
    expect(classifyStreamPreflightWindow(new Date('2026-08-21T14:30:00Z'), start)).toBe(
      'DELAYED_START_GRACE',
    );
  });

  it('backs off source errors without exceeding the configured maximum', () => {
    expect(sourceErrorBackoff(0)).toBe(30_000);
    expect(sourceErrorBackoff(2)).toBe(120_000);
    expect(sourceErrorBackoff(20)).toBe(300_000);
  });

  it('stops scheduling after grace or any terminal resolution outcome', () => {
    expect(
      nextStreamPreflightAt({
        now: new Date('2026-08-21T15:31:00Z'),
        scheduledStart: start,
        resolutionState: 'WAITING_FOR_STREAM',
      }),
    ).toBeNull();
    expect(
      nextStreamPreflightAt({
        now: new Date('2026-08-21T13:00:00Z'),
        scheduledStart: start,
        resolutionState: 'POLICY_BLOCKED',
      }),
    ).toBeNull();
  });
  it('resolves immediately when entering the rapid window without a prior attempt', () => {
    expect(
      nextStreamPreflightAt({
        now: new Date('2026-08-21T13:59:00Z'),
        scheduledStart: start,
        resolutionState: 'NOT_CHECKED',
      })?.toISOString(),
    ).toBe('2026-08-21T13:59:00.000Z');
  });

});
