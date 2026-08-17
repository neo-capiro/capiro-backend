import { isNamedCompanyV1 } from './r3-named-company-classifier.js';

describe('isNamedCompanyV1', () => {
  it('accepts a company with a legal suffix', () => {
    expect(isNamedCompanyV1('Lockheed Martin Corp')).toBe(true);
    expect(isNamedCompanyV1('Northrop Grumman Systems Corporation')).toBe(true);
    expect(isNamedCompanyV1('Raytheon Technologies Inc')).toBe(true);
  });

  it('accepts a plausible multi-character proper name with no legal suffix', () => {
    expect(isNamedCompanyV1('Boeing')).toBe(true);
    expect(isNamedCompanyV1('General Dynamics')).toBe(true);
  });

  it('refuses placeholder and government-internal labels', () => {
    for (const value of [
      'Various',
      'TBD',
      'N/A',
      'Multiple',
      'Government',
      'Govt',
      'MDA',
      'MIPR',
      'Classified',
      'Allotment',
    ]) {
      expect(isNamedCompanyV1(value)).toBe(false);
    }
  });

  it('refuses blank or whitespace-only input', () => {
    expect(isNamedCompanyV1('')).toBe(false);
    expect(isNamedCompanyV1('   ')).toBe(false);
  });

  it('refuses a multi-state location that bled into the performer column', () => {
    expect(isNamedCompanyV1('AL, CO, CA, VA, Various')).toBe(false);
    expect(isNamedCompanyV1('CA, CO, VA Various')).toBe(false);
  });

  it('refuses a state-code salad with no legal suffix even without the comma prefix pattern', () => {
    expect(isNamedCompanyV1('facility in CA and VA')).toBe(false);
  });

  it('accepts a state-code-bearing string when a legal suffix redeems it', () => {
    expect(isNamedCompanyV1('CA VA Solutions LLC')).toBe(true);
  });

  it('refuses a bare four-character-or-shorter string with no legal suffix', () => {
    expect(isNamedCompanyV1('Acme')).toBe(false);
  });

  it('is case-insensitive on both placeholder and legal-suffix matching', () => {
    expect(isNamedCompanyV1('various')).toBe(false);
    expect(isNamedCompanyV1('boeing company')).toBe(true);
  });

  it('trims surrounding whitespace before classifying', () => {
    expect(isNamedCompanyV1('  Lockheed Martin Corp  ')).toBe(true);
    expect(isNamedCompanyV1('  TBD  ')).toBe(false);
  });
});
