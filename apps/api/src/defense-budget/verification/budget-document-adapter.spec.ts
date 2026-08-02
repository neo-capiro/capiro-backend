import {
  buildBudgetDocumentFromExtraction,
  buildBudgetDocumentFromMappedExtraction,
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

function extraction(): ExtractionResult {
  return {
    lineAssertions: [
      {
        lineKind: 'RDTE_PE',
        code: '0602308A',
        title: 'Advanced Technology',
        component: 'ARMY',
        provenance: prov(),
      },
      {
        lineKind: 'PROCUREMENT_BLIN',
        code: '12',
        title: 'Radio',
        provenance: prov({ exhibit: 'P-40' }),
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
      {
        lineKind: 'RDTE_PE',
        code: '0602308A',
        fy: 2027,
        fieldName: 'hascMark',
        money: { value: 1300, unit: 'thousands' },
        provenance: prov({ exhibit: 'committee_report', colLabel: 'HASC Mark' }),
      },
      {
        lineKind: 'RDTE_PE',
        code: '0602308A',
        fy: 2027,
        // Extractor vocabulary (lowercase d) must map to canonical hacDMark.
        fieldName: 'hacdMark',
        money: { value: 1400, unit: 'thousands' },
        provenance: prov({ exhibit: 'committee_report', colLabel: 'HAC-D Mark' }),
      },
      {
        lineKind: 'PROCUREMENT_BLIN',
        code: '12',
        fy: 2027,
        fieldName: 'request',
        money: { value: 99, unit: 'millions' },
        provenance: prov({ exhibit: 'P-40' }),
      },
      {
        lineKind: 'RDTE_PE',
        code: '0602308A',
        fy: 2026,
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

describe('buildBudgetDocumentFromExtraction', () => {
  it('maps extractor money assertions into a BudgetDocument the verifier accepts for structure', () => {
    const doc = buildBudgetDocumentFromExtraction({
      classification: classification(),
      extraction: extraction(),
      sourceDocumentId: 'src-doc-1',
      sourceSha256: SHA,
      archive,
      parse: {
        id: 'parse-job-1',
        provider: 'llamaparse',
        status: 'succeeded',
        inputSha256: SHA,
        outputJsonKey: 'derived/public/…/parsed.pages-all.json',
      },
    });

    expect(doc.documentId).toBe('rdte_vol_1_budget_activity_1');
    expect(doc.fiscalYear).toBe(2027);
    expect(doc.sourceAuthority).toBe('presidents_budget_request');
    expect(doc.sourceLineKind).toBe('RDTE_PE');
    expect(doc.archiveProof).toEqual(archive);
    expect(doc.parseProof.provider).toBe('llamaparse');

    // Money fields only — quantity and NaN dropped.
    expect(doc.columns.map((c) => c.key).sort()).toEqual([
      '2027-hacDMark',
      '2027-hascMark',
      '2027-request',
    ]);
    expect(doc.rows).toHaveLength(2); // PE + procurement BLIN

    const peRow = doc.rows.find((r) => r.code === '0602308A');
    expect(peRow?.cells.map((c) => c.field).sort()).toEqual(['hacDMark', 'hascMark', 'request']);
    expect(peRow?.cells.find((c) => c.field === 'request')).toEqual(
      expect.objectContaining({
        rawValue: 1250,
        unit: 'thousands',
        columnKey: '2027-request',
        evidence: expect.objectContaining({
          page: 12,
          extractionMethod: 'llamaparse',
          sourceSha256: SHA,
          boundingBox: { left: 0, top: 0, right: 1, bottom: 1 },
        }),
      }),
    );

    // Document sourceLineKind is RDTE_PE; procurement row kind differs → verifier blocks.
    // That is intentional identity separation, not adapter silence.
    const mixed = verifyBudgetDocument(doc);
    expect(mixed.checks.find((c) => c.code === 'schema_identifiers')?.passed).toBe(false);
  });

  it('maps authority and PE-only extracts so a clean LlamaParse candidate auto-verifies', () => {
    const peOnly: ExtractionResult = {
      lineAssertions: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          title: 'Advanced Technology',
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

    const doc = buildBudgetDocumentFromMappedExtraction({
      classification: classification(),
      extraction: peOnly,
      sourceDocumentId: 'src-doc-1',
      sourceSha256: SHA,
      archive,
      parseJobId: 'parse-job-2',
      outputJsonS3Key: 'derived/parsed.pages-all.json',
    });

    const result = verifyBudgetDocument(doc, { approvedSha256: SHA });
    expect(result.status).toBe('VERIFIED_AUTOMATIC');
    expect(result.promotionReady).toBe(true);
    expect(result.normalizedRecords).toEqual([
      expect.objectContaining({
        peCode: '0602308A',
        fy: 2027,
        field: 'request',
        valueMillions: 1.25,
        originalValue: 1250,
        originalUnit: 'thousands',
        sourcePage: 12,
      }),
    ]);
  });

  it('maps HASC authority for mark extracts and never labels pdfplumber as llamaparse', () => {
    const doc = buildBudgetDocumentFromExtraction({
      classification: classification({
        authority: 'hasc',
        exhibit: 'committee_report',
        family: 'committee',
        sourceKey: 'hasc_mark_fy2027',
      }),
      extraction: {
        lineAssertions: [],
        yearValues: [
          {
            lineKind: 'RDTE_PE',
            code: '0602308A',
            fy: 2027,
            fieldName: 'hascMark',
            money: { value: 10, unit: 'millions' },
            provenance: prov({
              extractionMethod: 'deterministic_pdfplumber',
              exhibit: 'committee_report',
            }),
          },
        ],
        warnings: [],
      },
      sourceDocumentId: 'src-hasc',
      sourceSha256: SHA,
      archive: { ...archive, key: 'incoming/fy2027/hasc.pdf' },
      parse: {
        id: 'parse-hasc',
        provider: 'llamaparse',
        status: 'succeeded',
        inputSha256: SHA,
      },
    });

    expect(doc.sourceAuthority).toBe('hasc_authorization');
    expect(doc.rows[0]?.cells[0]?.evidence.extractionMethod).toBe('manual');
    expect(doc.rows[0]?.cells[0]?.field).toBe('hascMark');
  });
});

describe('evidenceForAssertion', () => {
  it('copies page + method for a single year-value assertion', () => {
    const value = extraction().yearValues[0]!;
    const ev = evidenceForAssertion(value, 'src-doc-1', SHA);
    expect(ev).toEqual(
      expect.objectContaining({
        sourceDocumentId: 'src-doc-1',
        sourceSha256: SHA,
        page: 12,
        extractionMethod: 'llamaparse',
        excerpt: 'Advanced Technology',
      }),
    );
  });
});
