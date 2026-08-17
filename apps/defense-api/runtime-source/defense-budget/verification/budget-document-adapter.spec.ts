import {
  buildBudgetDocumentFromExtraction,
  buildBudgetDocumentFromMappedExtraction,
  buildExtractionDiagnostics,
  evidenceForAssertion,
  sourceLineKindFromClassification,
} from './budget-document-adapter.js';
import { verifyBudgetDocument } from './budget-verification.js';
import type { DocClassification } from '../document-classifier.js';
import type { ExtractionResult, ValueProvenance } from '../extractors/types.js';

const SHA = 'b'.repeat(64);

const prov = (over: Partial<ValueProvenance> = {}): ValueProvenance => ({
  pdfPage: 12,
  exhibit: 'R-2',
  derivation: 'direct',
  extractionMethod: 'llamaparse',
  confidence: 0.95,
  rowLabel: 'Advanced Technology',
  colLabel: 'FY 2027 Discretionary Request',
  ...over,
});

function classification(over: Partial<DocClassification> = {}): DocClassification {
  return {
    sourceKey: 'rdte_vol_1_budget_activity_1',
    family: 'rdte',
    exhibit: 'R-2',
    authority: 'dod-comptroller',
    component: 'ARMY',
    fiscalYear: 2027,
    budgetCycle: 'pb',
    documentType: 'r2',
    ...over,
  };
}

function cleanExtraction(): ExtractionResult {
  return {
    lineAssertions: [
      {
        lineKind: 'RDTE_PE',
        code: '0602308A',
        title: 'Advanced Technology',
        component: 'ARMY',
        provenance: prov(),
      },
    ],
    yearValues: [
      {
        lineKind: 'RDTE_PE',
        code: '0602308A',
        fy: 2027,
        fieldName: 'request',
        money: { value: 1250, unit: 'thousands' },
        provenance: prov(),
      },
    ],
    warnings: [],
  };
}

const archive = {
  bucket: 'capiro-defense-budget-raw-dev-967807252336',
  key: 'incoming/fy2027/RDTE_Vol_1_Budget_Activity_1.pdf',
  versionId: 'version-abc',
  sha256: SHA,
};

function build(extraction: ExtractionResult, cls = classification()) {
  return buildBudgetDocumentFromExtraction({
    classification: cls,
    extraction,
    sourceDocumentId: 'src-doc-1',
    sourceSha256: SHA,
    archive,
    parse: {
      id: 'parse-job-1',
      provider: 'llamaparse',
      status: 'succeeded',
      inputSha256: SHA,
      outputJsonKey: 'derived/parsed.pages-all.json',
    },
  });
}

describe('sourceLineKindFromClassification', () => {
  it('maps classifier exhibits to line identity without collapsing procurement into PE', () => {
    expect(sourceLineKindFromClassification(classification({ exhibit: 'R-2' }))).toBe('RDTE_PE');
    expect(sourceLineKindFromClassification(classification({ exhibit: 'P-40' }))).toBe(
      'PROCUREMENT_BLIN',
    );
    expect(sourceLineKindFromClassification(classification({ exhibit: 'OP-5' }))).toBe('OM_SAG');
    expect(sourceLineKindFromClassification(classification({ exhibit: 'committee_report' }))).toBe(
      'RDTE_PE',
    );
    expect(sourceLineKindFromClassification(classification({ exhibit: null }))).toBe('UNKNOWN');
  });
});

describe('buildExtractionDiagnostics', () => {
  it('counts accepted and dropped money assertions and reconciles exactly', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2027,
          fieldName: 'request',
          money: { value: 100, unit: 'thousands' },
          provenance: prov(),
        },
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2027,
          fieldName: 'quantity',
          quantity: 4,
          provenance: prov(),
        },
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2027,
          fieldName: 'request',
          money: { value: Number.NaN, unit: 'thousands' },
          provenance: prov(),
        },
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2027,
          fieldName: 'request',
          money: { value: 5, unit: 'billions' } as never,
          provenance: prov(),
        },
      ],
      warnings: ['unit header ambiguous on page 9'],
    };
    const diag = buildExtractionDiagnostics(extraction);
    expect(diag.sourceYearValueCount).toBe(4);
    expect(diag.sourceMoneyAssertionCount).toBe(3);
    expect(diag.acceptedMoneyAssertionCount).toBe(1);
    expect(diag.sourceMoneyAssertionCount).toBe(
      diag.acceptedMoneyAssertionCount +
        diag.droppedMoneyAssertions.filter((d) => d.reason !== 'unsupported_field').length -
        0,
    );
    expect(diag.droppedMoneyAssertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldName: 'quantity', reason: 'unsupported_field' }),
        expect.objectContaining({ reason: 'non_finite_value' }),
        expect.objectContaining({ reason: 'unsupported_unit' }),
      ]),
    );
    expect(diag.parserWarnings).toEqual(['unit header ambiguous on page 9']);
  });
});

describe('buildBudgetDocumentFromExtraction', () => {
  it('emits page_only evidence with no bounding box and truthful llamaparse provenance', () => {
    const doc = build(cleanExtraction());
    expect(doc.extractionDiagnostics.acceptedMoneyAssertionCount).toBe(1);
    expect(doc.rows[0]?.cells[0]?.evidence).toEqual(
      expect.objectContaining({
        granularity: 'page_only',
        extractionMethod: 'llamaparse',
        page: 12,
      }),
    );
    expect(doc.rows[0]?.cells[0]?.evidence.boundingBox).toBeUndefined();
    expect(doc.columns[0]?.evidence.boundingBox).toBeUndefined();
  });

  it('keeps deterministic_pdfplumber provenance truthful', () => {
    const extraction = cleanExtraction();
    extraction.yearValues[0]!.provenance = prov({ extractionMethod: 'deterministic_pdfplumber' });
    const doc = build(extraction);
    expect(doc.rows[0]?.cells[0]?.evidence.extractionMethod).toBe('deterministic_pdfplumber');
  });

  it('structurally validates a clean PE-only candidate end to end', () => {
    const result = verifyBudgetDocument(build(cleanExtraction()));
    expect(result.status).toBe('STRUCTURALLY_VALIDATED');
    expect(result.normalizedRecords).toEqual([
      expect.objectContaining({
        peCode: '0602308A',
        fy: 2027,
        field: 'request',
        valueMillions: 1.25,
        granularity: 'page_only',
      }),
    ]);
  });

  it('rejects an extraction whose only money assertion is NaN', () => {
    const extraction = cleanExtraction();
    extraction.yearValues[0]!.money = { value: Number.NaN, unit: 'thousands' };
    const doc = build(extraction);
    expect(doc.extractionDiagnostics.droppedMoneyAssertions).toEqual([
      expect.objectContaining({ reason: 'non_finite_value', index: 0 }),
    ]);
    const result = verifyBudgetDocument(doc);
    expect(result.status).toBe('REJECTED');
    expect(result.normalizedRecords).toEqual([]);
  });

  it('rejects an extraction with only unsupported fields', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2027,
          fieldName: 'quantity',
          quantity: 4,
          provenance: prov(),
        },
      ],
      warnings: [],
    };
    const result = verifyBudgetDocument(build(extraction));
    expect(result.status).toBe('REJECTED');
    expect(result.normalizedRecords).toEqual([]);
  });

  it('routes a warning-bearing but otherwise valid extraction to review', () => {
    const extraction = cleanExtraction();
    extraction.warnings = ['continuation row suspected on page 30'];
    const result = verifyBudgetDocument(build(extraction));
    expect(result.status).toBe('NEEDS_REVIEW');
  });

  it('marks mixed PE + procurement identity for the verifier to block', () => {
    const extraction = cleanExtraction();
    extraction.yearValues.push({
      lineKind: 'PROCUREMENT_BLIN',
      code: '12',
      fy: 2027,
      fieldName: 'request',
      money: { value: 99, unit: 'millions' },
      provenance: prov({ exhibit: 'P-40' }),
    });
    const result = verifyBudgetDocument(build(extraction));
    expect(result.checks.find((c) => c.code === 'schema_identifiers')?.passed).toBe(false);
    expect(result.status).toBe('REJECTED');
  });

  it('maps mapped-extraction input identically', () => {
    const doc = buildBudgetDocumentFromMappedExtraction({
      classification: classification(),
      extraction: cleanExtraction(),
      sourceDocumentId: 'src-doc-1',
      sourceSha256: SHA,
      archive,
      parseJobId: 'parse-job-2',
      outputJsonS3Key: 'derived/parsed.pages-all.json',
    });
    expect(doc.parseProof.id).toBe('parse-job-2');
    expect(verifyBudgetDocument(doc).status).toBe('STRUCTURALLY_VALIDATED');
  });
});

describe('evidenceForAssertion', () => {
  it('copies page + method without fabricating geometry', () => {
    const value = cleanExtraction().yearValues[0]!;
    const ev = evidenceForAssertion(value, 'src-doc-1', SHA);
    expect(ev).toEqual(
      expect.objectContaining({
        sourceDocumentId: 'src-doc-1',
        sourceSha256: SHA,
        page: 12,
        granularity: 'page_only',
        extractionMethod: 'llamaparse',
        excerpt: 'Advanced Technology',
      }),
    );
    expect(ev.boundingBox).toBeUndefined();
  });
});
