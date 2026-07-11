import {
  buildPassageOutcomeSets,
  sineDieKey,
  buildStatusUpdateData,
  type PassageVoteInput,
} from './derive-state-bill-status.js';

function vote(overrides: Partial<PassageVoteInput> = {}): PassageVoteInput {
  return {
    billKey: 'tx-2025-hb1234',
    motion: 'Third Reading',
    passed: true,
    date: new Date('2025-03-01'),
    legiscanRollCallId: 1,
    ...overrides,
  };
}

describe('buildPassageOutcomeSets (S3 hot-fix: failed/passed mutual exclusivity)', () => {
  it('a single passing vote lands only in passedChamber', () => {
    const { passedChamber, failedChamber } = buildPassageOutcomeSets([vote({ passed: true })]);
    expect(passedChamber.has('tx-2025-hb1234')).toBe(true);
    expect(failedChamber.has('tx-2025-hb1234')).toBe(false);
  });

  it('a single failing vote lands only in failedChamber', () => {
    const { passedChamber, failedChamber } = buildPassageOutcomeSets([vote({ passed: false })]);
    expect(failedChamber.has('tx-2025-hb1234')).toBe(true);
    expect(passedChamber.has('tx-2025-hb1234')).toBe(false);
  });

  it('REGRESSION (the inversion bug): a bill that failed then later passed on reconsideration lands ONLY in passedChamber, never both', () => {
    const votes = [
      vote({ passed: false, date: new Date('2025-02-01'), legiscanRollCallId: 1 }),
      vote({ passed: true, date: new Date('2025-03-15'), legiscanRollCallId: 2 }),
    ];
    const { passedChamber, failedChamber } = buildPassageOutcomeSets(votes);
    expect(passedChamber.has('tx-2025-hb1234')).toBe(true);
    expect(failedChamber.has('tx-2025-hb1234')).toBe(false);
  });

  it('the inverse temporal case: a bill that passed then later failed reconsideration lands ONLY in failedChamber', () => {
    const votes = [
      vote({ passed: true, date: new Date('2025-02-01'), legiscanRollCallId: 1 }),
      vote({ passed: false, date: new Date('2025-03-15'), legiscanRollCallId: 2 }),
    ];
    const { passedChamber, failedChamber } = buildPassageOutcomeSets(votes);
    expect(failedChamber.has('tx-2025-hb1234')).toBe(true);
    expect(passedChamber.has('tx-2025-hb1234')).toBe(false);
  });

  it('same-day votes break the tie on legiscanRollCallId (higher id = later)', () => {
    const votes = [
      vote({ passed: false, date: new Date('2025-03-15'), legiscanRollCallId: 5 }),
      vote({ passed: true, date: new Date('2025-03-15'), legiscanRollCallId: 9 }),
    ];
    const { passedChamber, failedChamber } = buildPassageOutcomeSets(votes);
    expect(passedChamber.has('tx-2025-hb1234')).toBe(true);
    expect(failedChamber.has('tx-2025-hb1234')).toBe(false);
  });

  it('ignores votes with a null passed value (still pending / voice vote)', () => {
    const { passedChamber, failedChamber } = buildPassageOutcomeSets([vote({ passed: null })]);
    expect(passedChamber.size).toBe(0);
    expect(failedChamber.size).toBe(0);
  });

  it('ignores votes with no billKey', () => {
    const { passedChamber, failedChamber } = buildPassageOutcomeSets([vote({ billKey: null })]);
    expect(passedChamber.size).toBe(0);
    expect(failedChamber.size).toBe(0);
  });

  it('ignores non-passage motions (committee/amendment) via classifyStateVoteMotion', () => {
    const { passedChamber, failedChamber } = buildPassageOutcomeSets([
      vote({ motion: 'Committee Amendment adopted', passed: true }),
    ]);
    expect(passedChamber.size).toBe(0);
    expect(failedChamber.size).toBe(0);
  });

  it('tracks multiple distinct bills independently', () => {
    const { passedChamber, failedChamber } = buildPassageOutcomeSets([
      vote({ billKey: 'tx-2025-hb1', passed: true }),
      vote({ billKey: 'tx-2025-hb2', passed: false }),
    ]);
    expect(passedChamber.has('tx-2025-hb1')).toBe(true);
    expect(failedChamber.has('tx-2025-hb2')).toBe(true);
  });
});

describe('sineDieKey', () => {
  it('joins state and sessionKey with a hyphen (DD1 join)', () => {
    expect(sineDieKey('TX', '2025')).toBe('TX-2025');
  });
});

describe('buildStatusUpdateData (2026-07-10 hot-fix: statusDerivedAt stamping)', () => {
  it('stamps statusDerivedAt with the ingestion-time `now`, distinct from statusAt (legislative date)', () => {
    const now = new Date('2025-06-15T18:30:00Z');
    const bill = { latestActionDate: new Date('2025-06-01'), textDate: null };
    const data = buildStatusUpdateData(bill, 'passed_chamber', now);
    expect(data.statusDerivedAt).toBe(now);
    expect(data.statusAt).toBe(bill.latestActionDate);
    expect(data.statusDerivedAt).not.toEqual(data.statusAt);
    expect(data.status).toBe('passed_chamber');
    expect(data.statusSource).toBe('derived');
  });

  it('falls back statusAt to textDate, then now, when latestActionDate is absent — statusDerivedAt is ALWAYS `now` regardless', () => {
    const now = new Date('2025-06-15T18:30:00Z');
    const withTextDate = buildStatusUpdateData(
      { latestActionDate: null, textDate: new Date('2025-05-01') },
      'reported',
      now,
    );
    expect(withTextDate.statusAt).toEqual(new Date('2025-05-01'));
    expect(withTextDate.statusDerivedAt).toBe(now);

    const withNeither = buildStatusUpdateData(
      { latestActionDate: null, textDate: null },
      'introduced',
      now,
    );
    expect(withNeither.statusAt).toBe(now);
    expect(withNeither.statusDerivedAt).toBe(now);
  });
});
