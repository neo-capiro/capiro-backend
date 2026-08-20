import type {
  ExtractionResult,
  LineAssertion,
  ValueProvenance,
  YearValueAssertion,
} from '../../extractors/types.js';
import { adaptExtractionResultToArtifactV1 } from './extraction-result-v1.adapter.js';
import { adapterTestContext } from './testing-helpers.js';

function prov(overrides: Partial<ValueProvenance> = {}): ValueProvenance {
  return {
    pdfPage: 7,
    printedPage: 'Vol 1 - 7',
    exhibit: 'R-1',
    tableLabel: 'Cost ($ in Thousands)',
    rowLabel: 'row',
    colLabel: 'FY2099',
    derivation: 'direct',
    extractionMethod: 'deterministic_pdfplumber',
    confidence: 0.9,
    ...overrides,
  };
}

function rdteLine(overrides: Partial<LineAssertion> = {}): LineAssertion {
  return {
    lineKind: 'RDTE_PE',
    code: '0602308A',
    title: 'Test PE',
    component: 'ARMY',
    budgetActivity: 'BA 3',
    provenance: prov(),
    ...overrides,
  };
}

describe('adaptExtractionResultToArtifactV1', () => {
  it('maps a money year value to a funding assertion with exact scaling', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [rdteLine()],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2099,
          fieldName: 'request',
          money: { value: 1250, unit: 'thousands' },
          provenance: prov(),
        },
      ],
      warnings: [],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    const funding = artifact.assertions.filter((a) => a.assertionKind === 'funding');
    expect(funding).toHaveLength(1);
    expect(funding[0]!.money).toEqual({
      originalValue: '1250',
      originalUnit: 'thousands',
      valueMillions: '1.25',
    });
    expect(funding[0]!.field).toBe('request');
    expect(artifact.summary.completenessStatus).toBe('complete');
    expect(artifact.sourceFacts.some((f) => f.sourcePath === 'yearValues[0].money')).toBe(true);
  });

  it('keeps quantities as quantities, never money', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [],
      yearValues: [
        {
          lineKind: 'PROCUREMENT_BLIN',
          code: '1201',
          account: 'Aircraft Procurement, Army',
          component: 'ARMY',
          fy: 2099,
          fieldName: 'quantity',
          quantity: 42,
          provenance: prov({ exhibit: 'P-40' }),
        },
      ],
      warnings: [],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    const quantities = artifact.assertions.filter((a) => a.assertionKind === 'quantity');
    expect(quantities).toHaveLength(1);
    expect(quantities[0]!.quantity).toBe('42');
    expect(artifact.assertions.filter((a) => a.assertionKind === 'funding')).toHaveLength(0);
  });

  it('preserves valueText as a document fact', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2099,
          fieldName: 'scheduleNote',
          valueText: 'IOC slips to Q3',
          provenance: prov(),
        },
      ],
      warnings: [],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    const docFacts = artifact.assertions.filter((a) => a.assertionKind === 'document_fact');
    expect(docFacts).toHaveLength(1);
    expect(docFacts[0]!.value).toBe('IOC slips to Q3');
  });

  it('turns P-40 referenced PE codes into relationships only', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [
        {
          lineKind: 'PROCUREMENT_BLIN',
          code: '1201',
          title: 'Missile thing',
          account: 'Missile Procurement, Army',
          component: 'ARMY',
          referencedPeCodes: ['0602308A'],
          provenance: prov({ exhibit: 'P-40' }),
        },
      ],
      yearValues: [],
      warnings: [],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    const relationships = artifact.assertions.filter((a) => a.assertionKind === 'relationship');
    expect(relationships).toHaveLength(1);
    expect(relationships[0]!.relationshipType).toBe('references');
    expect(relationships[0]!.to).toEqual({ lineKind: 'RDTE_PE', peCode: '0602308A' });
    // The referenced PE must NOT become a new PE identity.
    expect(
      artifact.assertions.filter((a) => a.assertionKind === 'program_element_identity'),
    ).toHaveLength(0);
  });

  it('keeps pdfplumber provenance as deterministic_pdfplumber', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [rdteLine()],
      yearValues: [],
      warnings: [],
    };
    const context = adapterTestContext({
      parser: {
        method: 'deterministic_pdfplumber',
        parserVersion: '1.0.0',
        parserConfigSha256: '3'.repeat(64),
        outputArtifactSha256: '4'.repeat(64),
        pageRanges: [{ startPage: 1, endPage: 500 }],
      },
    });
    const artifact = adaptExtractionResultToArtifactV1(extraction, context);
    expect(artifact.parserRuns[0]!.method).toBe('deterministic_pdfplumber');
  });

  it('keeps warnings individually visible', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [],
      yearValues: [],
      warnings: ['row 12 ambiguous', 'unit header missing on page 9'],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    expect(artifact.warnings).toHaveLength(2);
    expect(artifact.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining(['row 12 ambiguous', 'unit header missing on page 9']),
    );
  });

  it('emits page_only evidence with no fabricated bounding box', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [rdteLine()],
      yearValues: [],
      warnings: [],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    for (const evidence of artifact.evidence) {
      expect(evidence.granularity).toBe('page_only');
      expect(evidence.boundingBox).toBeUndefined();
      expect(evidence.page).toBe(7);
    }
  });

  it('preserves PE/procurement identity separation in a mixed extraction', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [
        rdteLine(),
        {
          lineKind: 'PROCUREMENT_BLIN',
          code: '0602308A', // same code shape, different identity space
          title: 'Not a PE',
          account: 'Other Procurement, Army',
          component: 'ARMY',
          provenance: prov({ exhibit: 'P-40' }),
        },
      ],
      yearValues: [],
      warnings: [],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    const peIdentities = artifact.assertions.filter(
      (a) => a.assertionKind === 'program_element_identity',
    );
    expect(peIdentities).toHaveLength(1);
    const procurementFacts = artifact.assertions.filter(
      (a) => a.assertionKind === 'document_fact' && a.fieldName === 'procurement_blin_identity',
    );
    expect(procurementFacts).toHaveLength(1);
  });

  it('creates a blocking omission for UNKNOWN identities', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [rdteLine({ lineKind: 'UNKNOWN', code: '???' })],
      yearValues: [],
      warnings: [],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    expect(
      artifact.omissions.some((o) => o.reason === 'invalid_identity' && o.severity === 'blocking'),
    ).toBe(true);
    // Blocking omissions now produce 'incomplete' (Phase 1 §1).
    expect(artifact.summary.completenessStatus).toBe('incomplete');
  });

  it('creates an omission for unsupported money fields', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2099,
          fieldName: 'someFutureField',
          money: { value: 5, unit: 'millions' },
          provenance: prov(),
        },
      ],
      warnings: [],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    expect(artifact.omissions.some((o) => o.reason === 'unsupported_field')).toBe(true);
  });

  it('creates an omission when a year value carries no value at all', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2099,
          fieldName: 'request',
          provenance: prov(),
        } as unknown as YearValueAssertion,
      ],
      warnings: [],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    expect(artifact.omissions.some((o) => o.reason === 'missing_value')).toBe(true);
  });

  it('maps hacdMark/sacdMark aliases to canonical fields', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2099,
          fieldName: 'hacdMark',
          money: { value: 2, unit: 'millions' },
          provenance: prov(),
        },
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2099,
          fieldName: 'sacdMark',
          money: { value: 3, unit: 'millions' },
          provenance: prov(),
        },
      ],
      warnings: [],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    const fields = artifact.assertions
      .filter((a) => a.assertionKind === 'funding')
      .map((a) => a.field)
      .sort();
    expect(fields).toEqual(['hacDMark', 'sacDMark']);
  });

  it('replay produces byte-identical artifacts', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [rdteLine()],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2099,
          fieldName: 'request',
          money: { value: 1250, unit: 'thousands' },
          provenance: prov(),
        },
      ],
      warnings: ['w1'],
    };
    const first = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    const second = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    expect(second).toEqual(first);
    expect(second.artifactId).toBe(first.artifactId);
  });

  it('does not sort source input: source paths follow input order', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [rdteLine({ code: '0602308A' }), rdteLine({ code: '0603790F' })],
      yearValues: [],
      warnings: [],
    };
    const artifact = adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    const paths = artifact.sourceFacts.map((f) => f.sourcePath);
    expect(paths).toContain('lineAssertions[0].identity');
    expect(paths).toContain('lineAssertions[1].identity');
  });
});

/* ------------------------------------------------------------------ */
/* Phase 1 §3 — parser provenance mismatch                             */
/* ------------------------------------------------------------------ */

import { ParserProvenanceMismatchError } from './extraction-result-v1.adapter.js';

describe('parser provenance mismatch', () => {
  it('pdfplumber value under a pdfplumber parser run passes', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [rdteLine()],
      yearValues: [],
      warnings: [],
    };
    expect(() => adaptExtractionResultToArtifactV1(extraction, adapterTestContext())).not.toThrow();
  });

  it('LlamaParse value under a LlamaParse parser run passes', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [rdteLine({ provenance: prov({ extractionMethod: 'llamaparse' }) })],
      yearValues: [],
      warnings: [],
    };
    const ctx = adapterTestContext({
      parser: {
        method: 'llamaparse',
        parserVersion: '0.0.0-test',
        parserConfigSha256: '1'.repeat(64),
        outputArtifactSha256: '2'.repeat(64),
        pageRanges: [{ startPage: 1, endPage: 500 }],
      },
    });
    expect(() => adaptExtractionResultToArtifactV1(extraction, ctx)).not.toThrow();
  });

  it('manual value under a manual parser run passes', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [rdteLine({ provenance: prov({ extractionMethod: 'manual' }) })],
      yearValues: [],
      warnings: [],
    };
    const ctx = adapterTestContext({
      parser: {
        method: 'manual',
        parserVersion: '0.0.0-test',
        parserConfigSha256: '1'.repeat(64),
        outputArtifactSha256: '2'.repeat(64),
        pageRanges: [{ startPage: 1, endPage: 500 }],
      },
    });
    expect(() => adaptExtractionResultToArtifactV1(extraction, ctx)).not.toThrow();
  });

  it('pdfplumber value under a manual parser run fails', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [
        rdteLine({ provenance: prov({ extractionMethod: 'deterministic_pdfplumber' }) }),
      ],
      yearValues: [],
      warnings: [],
    };
    const ctx = adapterTestContext({
      parser: {
        method: 'manual',
        parserVersion: '0.0.0-test',
        parserConfigSha256: '1'.repeat(64),
        outputArtifactSha256: '2'.repeat(64),
        pageRanges: [{ startPage: 1, endPage: 500 }],
      },
    });
    expect(() => adaptExtractionResultToArtifactV1(extraction, ctx)).toThrow(
      ParserProvenanceMismatchError,
    );
  });

  it('manual value under a pdfplumber parser run fails', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [rdteLine({ provenance: prov({ extractionMethod: 'manual' }) })],
      yearValues: [],
      warnings: [],
    };
    expect(() => adaptExtractionResultToArtifactV1(extraction, adapterTestContext())).toThrow(
      ParserProvenanceMismatchError,
    );
  });

  it('mixed-method input under one parser run fails', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [
        rdteLine({ provenance: prov({ extractionMethod: 'deterministic_pdfplumber' }) }),
      ],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2099,
          fieldName: 'request',
          money: { value: 100, unit: 'thousands' },
          provenance: prov({ extractionMethod: 'llamaparse' }),
        },
      ],
      warnings: [],
    };
    expect(() => adaptExtractionResultToArtifactV1(extraction, adapterTestContext())).toThrow(
      ParserProvenanceMismatchError,
    );
  });

  it('no artifact is returned after a mismatch', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [rdteLine({ provenance: prov({ extractionMethod: 'manual' }) })],
      yearValues: [],
      warnings: [],
    };
    let result: unknown = 'not-thrown';
    try {
      adaptExtractionResultToArtifactV1(extraction, adapterTestContext());
    } catch (error) {
      if (error instanceof ParserProvenanceMismatchError) {
        result = 'thrown';
      } else {
        throw error;
      }
    }
    expect(result).toBe('thrown');
  });
});
