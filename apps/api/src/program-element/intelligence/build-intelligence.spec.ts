import { buildIntelligence, pickBudgetYear, type YearRowLike } from './build-intelligence.js';

const y = (fy: number, p: Partial<YearRowLike>): YearRowLike => ({
  fy,
  request: null,
  hascMark: null,
  sascMark: null,
  hacDMark: null,
  sacDMark: null,
  conference: null,
  enacted: null,
  ...p,
});

describe('pickBudgetYear', () => {
  test('latest FY with a stated request wins; mark-only lines fall back to max fy', () => {
    expect(pickBudgetYear([y(2026, { request: 5 }), y(2027, { request: 10 })])).toBe(2027);
    expect(pickBudgetYear([y(2027, { request: 10 }), y(2028, { enacted: 3 })])).toBe(2027);
    expect(pickBudgetYear([y(2026, { hascMark: 5 })])).toBe(2026);
    expect(pickBudgetYear([])).toBeNull();
  });
});

describe('buildIntelligence — full pipeline over year rows', () => {
  test('0603680N-shape: House add + ramping series + RDT&E BA3 prototype', () => {
    const r = buildIntelligence({
      appropriationType: 'RDT&E',
      budgetActivity: 'BA 03',
      years: [
        y(2025, { enacted: 60 }),
        y(2026, { enacted: 70, conference: 70 }),
        y(2027, { request: 79.132, hascMark: 116.632, sascMark: 79.132 }),
      ],
    });
    expect(r.budgetYearFy).toBe(2027);
    expect(r.posture?.posture).toBe('plus_up_defense');
    expect(r.posture?.action).toBe('defend_house_add');
    expect(r.maturity.stage).toBe('prototype');
    expect(r.runway).not.toBeNull();
  });

  test('procurement line with stated outyears feeds the runway FYDP tail', () => {
    const r = buildIntelligence({
      appropriationType: 'PROC',
      budgetActivity: 'BA 01',
      years: [y(2025, { enacted: 905.1 }), y(2026, { enacted: 1445.9 }), y(2027, { request: 1297.5 })],
      outyears: [
        { fy: 2028, amount: 7496.5 },
        { fy: 2029, amount: 7664.4 },
        { fy: 2030, amount: 7879.6 },
      ],
    });
    expect(r.runway?.runway).toBe('ramping');
    expect(r.maturity.stage).toBe('procurement');
    expect(r.maturity.hasBuyLine).toBe(true);
  });

  test('zeroed-after-funding anomaly surfaces from prior-year request', () => {
    const r = buildIntelligence({
      appropriationType: 'PROC',
      budgetActivity: null,
      years: [y(2026, { request: 439.1 }), y(2027, { request: 0 })],
    });
    expect(r.anomalies.map((a) => a.type)).toContain('zeroed_after_funding');
  });

  test('empty line: nulls everywhere, honest insufficient verdicts', () => {
    const r = buildIntelligence({ appropriationType: null, budgetActivity: null, years: [] });
    expect(r.budgetYearFy).toBeNull();
    expect(r.posture).toBeNull();
    expect(r.runway).toBeNull();
    expect(r.maturity.stage).toBe('unknown');
    expect(r.anomalies).toEqual([]);
  });

  test('prior years prefer enacted over conference over request in the series', () => {
    const r = buildIntelligence({
      appropriationType: 'OM',
      budgetActivity: 'BA 01',
      years: [
        y(2025, { request: 90, conference: 95, enacted: 100 }),
        y(2026, { request: 100, conference: 105 }),
        y(2027, { request: 110 }),
      ],
    });
    expect(r.maturity.stage).toBe('sustainment');
    // flat-ish series (100 -> 105 -> 110): must not be classified as anything dramatic
    expect(['flat', 'ramping']).toContain(r.runway?.runway);
  });
});
