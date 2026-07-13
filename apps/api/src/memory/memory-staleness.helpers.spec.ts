import { daysOverdue, isReviewDue } from './memory-staleness.helpers.js';

const NOW = new Date('2026-07-13T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('isReviewDue (P2 staleness)', () => {
  it('no cadence set → never due (opt-in)', () => {
    expect(
      isReviewDue(
        { reviewCadenceDays: null, lastConfirmedAt: daysAgo(999), createdAt: daysAgo(999) },
        NOW,
      ),
    ).toBe(false);
    expect(
      isReviewDue({ reviewCadenceDays: 0, lastConfirmedAt: null, createdAt: daysAgo(999) }, NOW),
    ).toBe(false);
  });

  it('due when cadence elapsed since last confirmation', () => {
    expect(
      isReviewDue(
        { reviewCadenceDays: 30, lastConfirmedAt: daysAgo(31), createdAt: daysAgo(400) },
        NOW,
      ),
    ).toBe(true);
    expect(
      isReviewDue(
        { reviewCadenceDays: 30, lastConfirmedAt: daysAgo(10), createdAt: daysAgo(400) },
        NOW,
      ),
    ).toBe(false);
  });

  it('falls back to createdAt when never confirmed', () => {
    expect(
      isReviewDue({ reviewCadenceDays: 30, lastConfirmedAt: null, createdAt: daysAgo(45) }, NOW),
    ).toBe(true);
    expect(
      isReviewDue({ reviewCadenceDays: 90, lastConfirmedAt: null, createdAt: daysAgo(45) }, NOW),
    ).toBe(false);
  });

  it('a fresh confirmation resets the clock even on an old item', () => {
    expect(
      isReviewDue(
        { reviewCadenceDays: 30, lastConfirmedAt: daysAgo(1), createdAt: daysAgo(400) },
        NOW,
      ),
    ).toBe(false);
  });

  it('accepts Date or ISO string; guards NaN anchors', () => {
    expect(
      isReviewDue(
        {
          reviewCadenceDays: 7,
          lastConfirmedAt: new Date(NOW.getTime() - 8 * 86_400_000),
          createdAt: NOW,
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      isReviewDue(
        { reviewCadenceDays: 7, lastConfirmedAt: 'not-a-date', createdAt: 'also-bad' },
        NOW,
      ),
    ).toBe(false);
  });
});

describe('daysOverdue', () => {
  it('0 when not due; positive floor of days past the due date when due', () => {
    expect(
      daysOverdue(
        { reviewCadenceDays: 30, lastConfirmedAt: daysAgo(10), createdAt: daysAgo(400) },
        NOW,
      ),
    ).toBe(0);
    // confirmed 45d ago, cadence 30 → due 15d ago → 15 overdue
    expect(
      daysOverdue(
        { reviewCadenceDays: 30, lastConfirmedAt: daysAgo(45), createdAt: daysAgo(400) },
        NOW,
      ),
    ).toBe(15);
  });
});
