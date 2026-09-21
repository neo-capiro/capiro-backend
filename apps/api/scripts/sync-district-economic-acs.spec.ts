import { positiveEconomicMarginOrNull } from './district-economic-source.js';
import { normalizeAcsValue } from './sync-district-economic-acs.js';

describe('normalizeAcsValue', () => {
  it.each(['-222222222', '-333333333', '-555555555', '-666666666', '-888888888', '-999999999'])(
    'treats Census special value %s as unavailable',
    (value) => {
      expect(normalizeAcsValue(value)).toBeNull();
    },
  );

  it('preserves valid zero and positive values', () => {
    expect(normalizeAcsValue('0')).toBe(0);
    expect(normalizeAcsValue('42.5')).toBe(42.5);
  });
});

describe('positiveEconomicMarginOrNull', () => {
  it.each([-555555555, -1, 0, null, undefined])('normalizes %s to null', (value) => {
    expect(positiveEconomicMarginOrNull(value)).toBeNull();
  });

  it('preserves a valid positive margin', () => {
    expect(positiveEconomicMarginOrNull(1234)).toBe(1234);
  });
});
