import { congressGovBillUrl, formatBillId, isValidCanonicalId, normalizeCanonicalId, parseBillDesignation, parseBillId } from './index.js';

describe('positive bounded congressional identity', () => {
  it.each([1, 9, 10, 118, 999])('round-trips Congress %s across canonical and designation forms', (congress) => {
    const id = formatBillId(congress, 's', 1)!;
    expect(isValidCanonicalId('billId', id)).toBe(true);
    expect(parseBillId(id)).toEqual({ congress, type: 's', number: 1 });
    expect(parseBillDesignation(`S. 1 (${congress}th)`, 119)).toEqual({ congress, type: 's', number: 1 });
    expect(parseBillDesignation('S. 1', congress)).toEqual({ congress, type: 's', number: 1 });
  });
  it.each(['0-s-1', '00-s-1', '000-s-1', '1000-s-1', '119-s-0', '119-s-00000'])('refuses invalid identity %s', (id) => {
    expect(isValidCanonicalId('billId', id)).toBe(false);
    expect(parseBillId(id)).toBeNull();
    expect(congressGovBillUrl(id)).toBeNull();
  });
  it.each([
    ['1-s-1', 'https://www.congress.gov/bill/1st-congress/senate-bill/1'],
    ['009-s-00001', 'https://www.congress.gov/bill/9th-congress/senate-bill/1'],
    [' 119-HJRES-00002 ', 'https://www.congress.gov/bill/119th-congress/house-joint-resolution/2'],
  ])('uses canonical identity for public URL %s', (id, expected) => {
    expect(congressGovBillUrl(id)).toBe(expected);
  });
  it('preserves positive existing zero-padded canonical spellings idempotently', () => {
    const id = normalizeCanonicalId('billId', ' 009-S-00001 ');
    expect(id).toBe('009-s-00001');
    expect(normalizeCanonicalId('billId', id)).toBe(id);
    expect(isValidCanonicalId('billId', id)).toBe(true);
    expect(parseBillId(id)).toEqual({ congress: 9, type: 's', number: 1 });
  });
  it.each([0, 1000])('refuses out-of-range Congress %s in designation and formatter', (congress) => {
    expect(parseBillDesignation('S. 1', congress)).toBeNull();
    expect(formatBillId(congress, 's', 1)).toBeNull();
  });
});
