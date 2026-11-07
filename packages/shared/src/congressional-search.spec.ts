import { parseBillDesignation, parseBillId, parseBillSearchSelector } from './index.js';

describe('exact federal search selector', () => {
  test.each(['S. 999999', 's999999', '119-s-999999', '119 S999999', '119S999999', 'S. 999999 (119th)'])(
    'preserves every digit in %s', query => expect(parseBillSearchSelector(query, 119)).toEqual({ kind: 'exact', billId: '119-s-999999' }),
  );
  test('explicit Congress binds bare selectors and cannot override an embedded Congress', () => {
    expect(parseBillSearchSelector('S. 2809', 119, 118)).toEqual({ kind: 'exact', billId: '118-s-2809' });
    for (const query of ['119-s-2809', 'S. 2809 (119th)', '119S2809']) expect(parseBillSearchSelector(query, 119, 118)).toEqual({ kind: 'invalid' });
    expect(parseBillSearchSelector('118 S2809 (119th)', 119)).toEqual({ kind: 'invalid' });
  });
  test.each(['S. 2809x', 'S. 28.09', '119-s-2809-extra', 'S. -1', 'S. 0', 'S. 9007199254740992', 'S. 1' + ' '.repeat(240) + 'extra'])(
    'refuses malformed or truncated literal %s', query => expect(parseBillSearchSelector(query, 119)).toEqual({ kind: 'invalid' }),
  );
  test('safe integer boundary stays exact and topic queries remain separate', () => {
    expect(parseBillSearchSelector('S. 9007199254740991', 119)).toEqual({ kind: 'exact', billId: '119-s-9007199254740991' });
    for (const query of ['mineral supply chains', 'S corporation tax', '', null]) expect(parseBillSearchSelector(query, 119)).toEqual({ kind: 'topic' });
  });
  test('status and text-read helpers retain their existing five-digit grammar', () => {
    expect(parseBillDesignation('S. 999999', 119)).toBeNull();
    expect(parseBillId('119-s-999999')).toBeNull();
    expect(parseBillDesignation('S. 99999', 119)).toEqual({ congress: 119, type: 's', number: 99999 });
  });
});

it.each([1, 9, 999])('combined next-batch identity keeps search-only six-digit numbers in Congress %s', (congress) => {
  for (const raw of [`${congress}-s-999999`, `${congress} S. 999999`, `S. 999999 (${congress}th)`])
    expect(parseBillSearchSelector(raw, 119)).toEqual({ kind: 'exact', billId: `${congress}-s-999999` });
});
it.each(['0-s-1', '1000-s-1', '1000 S. 1'])('combined selector refuses out-of-range literal %s', (raw) => {
  expect(parseBillSearchSelector(raw, 119)).toEqual({ kind: 'invalid' });
});
