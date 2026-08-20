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

  it('returns the next future checkpoint when a hearing is still early', () => {
    expect(
      nextStreamPreflightAt({
        now: new Date('2026-08-20T15:00:00Z'),
        scheduledStart: start,
        resolutionState: 'NOT_CHECKED',
      })?.toISOString(),
    ).toBe('2026-08-21T13:00:00.000Z');
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
