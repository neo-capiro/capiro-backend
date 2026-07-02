import { classifyRunway, type FyFunding } from './procurement-runway.js';

/**
 * Golden fixtures drawn from REAL loaded FY25–FY31 procurement series (millions,
 * from the P-1/P-40 artifacts). Pins the shape vocabulary that drives the
 * Runway Analyzer, portfolio growth metrics, and recommender scoring.
 */

const s = (pairs: Array<[number, number | null]>): FyFunding[] =>
  pairs.map(([fy, amount]) => ({ fy, amount }));

const BY = 2027; // current corpus budget year

describe('classifyRunway — real-line golden fixtures', () => {
  test('6200C02901 HIMARS: FY27 spikes 12x over neighbors -> one_year_plus_up', () => {
    const r = classifyRunway(
      s([[2025, 175.5], [2026, 61.5], [2027, 745.7], [2028, 142.6], [2029, 31.9], [2030, 34.5]]),
      BY,
    );
    expect(r.runway).toBe('one_year_plus_up');
    expect(r.peakFy).toBe(2027);
  });

  test('8260C53101 MSE Missile: $905M -> $8.1B across the FYDP -> ramping', () => {
    const r = classifyRunway(
      s([[2025, 905.1], [2026, 1445.9], [2027, 1297.5], [2028, 7496.5], [2029, 7664.4], [2030, 7879.6], [2031, 8079.0]]),
      BY,
    );
    expect(r.runway).toBe('ramping');
    expect(r.cagr).toBeGreaterThan(0.15);
  });

  test('6005C64400 GMLRS: steady ~$1.0-1.3B every year -> flat', () => {
    const r = classifyRunway(
      s([[2025, 1168.3], [2026, 1125.1], [2027, 1014.9], [2028, 1163.3], [2029, 1104.0], [2030, 1103.2], [2031, 1262.1]]),
      BY,
    );
    expect(r.runway).toBe('flat');
  });

  test('2104C59300 TOW 2: $122M -> $12M and ends -> declining (peak precedes the budget year, so not a cliff)', () => {
    const r = classifyRunway(s([[2025, 122.3], [2026, 11.7]]), BY);
    expect(r.runway).toBe('declining');
    expect(r.cagr).toBeLessThan(-0.15);
  });

  test('stated-zero tail from the budget year -> zeroed', () => {
    const r = classifyRunway(s([[2025, 100], [2026, 50], [2027, 0], [2028, 0]]), BY);
    expect(r.runway).toBe('zeroed');
    expect(r.rationale).toContain('FY2027');
  });

  test('post-budget-year collapse to a sustained low level -> cliff', () => {
    const r = classifyRunway(
      s([[2026, 800], [2027, 1000], [2028, 200], [2029, 180], [2030, 150]]),
      BY,
    );
    expect(r.runway).toBe('cliff');
    expect(r.peakFy).toBe(2027);
  });

  test('first funding in the budget year with stated-zero priors -> new_start', () => {
    // 8046C20200 THAAD-pattern: nothing before FY27, funded from FY27 on.
    const r = classifyRunway(s([[2026, 0], [2027, 907.2], [2028, 5828.7], [2029, 5951.3]]), BY);
    expect(r.runway).toBe('new_start');
    expect(r.firstFundedFy).toBe(2027);
  });

  test('single funded budget year with zero prior -> new_start; lone historic year -> insufficient', () => {
    expect(classifyRunway(s([[2026, 0], [2027, 59.9]]), BY).runway).toBe('new_start');
    expect(classifyRunway(s([[2025, 113.3]]), BY).runway).toBe('insufficient_data');
  });

  test('unstated years are NOT zeros — two funded outyears only classify by shape', () => {
    // SOCOM SKYRAIDER II pattern: only FY27-FY29 stated (priors unstated, not zero).
    const r = classifyRunway(s([[2027, 59.9], [2028, 62.0], [2029, 64.0]]), BY);
    expect(['flat', 'ramping']).toContain(r.runway); // must NOT be new_start without a stated-zero prior
    expect(r.runway).not.toBe('new_start');
  });

  test('empty series -> insufficient_data', () => {
    expect(classifyRunway([], BY).runway).toBe('insufficient_data');
  });
});
