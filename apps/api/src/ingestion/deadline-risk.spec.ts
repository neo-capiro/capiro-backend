import { computeStateDeadlineRisk } from '@capiro/shared';

describe('computeStateDeadlineRisk (Phase 1 M2.1/M2.3/M2.4, PD5)', () => {
  const FULL_CALENDAR = {
    committeeCutoffDate: '2026-03-13',
    crossoverDate: '2026-04-17',
    secondCommitteeCutoffDate: '2026-05-08',
    sineDie: '2026-05-31',
  };

  it('a bill still in committee races the committee cutoff', () => {
    const risk = computeStateDeadlineRisk({
      status: 'committee',
      session: FULL_CALENDAR,
      today: '2026-03-10',
    });
    expect(risk).toEqual({
      daysUntil: 3,
      cutoffDate: '2026-03-13',
      cutoffType: 'committeeCutoff',
      isPastCutoff: false,
    });
  });

  it('a bill reported out of committee races crossover, not the (already-passed) committee cutoff', () => {
    const risk = computeStateDeadlineRisk({
      status: 'reported',
      session: FULL_CALENDAR,
      today: '2026-04-10',
    });
    expect(risk).toEqual({
      daysUntil: 7,
      cutoffDate: '2026-04-17',
      cutoffType: 'crossover',
      isPastCutoff: false,
    });
  });

  it('a bill that has passed a chamber races the second-chamber committee cutoff', () => {
    const risk = computeStateDeadlineRisk({
      status: 'passed_chamber',
      session: FULL_CALENDAR,
      today: '2026-05-01',
    });
    expect(risk).toEqual({
      daysUntil: 7,
      cutoffDate: '2026-05-08',
      cutoffType: 'secondCommitteeCutoff',
      isPastCutoff: false,
    });
  });

  it('a bill resolving differences (rank 5) has no more committee/floor cutoff — only sineDie applies', () => {
    const risk = computeStateDeadlineRisk({
      status: 'resolving',
      session: FULL_CALENDAR,
      today: '2026-05-25',
    });
    expect(risk).toEqual({
      daysUntil: 6,
      cutoffDate: '2026-05-31',
      cutoffType: 'sineDie',
      isPastCutoff: false,
    });
  });

  it('a terminal status (enacted) has no deadline risk left to report', () => {
    expect(
      computeStateDeadlineRisk({ status: 'enacted', session: FULL_CALENDAR, today: '2026-03-10' }),
    ).toBeNull();
  });
  it('dead_by_deadline (also rank 9) has no deadline risk left to report', () => {
    expect(
      computeStateDeadlineRisk({
        status: 'dead_by_deadline',
        session: FULL_CALENDAR,
        today: '2026-03-10',
      }),
    ).toBeNull();
  });

  it('graceful degradation: a sineDie-only state (non-priority, M2.1) still gets a sineDie-based risk', () => {
    const risk = computeStateDeadlineRisk({
      status: 'committee',
      session: { sineDie: '2026-05-31' },
      today: '2026-05-20',
    });
    expect(risk).toEqual({
      daysUntil: 11,
      cutoffDate: '2026-05-31',
      cutoffType: 'sineDie',
      isPastCutoff: false,
    });
  });

  it('never fabricates a cutoff: a session with NOTHING curated returns null', () => {
    expect(
      computeStateDeadlineRisk({ status: 'committee', session: {}, today: '2026-05-20' }),
    ).toBeNull();
  });

  it('a bill still in committee past its OWN committee cutoff (status lagged the calendar) falls through to sineDie', () => {
    const risk = computeStateDeadlineRisk({
      status: 'committee',
      session: FULL_CALENDAR,
      today: '2026-03-20', // committeeCutoffDate (03-13) already passed
    });
    // committeeCutoff is in the past, but sineDie (05-31) is still in the future — the future candidate wins.
    expect(risk?.cutoffType).toBe('sineDie');
    expect(risk?.isPastCutoff).toBe(false);
  });

  it('flags isPastCutoff when EVERY candidate cutoff is already behind (status genuinely lagging)', () => {
    const risk = computeStateDeadlineRisk({
      status: 'reported',
      session: { crossoverDate: '2026-04-17', sineDie: '2026-04-20' },
      today: '2026-04-25',
    });
    expect(risk?.isPastCutoff).toBe(true);
    expect(risk?.cutoffType).toBe('sineDie'); // the least-overdue candidate wins
    expect(risk?.daysUntil).toBe(-5);
  });
});
