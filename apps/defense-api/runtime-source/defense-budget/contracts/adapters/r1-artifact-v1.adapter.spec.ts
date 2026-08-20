import { adaptR1ArtifactToArtifactV1, type R1ArtifactV1Input } from './r1-artifact-v1.adapter.js';
import { adapterTestContext } from './testing-helpers.js';
import { assertDefenseBudgetExtractionArtifactV1 } from '../extraction-artifact-v1.semantic.js';

function r1Input(overrides: Partial<R1ArtifactV1Input> = {}): R1ArtifactV1Input {
  return {
    docType: 'r1',
    pageCount: 100,
    rows: [
      {
        peCode: '0602308A',
        title: 'Test PE',
        budgetActivity: 'BA 3',
        lineNumber: '42',
        page: 17,
        fyColumns: { '2099': 1250000, '2100': null },
      },
    ],
    unparsed_pages: [],
    stats: { rows: 1, pages_with_rows: 1 },
    ...overrides,
  };
}

describe('adaptR1ArtifactToArtifactV1', () => {
  it('preserves identity fields', () => {
    const artifact = adaptR1ArtifactToArtifactV1(r1Input(), adapterTestContext(), {
      fundingUnit: 'dollars',
    });
    const identity = artifact.assertions.find(
      (a) => a.assertionKind === 'program_element_identity',
    );
    expect(identity).toMatchObject({
      identity: { lineKind: 'RDTE_PE', peCode: '0602308A' },
      title: 'Test PE',
      budgetActivity: 'BA 3',
      lineNumber: '42',
    });
  });

  it('maps non-null fyColumns to exact money strings', () => {
    const artifact = adaptR1ArtifactToArtifactV1(r1Input(), adapterTestContext(), {
      fundingUnit: 'dollars',
    });
    const funding = artifact.assertions.filter((a) => a.assertionKind === 'funding');
    expect(funding).toHaveLength(1);
    expect(funding[0]!.money).toEqual({
      originalValue: '1250000',
      originalUnit: 'dollars',
      valueMillions: '1.25',
    });
    expect(funding[0]!.fiscalYear).toBe(2099);
    expect(funding[0]!.field).toBe('request');
  });

  it('documents missing fyColumns with a warning and an omission', () => {
    const artifact = adaptR1ArtifactToArtifactV1(
      r1Input({
        rows: [{ peCode: '0602308A', title: 'T', budgetActivity: null, lineNumber: null, page: 3 }],
      }),
      adapterTestContext(),
      { fundingUnit: 'dollars' },
    );
    expect(
      artifact.warnings.some((w) => w.code === 'legacy_r1_artifact_missing_funding_columns'),
    ).toBe(true);
    expect(artifact.omissions.some((o) => o.reason === 'legacy_artifact_missing_detail')).toBe(
      true,
    );
    expect(artifact.summary.completenessStatus).toBe('complete_with_omissions');
  });

  it('turns unparsed pages into review warnings with page evidence', () => {
    const artifact = adaptR1ArtifactToArtifactV1(
      r1Input({ unparsed_pages: [22, 23] }),
      adapterTestContext(),
      {
        fundingUnit: 'dollars',
      },
    );
    const warnings = artifact.warnings.filter((w) => w.code === 'legacy_r1_unparsed_page');
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning.severity).toBe('review');
      const evidence = artifact.evidence.find((e) => e.evidenceId === warning.evidenceIds[0]);
      expect(evidence?.granularity).toBe('page_only');
    }
  });

  it('blocks invalid PE codes with an omission', () => {
    const artifact = adaptR1ArtifactToArtifactV1(
      r1Input({
        rows: [{ peCode: 'not-a-pe', title: 'T', budgetActivity: null, lineNumber: null, page: 3 }],
      }),
      adapterTestContext(),
      { fundingUnit: 'dollars' },
    );
    expect(
      artifact.omissions.some((o) => o.reason === 'invalid_identity' && o.severity === 'blocking'),
    ).toBe(true);
    expect(
      artifact.assertions.filter((a) => a.assertionKind === 'program_element_identity'),
    ).toHaveLength(0);
  });

  it('keeps duplicate rows as separate facts and assertions', () => {
    const artifact = adaptR1ArtifactToArtifactV1(
      r1Input({
        rows: [
          { peCode: '0602308A', title: 'First', budgetActivity: null, lineNumber: null, page: 3 },
          {
            peCode: '0602308A',
            title: 'Second (dup)',
            budgetActivity: null,
            lineNumber: null,
            page: 4,
          },
        ],
      }),
      adapterTestContext(),
      { fundingUnit: 'dollars' },
    );
    const identities = artifact.assertions.filter(
      (a) => a.assertionKind === 'program_element_identity',
    );
    expect(identities).toHaveLength(2);
    expect(artifact.sourceFacts.map((f) => f.sourcePath)).toEqual(
      expect.arrayContaining(['rows[0].identity', 'rows[1].identity']),
    );
  });

  it('preserves toplines as document facts only', () => {
    const artifact = adaptR1ArtifactToArtifactV1(
      r1Input({
        toplines: [
          {
            scope: 'rdte',
            amountMillions: 1000,
            units: 'millions',
            sourcePage: 2,
            excerpt: 'RDT&E Total',
          },
        ],
      }),
      adapterTestContext(),
      { fundingUnit: 'dollars' },
    );
    const toplines = artifact.assertions.filter(
      (a) => a.assertionKind === 'document_fact' && a.fieldName === 'r1_topline',
    );
    expect(toplines).toHaveLength(1);
    // Never a PE funding assertion.
    expect(
      artifact.assertions
        .filter((a) => a.assertionKind === 'funding')
        .every((a) => a.fiscalYear === 2099),
    ).toBe(true);
  });

  it('artifact-level error becomes a blocking warning, a source fact, and a blocking omission', () => {
    const artifact = adaptR1ArtifactToArtifactV1(
      r1Input({ error: 'extractor exploded' }),
      adapterTestContext(),
      {
        fundingUnit: 'dollars',
      },
    );
    // Blocking warning exists.
    expect(
      artifact.warnings.some(
        (w) => w.code === 'legacy_r1_artifact_error' && w.severity === 'blocking',
      ),
    ).toBe(true);
    // Error source fact exists at path 'error'.
    const errorFact = artifact.sourceFacts.find((f) => f.sourcePath === 'error');
    expect(errorFact).toBeDefined();
    expect(errorFact!.category).toBe('metadata');
    expect(errorFact!.requiredForCompleteness).toBe(true);
    // Raw error value is preserved in the fact.
    expect(errorFact!.rawValue).toBe('extractor exploded');
    // Blocking omission exists for the error fact.
    expect(
      artifact.omissions.some(
        (o) =>
          o.sourceFactId === errorFact!.factId &&
          o.reason === 'legacy_artifact_missing_detail' &&
          o.severity === 'blocking',
      ),
    ).toBe(true);
    // Artifact status is incomplete.
    expect(artifact.summary.completenessStatus).toBe('incomplete');
    // requireComplete rejects the artifact.
    expect(() =>
      assertDefenseBudgetExtractionArtifactV1(artifact, { requireComplete: true }),
    ).toThrow(/completeness_required/);
  });

  it('replay is deterministic', () => {
    const first = adaptR1ArtifactToArtifactV1(r1Input(), adapterTestContext(), {
      fundingUnit: 'dollars',
    });
    const second = adaptR1ArtifactToArtifactV1(r1Input(), adapterTestContext(), {
      fundingUnit: 'dollars',
    });
    expect(second).toEqual(first);
    expect(second.artifactId).toBe(first.artifactId);
  });
});
