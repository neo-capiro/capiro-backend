import { houseRollId, resolveHouseBillId } from './sync-house-votes';

describe('houseRollId', () => {
  it('formats the canonical roll id', () => {
    expect(houseRollId(119, 1, 240)).toBe('house-119-1-240');
  });
});

describe('resolveHouseBillId', () => {
  it('maps legislationType+number to a canonical bill id (incl. rule hres)', () => {
    expect(resolveHouseBillId(119, 'HR', '3424')).toBe('119-hr-3424');
    expect(resolveHouseBillId(119, 'HRES', '1398')).toBe('119-hres-1398'); // the NDAA rule
    expect(resolveHouseBillId(119, 'S', '1')).toBe('119-s-1');
    expect(resolveHouseBillId(119, 'HJRES', '20')).toBe('119-hjres-20');
  });
  it('returns null for non-bill measures / malformed input', () => {
    expect(resolveHouseBillId(119, 'PN', '5')).toBeNull(); // nomination — not a bill type
    expect(resolveHouseBillId(119, null, '3424')).toBeNull();
    expect(resolveHouseBillId(119, 'HR', 'abc')).toBeNull();
    expect(resolveHouseBillId(119, 'HR', null)).toBeNull();
  });
});
