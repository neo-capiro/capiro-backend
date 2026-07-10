import { sessionQueryCost, nextQueriesUsed } from './backfill-legiscan-datasets.js';

describe('sessionQueryCost (2026-07-10 hot-fix: per-session query-cost isolation)', () => {
  it('a non-first session costs exactly its own getDataset call (1)', () => {
    expect(sessionQueryCost(false, 2)).toBe(1);
  });

  it('the first session ALSO carries the one-time state-level cost (getSessionList + getDatasetList)', () => {
    expect(sessionQueryCost(true, 2)).toBe(3);
  });

  it('REGRESSION: summing sessionQueryCost across N sessions equals the TRUE total API calls, never the old quadratic over-count', () => {
    const stateLevelQueries = 2; // getSessionList + getDatasetList
    const sessionCount = 5;
    let total = 0;
    for (let i = 0; i < sessionCount; i++) {
      total += sessionQueryCost(i === 0, stateLevelQueries);
    }
    // True total: 2 state-level + 1 getDataset per session.
    expect(total).toBe(stateLevelQueries + sessionCount);
  });
});

describe('nextQueriesUsed (2026-07-10 hot-fix: month-rollover reset)', () => {
  it('increments when the stored quotaMonth matches the current month', () => {
    expect(nextQueriesUsed('2026-07', '2026-07', 3)).toEqual({ increment: 3 });
  });

  it('REGRESSION: resets (does not increment) on a month rollover, never carrying a prior month spend forward', () => {
    expect(nextQueriesUsed('2026-06', '2026-07', 3)).toBe(3);
  });

  it('resets when there was no prior quotaMonth at all (first-ever run for this cursor via update path)', () => {
    expect(nextQueriesUsed(null, '2026-07', 3)).toBe(3);
    expect(nextQueriesUsed(undefined, '2026-07', 3)).toBe(3);
  });
});
