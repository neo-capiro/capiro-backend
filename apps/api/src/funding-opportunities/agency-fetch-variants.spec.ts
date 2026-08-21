import { describe, expect, test } from '@jest/globals';
import { agencyFetchVariants, expandClientNaicsCodes } from './sam-opportunity-relevance.js';

describe('agencyFetchVariants', () => {
  test('expands Department ↔ Dept so award-history agencies reach SAM spellings', () => {
    const variants = agencyFetchVariants(['Department of the Navy']);
    const upper = variants.map((v) => v.toUpperCase());
    expect(upper).toEqual(expect.arrayContaining(['DEPARTMENT OF THE NAVY', 'DEPT OF THE NAVY']));
  });

  test('does not invent a different agency', () => {
    const variants = agencyFetchVariants(['Department of the Navy']);
    expect(variants.join(' ').toUpperCase()).not.toContain('ARMY');
  });

  test('drops blanks', () => {
    expect(agencyFetchVariants(['', '  ', 'NASA'])).toEqual(
      expect.arrayContaining(['NASA', 'NASA'.toUpperCase()]),
    );
    expect(agencyFetchVariants(['', '  '])).toEqual([]);
  });
});

describe('expandClientNaicsCodes', () => {
  test('keeps a full 6-digit code and expands a 5-digit industry code', () => {
    const expanded = expandClientNaicsCodes(['336411', '33641']);
    expect(expanded).toContain('336411');
    expect(expanded).toContain('336410');
    expect(expanded).toContain('336419');
    expect(expanded).not.toContain('541330');
  });
});
