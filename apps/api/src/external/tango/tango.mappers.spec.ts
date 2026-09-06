import { str } from './tango.mappers.js';

describe('str', () => {
  test('collapses null, undefined and empty/whitespace strings to null', () => {
    expect(str(null)).toBeNull();
    expect(str(undefined)).toBeNull();
    expect(str('')).toBeNull();
    expect(str('   ')).toBeNull();
  });

  test('trims plain text', () => {
    expect(str('  Rio Bonito Bridges  ')).toBe('Rio Bonito Bridges');
  });

  test('numbers and booleans stringify', () => {
    expect(str(42)).toBe('42');
    expect(str(true)).toBe('true');
  });

  test('decodes numeric HTML entities the provider sends in free text', () => {
    // The live defect this guards: a real forecast title came back from
    // Tango as "Rob Jagger&#039;s Rec Site Upgrades/Rio Bonito Bridges".
    expect(str("Rob Jagger&#039;s Rec Site Upgrades/Rio Bonito Bridges")).toBe(
      "Rob Jagger's Rec Site Upgrades/Rio Bonito Bridges",
    );
  });

  test('decodes named entities without corrupting an already-decoded ampersand', () => {
    expect(str('Fit &amp; Finish')).toBe('Fit & Finish');
  });

  test('decodes a hex entity', () => {
    expect(str('Caf&#x00e9;')).toBe('Café');
  });

  test('leaves an unrecognized entity-shaped string untouched rather than dropping it', () => {
    expect(str('Section &foo; here')).toBe('Section &foo; here');
  });
});
