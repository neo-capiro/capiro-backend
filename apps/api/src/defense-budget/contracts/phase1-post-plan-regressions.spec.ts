import type {
  ExtractionResult,
  ValueProvenance,
} from '../extractors/types.js';
import { adaptExtractionResultToArtifactV1 } from './adapters/extraction-result-v1.adapter.js';
import { adaptR1ArtifactToArtifactV1 } from './adapters/r1-artifact-v1.adapter.js';
import {
  adaptCommitteeArtifactToArtifactV1,
  CommitteeAdapterContextMismatchError,
} from './adapters/committee-artifact-v1.adapter.js';
import { adapterTestContext } from './adapters/testing-helpers.js';
import { assertionIdV1, factIdV1, warningIdV1 } from './artifact-builders.js';
import {
  computeArtifactContentSha256,
  computeArtifactSummary,
  validateDefenseBudgetExtractionArtifactV1,
} from './extraction-artifact-v1.semantic.js';
import type { DefenseBudgetExtractionArtifactV1 } from './extraction-artifact-v1.js';
import { buildMinimalArtifact } from './testing-helpers.js';

function provenance(): ValueProvenance {
  return {
    pdfPage: 7,
    exhibit: 'R-1',
    derivation: 'direct',
    extractionMethod: 'deterministic_pdfplumber',
    confidence: 0.9,
  };
}

function reseal(
  artifact: DefenseBudgetExtractionArtifactV1,
): DefenseBudgetExtractionArtifactV1 {
  const summary = computeArtifactSummary(artifact);
  const withSummary = { ...artifact, summary };
  const contentSha256 = computeArtifactContentSha256(withSummary);
  return {
    ...withSummary,
    contentSha256,
    artifactId: `dbx1_${contentSha256}`,
  };
}

function errorCodes(artifact: DefenseBudgetExtractionArtifactV1): string[] {
  return validateDefenseBudgetExtractionArtifactV1(artifact)
    .filter((finding) => finding.severity === 'error')
    .map((finding) => finding.code);
}

describe('Phase 1 post-plan correctness regressions', () => {
  it('preserves money, quantity, and text when one legacy year row represents all three', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2099,
          fieldName: 'request',
          money: { value: 1250, unit: 'thousands' },
          quantity: 3,
          valueText: 'three prototypes',
          provenance: provenance(),
        },
      ],
      warnings: [],
    };

    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    expect(artifact.sourceFacts.map((fact) => fact.sourcePath)).toEqual(
      expect.arrayContaining([
        'yearValues[0].money',
        'yearValues[0].quantity',
        'yearValues[0].valueText',
      ]),
    );
    expect(artifact.assertions.filter((value) => value.assertionKind === 'funding')).toHaveLength(1);
    expect(artifact.assertions.filter((value) => value.assertionKind === 'quantity')).toHaveLength(1);
    expect(
      artifact.assertions.filter((value) => value.assertionKind === 'document_fact'),
    ).toHaveLength(1);
    expect(
      artifact.warnings.some(
        (warning) => warning.code === 'legacy_year_value_multiple_representations',
      ),
    ).toBe(true);
    expect(artifact.omissions).toHaveLength(0);
  });

  it('does not partially parse malformed R-1 fiscal-year keys and does not drop null cells', () => {
    const artifact = adaptR1ArtifactToArtifactV1(
      {
        docType: 'R-1',
        pageCount: 10,
        rows: [
          {
            peCode: '0602308A',
            title: 'Test PE',
            budgetActivity: null,
            lineNumber: null,
            page: 3,
            fyColumns: {
              '2027junk': 100,
              '2028': null,
            },
          },
        ],
        unparsed_pages: [],
        stats: { rows: 1, pages_with_rows: 1 },
      },
      adapterTestContext(),
      { fundingUnit: 'thousands' },
    );

    const malformed = artifact.sourceFacts.find(
      (fact) => fact.sourcePath === 'rows[0].fyColumns["2027junk"]',
    );
    const missing = artifact.sourceFacts.find(
      (fact) => fact.sourcePath === 'rows[0].fyColumns["2028"]',
    );
    expect(malformed).toBeDefined();
    expect(missing).toBeDefined();
    expect(
      artifact.omissions.find((omission) => omission.sourceFactId === malformed!.factId)?.reason,
    ).toBe('invalid_number');
    expect(
      artifact.omissions.find((omission) => omission.sourceFactId === missing!.factId)?.reason,
    ).toBe('missing_value');
    expect(artifact.assertions.filter((value) => value.assertionKind === 'funding')).toHaveLength(0);
    expect(artifact.summary.completenessStatus).toBe('incomplete');
  });

  it('does not let committee mode relabel the source authority', () => {
    expect(() =>
      adaptCommitteeArtifactToArtifactV1(
        {
          rows: [
            {
              peCode: '0602308A',
              fy: 2099,
              mark: 100,
              markUnit: 'dollars',
            },
          ],
        },
        adapterTestContext({
          family: 'public_law',
          exhibit: 'public_law',
          authority: 'public_law',
        }),
        { mode: 'HASC', defaultFiscalYear: 2099 },
      ),
    ).toThrow(CommitteeAdapterContextMismatchError);
  });

  it('does not let an unrelated duplicate warning waive multi-consumption validation', () => {
    const base = buildMinimalArtifact();
    const evidenceId = base.evidence[0]!.evidenceId;
    const moneyFactId = factIdV1({
      sourcePath: 'rows[1].money',
      category: 'money',
      rawValue: '1000',
    });
    const firstAssertion = {
      assertionId: assertionIdV1({ kind: 'funding', sourcePath: 'rows[1].money', copy: 1 }),
      assertionKind: 'funding' as const,
      identity: { lineKind: 'RDTE_PE' as const, peCode: '0602308A' },
      fiscalYear: 2099,
      field: 'request' as const,
      money: {
        originalValue: '1000',
        originalUnit: 'thousands' as const,
        valueMillions: '1',
      },
      sourceFactIds: [moneyFactId],
      evidenceIds: [evidenceId],
      confidence: 1,
    };
    const secondAssertion = {
      ...firstAssertion,
      assertionId: assertionIdV1({ kind: 'funding', sourcePath: 'rows[1].money', copy: 2 }),
      field: 'hascMark' as const,
    };
    const unrelatedFactId = base.sourceFacts[0]!.factId;
    const artifact = reseal({
      ...base,
      sourceFacts: [
        ...base.sourceFacts,
        {
          factId: moneyFactId,
          sourcePath: 'rows[1].money',
          category: 'money',
          requiredForCompleteness: true,
          rawValue: '1000',
          evidenceIds: [evidenceId],
        },
      ],
      assertions: [...base.assertions, firstAssertion, secondAssertion],
      warnings: [
        {
          warningId: warningIdV1({ code: 'duplicate_unrelated', sourceFactId: unrelatedFactId }),
          code: 'duplicate_unrelated',
          severity: 'review',
          message: 'an unrelated duplicate was retained',
          sourceFactIds: [unrelatedFactId],
          evidenceIds: [evidenceId],
        },
      ],
    });

    expect(errorCodes(artifact)).toContain('fact_consumed_by_multiple_value_assertions');
  });

  it('allows an explicit duplicate warning only for the exact multiply-consumed fact', () => {
    const base = buildMinimalArtifact();
    const evidenceId = base.evidence[0]!.evidenceId;
    const moneyFactId = factIdV1({
      sourcePath: 'rows[1].money',
      category: 'money',
      rawValue: '1000',
    });
    const firstAssertion = {
      assertionId: assertionIdV1({ kind: 'funding', sourcePath: 'rows[1].money', copy: 1 }),
      assertionKind: 'funding' as const,
      identity: { lineKind: 'RDTE_PE' as const, peCode: '0602308A' },
      fiscalYear: 2099,
      field: 'request' as const,
      money: {
        originalValue: '1000',
        originalUnit: 'thousands' as const,
        valueMillions: '1',
      },
      sourceFactIds: [moneyFactId],
      evidenceIds: [evidenceId],
      confidence: 1,
    };
    const artifact = reseal({
      ...base,
      sourceFacts: [
        ...base.sourceFacts,
        {
          factId: moneyFactId,
          sourcePath: 'rows[1].money',
          category: 'money',
          requiredForCompleteness: true,
          rawValue: '1000',
          evidenceIds: [evidenceId],
        },
      ],
      assertions: [
        ...base.assertions,
        firstAssertion,
        {
          ...firstAssertion,
          assertionId: assertionIdV1({
            kind: 'funding',
            sourcePath: 'rows[1].money',
            copy: 2,
          }),
          field: 'hascMark' as const,
        },
      ],
      warnings: [
        {
          warningId: warningIdV1({ code: 'duplicate_source_value', sourceFactId: moneyFactId }),
          code: 'duplicate_source_value',
          severity: 'review',
          message: 'the exact source fact intentionally feeds retained alternatives',
          sourceFactIds: [moneyFactId],
          evidenceIds: [evidenceId],
        },
      ],
    });

    expect(errorCodes(artifact)).not.toContain('fact_consumed_by_multiple_value_assertions');
  });

  it('requires a parser page range for page-addressable evidence', () => {
    const base = buildMinimalArtifact();
    const artifact = reseal({
      ...base,
      parserRuns: [{ ...base.parserRuns[0]!, pageRanges: [] }],
    });

    expect(errorCodes(artifact)).toContain('evidence_page_without_parser_range');
  });

  it('rejects calendar-impossible milestone dates that merely match ISO shape', () => {
    const base = buildMinimalArtifact();
    const evidenceId = base.evidence[0]!.evidenceId;
    const factId = factIdV1({
      sourcePath: 'rows[1].milestone',
      category: 'milestone',
      rawValue: '2099-02-30',
    });
    const artifact = reseal({
      ...base,
      sourceFacts: [
        ...base.sourceFacts,
        {
          factId,
          sourcePath: 'rows[1].milestone',
          category: 'milestone',
          requiredForCompleteness: true,
          rawValue: '2099-02-30',
          evidenceIds: [evidenceId],
        },
      ],
      assertions: [
        ...base.assertions,
        {
          assertionId: assertionIdV1({ kind: 'milestone', sourcePath: 'rows[1].milestone' }),
          assertionKind: 'milestone',
          parentPeCode: '0602308A',
          milestoneType: 'IOC',
          plannedDate: '2099-02-30',
          sourceFactIds: [factId],
          evidenceIds: [evidenceId],
          confidence: 1,
        },
      ],
    });

    expect(errorCodes(artifact)).toContain('invalid_date_format');
  });
});
