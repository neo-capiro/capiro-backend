import { describe, expect, test } from '@jest/globals';
import type { MappedPeData } from '../../src/defense-budget/assertion-mapper.js';
import {
  assertApprovedShaMatches,
  buildNormalizedValueManifest,
  classifyUnitRatio,
  requireApprovedSha256,
} from './defense-budget-commit.js';

const SHA = 'a'.repeat(64);

describe('exact source SHA approval', () => {
  test('accepts one exact lowercase SHA-256', () => {
    expect(requireApprovedSha256(SHA)).toBe(SHA);
    expect(() => assertApprovedShaMatches(SHA, SHA)).not.toThrow();
  });

  test.each([
    undefined,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    `${'a'.repeat(63)}g`,
  ])('rejects missing or malformed approval %p', (value) => {
    expect(() => requireApprovedSha256(value)).toThrow();
  });

  test('rejects a valid but non-matching approval', () => {
    expect(() => assertApprovedShaMatches('b'.repeat(64), SHA)).toThrow(
      'Approved SHA-256 does not match source bytes',
    );
  });
});

describe('buildNormalizedValueManifest', () => {
  test('keeps original and canonical values adjacent with source-page provenance', () => {
    const mapped: MappedPeData = {
      records: [],
      years: [],
      nonPeLines: [],
      sourceValues: [
        {
          peCode: '0602308A',
          fy: 2027,
          fieldName: 'request',
          valueM: 13.5,
          originalValue: 13_500,
          originalUnit: 'thousands',
          provenance: {
            pdfPage: 10,
            printedPage: 'R-2, page 3',
            exhibit: 'R-2',
            tableLabel: 'Cost ($ in Thousands)',
            rowLabel: 'Total Program Element',
            colLabel: 'FY 2027',
            derivation: 'direct',
            extractionMethod: 'llamaparse',
            confidence: 0.95,
          },
        },
      ],
    };

    expect(buildNormalizedValueManifest(mapped, 'source-document-id')).toEqual([
      {
        peCode: '0602308A',
        fy: 2027,
        fieldName: 'request',
        originalValue: 13_500,
        originalUnit: 'thousands',
        canonicalValueM: 13.5,
        pdfPage: 10,
        printedPage: 'R-2, page 3',
        exhibit: 'R-2',
        tableLabel: 'Cost ($ in Thousands)',
        rowLabel: 'Total Program Element',
        colLabel: 'FY 2027',
        derivation: 'direct',
        extractionMethod: 'llamaparse',
        confidence: 0.95,
        sourceDocumentId: 'source-document-id',
      },
    ]);
  });
});

describe('classifyUnitRatio', () => {
  test('classifies same-scale and both 1,000x directions', () => {
    expect(classifyUnitRatio(100, 100)).toBe('same_scale');
    expect(classifyUnitRatio(100_000, 100)).toBe('candidate_1000x_reference');
    expect(classifyUnitRatio(100, 100_000)).toBe('candidate_1_1000x_reference');
  });

  test('uses a bounded tolerance rather than any broadly large ratio', () => {
    expect(classifyUnitRatio(98_000, 100)).toBe('candidate_1000x_reference');
    expect(classifyUnitRatio(102_000, 100)).toBe('candidate_1000x_reference');
    expect(classifyUnitRatio(50_000, 100)).toBe('different_scale');
  });

  test.each([
    [null, 100],
    [100, null],
    [0, 100],
    [100, 0],
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100],
  ] as const)('does not compare ambiguous values %p / %p', (candidate, reference) => {
    expect(classifyUnitRatio(candidate, reference)).toBe('not_comparable');
  });
});
