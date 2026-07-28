import { describe, expect, test } from '@jest/globals';
import type { MappedPeData } from '../../src/defense-budget/assertion-mapper.js';
import {
  assertApprovedShaMatches,
  buildNormalizedValueManifest,
  classifyUnitAuditFinding,
  classifyUnitRatio,
  requireApprovedSha256,
  selectPromotedObservationId,
  type UnitRatioClassification,
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

  const ambiguousCases: Array<[number | null, number | null]> = [
    [null, 100],
    [100, null],
    [0, 100],
    [100, 0],
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100],
  ];

  test.each(ambiguousCases)(
    'does not compare ambiguous values %p / %p',
    (candidate, reference) => {
      expect(classifyUnitRatio(candidate, reference)).toBe('not_comparable');
    },
  );

  // A positive figure and a negative one are different facts, not the same figure
  // at a different scale. Comparing magnitudes alone would report these as 1,000x
  // candidates and let a sign mismatch become "proven" corruption.
  test.each([
    [13_500, -13.5],
    [-13_500, 13.5],
    [100, -100],
    [-100, 100],
    [-100, 100_000],
  ])('treats opposite signs %p / %p as a sign mismatch, never a scale candidate', (
    candidate,
    reference,
  ) => {
    expect(classifyUnitRatio(candidate, reference)).toBe('sign_mismatch');
  });

  test('still classifies same-signed negative pairs by scale', () => {
    expect(classifyUnitRatio(-13_500, -13.5)).toBe('candidate_1000x_reference');
    expect(classifyUnitRatio(-100, -100)).toBe('same_scale');
  });
});

describe('selectPromotedObservationId fail-closed linking', () => {
  const label = '0602308A FY2027 request';

  test('links the single observation created by this promotion', () => {
    expect(
      selectPromotedObservationId({
        preExistingIds: ['old-1', 'old-2'],
        candidates: [
          { id: 'old-1', sourceDocumentId: 'doc-old' },
          { id: 'new-1', sourceDocumentId: null },
        ],
        label,
      }),
    ).toBe('new-1');
  });

  // The historical rows this must never adopt are precisely the ones that look
  // like fresh output: same PE/FY/field/source, sourceDocumentId still null.
  test('never adopts a historical observation whose sourceDocumentId is null', () => {
    expect(() =>
      selectPromotedObservationId({
        preExistingIds: ['historical-null'],
        candidates: [{ id: 'historical-null', sourceDocumentId: null }],
        label,
      }),
    ).toThrow('found 0');
  });

  test('leaves a historical null-linked row untouched while linking the new one', () => {
    const chosen = selectPromotedObservationId({
      preExistingIds: ['historical-null'],
      candidates: [
        { id: 'historical-null', sourceDocumentId: null },
        { id: 'fresh', sourceDocumentId: null },
      ],
      label,
    });
    expect(chosen).toBe('fresh');
    expect(chosen).not.toBe('historical-null');
  });

  test('fails closed when the writer produced no new observation', () => {
    expect(() =>
      selectPromotedObservationId({ preExistingIds: [], candidates: [], label }),
    ).toThrow('Expected exactly one new canonical observation for 0602308A FY2027 request; found 0');
  });

  test('fails closed when the match is ambiguous', () => {
    expect(() =>
      selectPromotedObservationId({
        preExistingIds: [],
        candidates: [
          { id: 'a', sourceDocumentId: null },
          { id: 'b', sourceDocumentId: null },
        ],
        label,
      }),
    ).toThrow('found 2');
  });

  test('ignores a candidate that is already linked to a source document', () => {
    expect(() =>
      selectPromotedObservationId({
        preExistingIds: [],
        candidates: [{ id: 'already-linked', sourceDocumentId: 'doc-1' }],
        label,
      }),
    ).toThrow('found 0');
  });

  test('reports the PE/FY/field in the failure so an operator can locate it', () => {
    expect(() =>
      selectPromotedObservationId({
        preExistingIds: [],
        candidates: [],
        label: '0603790F FY2026 hascMark',
      }),
    ).toThrow('0603790F FY2026 hascMark');
  });
});

describe('classifyUnitAuditFinding proof rule', () => {
  const documented = { hasArchiveProof: true, hasMatchingParseProof: true };

  test('proves affection only with a llama canonical winner, 1000x comparator, and full linkage', () => {
    expect(
      classifyUnitAuditFinding({
        canonicalIsLlama: true,
        classifications: ['candidate_1000x_reference'],
        ...documented,
      }).bucket,
    ).toBe('provenAffected');
  });

  test.each([
    ['missing archive proof', { hasArchiveProof: false, hasMatchingParseProof: true }],
    ['missing parse proof', { hasArchiveProof: true, hasMatchingParseProof: false }],
    ['no documentary proof at all', { hasArchiveProof: false, hasMatchingParseProof: false }],
  ])('never proves affection with %s', (_label, proof) => {
    const verdict = classifyUnitAuditFinding({
      canonicalIsLlama: true,
      classifications: ['candidate_1000x_reference'],
      ...proof,
    });
    expect(verdict.bucket).toBe('needsHumanReview');
    expect(verdict.reason).toContain('provenance is incomplete');
  });

  test('a sign mismatch is never proven corruption', () => {
    const verdict = classifyUnitAuditFinding({
      canonicalIsLlama: true,
      classifications: ['sign_mismatch'],
      ...documented,
    });
    expect(verdict.bucket).toBe('needsHumanReview');
  });

  test.each<[UnitRatioClassification]>([
    ['different_scale'],
    ['not_comparable'],
    ['candidate_1_1000x_reference'],
  ])('magnitude alone does not prove affection: %s', (classification) => {
    expect(
      classifyUnitAuditFinding({
        canonicalIsLlama: true,
        classifications: [classification],
        ...documented,
      }).bucket,
    ).toBe('needsHumanReview');
  });

  test('a non-llama canonical winner is not affected', () => {
    const verdict = classifyUnitAuditFinding({
      canonicalIsLlama: false,
      classifications: ['candidate_1000x_reference'],
      ...documented,
    });
    expect(verdict.bucket).toBe('notAffected');
    expect(verdict.reason).toContain('not the recorded canonical field winner');
  });

  test('a documented same-scale comparator disproves affection', () => {
    expect(
      classifyUnitAuditFinding({
        canonicalIsLlama: true,
        classifications: ['same_scale'],
        ...documented,
      }).bucket,
    ).toBe('notAffected');
  });

  test('no comparator at all requires human review', () => {
    const verdict = classifyUnitAuditFinding({
      canonicalIsLlama: true,
      classifications: [],
      ...documented,
    });
    expect(verdict.bucket).toBe('needsHumanReview');
    expect(verdict.reason).toContain('no same-field deterministic comparator');
  });

  test('a 1000x comparator still proves affection alongside an unrelated ambiguous one', () => {
    expect(
      classifyUnitAuditFinding({
        canonicalIsLlama: true,
        classifications: ['not_comparable', 'candidate_1000x_reference'],
        ...documented,
      }).bucket,
    ).toBe('provenAffected');
  });
});
