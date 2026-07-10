import { currentQuotaMonth, monthToDateQueries, quotaExhausted } from './legiscan-quota.util.js';

describe('currentQuotaMonth', () => {
  it('formats YYYY-MM', () => {
    expect(currentQuotaMonth(new Date('2026-07-15T12:00:00Z'))).toBe('2026-07');
  });
});

describe('monthToDateQueries', () => {
  it('sums only cursors matching the given month', () => {
    const cursors = [
      { queriesUsed: 100, quotaMonth: '2026-07' },
      { queriesUsed: 50, quotaMonth: '2026-07' },
      { queriesUsed: 9999, quotaMonth: '2026-06' }, // prior month, excluded
      { queriesUsed: 10, quotaMonth: null }, // never touched, excluded
    ];
    expect(monthToDateQueries(cursors, '2026-07')).toBe(150);
  });

  it('returns 0 for an empty cursor set', () => {
    expect(monthToDateQueries([], '2026-07')).toBe(0);
  });
});

describe('quotaExhausted (S1-D acceptance criterion)', () => {
  it('is false below the budget', () => {
    expect(quotaExhausted(27999, 28000)).toBe(false);
  });
  it('is true AT the budget boundary (>=, not >)', () => {
    expect(quotaExhausted(28000, 28000)).toBe(true);
  });
  it('is true above the budget', () => {
    expect(quotaExhausted(30000, 28000)).toBe(true);
  });
});
