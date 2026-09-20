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
