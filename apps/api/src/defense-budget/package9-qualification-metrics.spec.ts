import {
  oldestActionableQueueAgeMs,
  sourceRegistrationToEvidenceCommitMs,
} from './package9-qualification-metrics.js';

describe('Package 9 qualification metrics', () => {
  test('queue age uses the oldest pending or leased row and the logical queue clock', () => {
    const logicalNow = new Date('2026-09-25T00:00:05.000Z');
    expect(
      oldestActionableQueueAgeMs(
        [
          { state: 'succeeded', oldest: new Date('2020-01-01T00:00:00.000Z') },
          { state: 'dead_letter', oldest: new Date('2020-01-02T00:00:00.000Z') },
          { state: 'pending', oldest: new Date('2026-09-25T00:00:02.000Z') },
          { state: 'leased', oldest: new Date('2026-09-25T00:00:03.000Z') },
        ],
        logicalNow,
      ),
    ).toBe(3_000);
  });

  test('queue age is null with no actionable work and never negative', () => {
    const logicalNow = new Date('2026-09-25T00:00:00.000Z');
    expect(
      oldestActionableQueueAgeMs([{ state: 'succeeded', oldest: logicalNow }], logicalNow),
    ).toBe(null);
    expect(
      oldestActionableQueueAgeMs(
        [{ state: 'pending', oldest: new Date(logicalNow.getTime() + 10) }],
        logicalNow,
      ),
    ).toBe(0);
  });

  test('registration-to-commit latency uses a shared timestamp clock', () => {
    expect(
      sourceRegistrationToEvidenceCommitMs(
        new Date('2026-09-25T00:00:00.100Z'),
        new Date('2026-09-25T00:00:00.275Z'),
      ),
    ).toBe(175);
  });
});
