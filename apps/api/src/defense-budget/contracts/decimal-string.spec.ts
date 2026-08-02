import {
  integerToCanonicalString,
  isCanonicalDecimalString,
  moneyToMillionsString,
  parseCanonicalDecimalString,
  scaleDecimalString,
} from './decimal-string.js';

describe('parseCanonicalDecimalString', () => {
  it.each([
    ['1250', '1250'],
    ['1.2500', '1.25'],
    ['007', '7'],
    ['00.5', '0.5'],
    ['-0', '0'],
    ['-0.0', '0'],
    [0, '0'],
    [-0, '0'],
    [1250, '1250'],
    [1.25, '1.25'],
    ['-500', '-500'],
    ['-1.50', '-1.5'],
    ['0.000001', '0.000001'],
    ['10.', '10'],
    ['.5', '0.5'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(parseCanonicalDecimalString(input as string | number)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'abc',
    '1,250',
    '1e3',
    '1E-3',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '--1',
    '1.2.3',
  ])('rejects %j', (input) => {
    expect(() => parseCanonicalDecimalString(input as string | number)).toThrow();
  });

  it('expands exponential number input without exponential notation', () => {
    expect(parseCanonicalDecimalString(1e21)).toBe('1000000000000000000000');
    expect(parseCanonicalDecimalString(1.23e-7)).toBe('0.000000123');
  });
});

describe('isCanonicalDecimalString', () => {
  it.each(['0', '1', '-1', '1.25', '-0.5', '1000000', '0.000001'])('accepts %j', (input) => {
    expect(isCanonicalDecimalString(input)).toBe(true);
  });

  it.each(['-0', '1.2500', '007', '1,000', '1e3', '', 'abc', '1.'])('rejects %j', (input) => {
    expect(isCanonicalDecimalString(input)).toBe(false);
  });
});

describe('scaleDecimalString', () => {
  it.each([
    ['1250', -3, '1.25'],
    ['1250000', -6, '1.25'],
    ['1.25', 0, '1.25'],
    ['-500', -3, '-0.5'],
    ['0', -6, '0'],
    ['1', 3, '1000'],
    ['0.001', 3, '1'],
    ['123.456', -2, '1.23456'],
    ['999', -6, '0.000999'],
    ['5', -1, '0.5'],
  ])('scales %j by %j to %j', (input, places, expected) => {
    expect(scaleDecimalString(input, places)).toBe(expected);
  });

  it('never uses floating-point division (precision-sensitive)', () => {
    // 0.1 + 0.2 style error cannot occur: scaling is pure string movement.
    expect(scaleDecimalString('1.1', -3)).toBe('0.0011');
    expect(scaleDecimalString('2.3', -6)).toBe('0.0000023');
    expect(scaleDecimalString('123456789012345678901234567890', -6)).toBe(
      '123456789012345678901234.56789',
    );
  });
});

describe('moneyToMillionsString', () => {
  it.each([
    ['1250', 'thousands', '1.25'],
    ['1250000', 'dollars', '1.25'],
    ['1.2500', 'millions', '1.25'],
    ['-500', 'thousands', '-0.5'],
    ['0', 'dollars', '0'],
    ['1234567.89', 'thousands', '1234.56789'],
  ] as const)('converts %j %s to %j millions', (value, unit, expected) => {
    expect(moneyToMillionsString(value, unit)).toBe(expected);
  });
});

describe('integerToCanonicalString', () => {
  it('accepts integers', () => {
    expect(integerToCanonicalString('42')).toBe('42');
    expect(integerToCanonicalString(42)).toBe('42');
    expect(integerToCanonicalString('-7')).toBe('-7');
  });

  it('rejects fractional values', () => {
    expect(() => integerToCanonicalString('4.2')).toThrow();
    expect(() => integerToCanonicalString(4.2)).toThrow();
  });
});
