import { parseCsvRecords } from './district-nexus-csv.js';

describe('parseCsvRecords', () => {
  test('parses BOM, CRLF and ordinary fields', () => {
    expect(parseCsvRecords('\uFEFFname,state\r\nPlant A,OH\r\n')).toEqual([
      { name: 'Plant A', state: 'OH' },
    ]);
  });

  test('supports quoted commas, newlines and escaped quotes', () => {
    expect(
      parseCsvRecords('name,notes\n"Supplier, LLC","Line one\nLine ""two"""\n'),
    ).toEqual([{ name: 'Supplier, LLC', notes: 'Line one\nLine "two"' }]);
  });

  test('tolerates ragged rows and ignores blank rows', () => {
    expect(parseCsvRecords('a,b,c\n1,2\n\n3,4,5,ignored\n')).toEqual([
      { a: '1', b: '2', c: '' },
      { a: '3', b: '4', c: '5' },
    ]);
  });

  test('rejects an unterminated quoted field', () => {
    expect(() => parseCsvRecords('name\n"broken')).toThrow('unterminated quoted field');
  });
});
