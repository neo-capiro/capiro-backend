import {
  adaptR3PerformerArtifactToArtifactV1,
  type R3PerformerArtifactV1Input,
} from './r3-performer-artifact-v1.adapter.js';
import { adapterTestContext } from './testing-helpers.js';
import { assertDefenseBudgetExtractionArtifactV1 } from '../extraction-artifact-v1.semantic.js';

function r3Input(overrides: Partial<R3PerformerArtifactV1Input> = {}): R3PerformerArtifactV1Input {
  return {
    docType: 'jbook',
    exhibitType: 'R-3',
    fy: 2099,
    sourceUrl: 'https://example.invalid/r3.pdf',
    volumeId: 'vol1',
    publisher: 'dod-comptroller',
    pageCount: 200,
    performers: [
      {
        peCode: '0602308A',
        peName: 'Test PE',
        projectCode: 'ZN9',
        projectName: 'Project ZN9',
        costCategory: 'Management Services',
        performer: 'Acme Research Labs',
        performerNormalized: 'acme research labs',
        location: 'Huntsville, AL',
        contractMethod: 'FFP',
        totalCost: 1250,
        fy: 2099,
        page: 88,
      },
    ],
    stats: { performers: 1 },
    ...overrides,
  };
}

describe('adaptR3PerformerArtifactToArtifactV1', () => {
  it('preserves performer identity and metadata', () => {
    const artifact = adaptR3PerformerArtifactToArtifactV1(r3Input(), adapterTestContext(), {
      costUnit: 'thousands',
    });
    const performer = artifact.assertions.find((a) => a.assertionKind === 'performer');
    expect(performer).toMatchObject({
      parentPeCode: '0602308A',
      projectCode: 'ZN9',
      performerName: 'Acme Research Labs',
      performerNormalized: 'acme research labs',
      location: 'Huntsville, AL',
      contractMethod: 'FFP',
      costCategory: 'Management Services',
      fiscalYear: 2099,
    });
  });

  it('defaults role to PERFORMING_ACTIVITY, never prime contractor', () => {
    const artifact = adaptR3PerformerArtifactToArtifactV1(r3Input(), adapterTestContext(), {
      costUnit: 'thousands',
    });
    const performer = artifact.assertions.find((a) => a.assertionKind === 'performer');
    expect(performer!.performerRole).toBe('PERFORMING_ACTIVITY');
  });

  it('honors an explicit PRIME_CONTRACTOR declaration', () => {
    const artifact = adaptR3PerformerArtifactToArtifactV1(
      r3Input({
        performers: [{ ...r3Input().performers[0]!, performerRole: 'PRIME_CONTRACTOR' }],
      }),
      adapterTestContext(),
      { costUnit: 'thousands' },
    );
    const performer = artifact.assertions.find((a) => a.assertionKind === 'performer');
    expect(performer!.performerRole).toBe('PRIME_CONTRACTOR');
  });

  it('creates a blocking omission when the cost unit is undeclared', () => {
    const artifact = adaptR3PerformerArtifactToArtifactV1(r3Input(), adapterTestContext());
    expect(
      artifact.omissions.some((o) => o.reason === 'unsupported_unit' && o.severity === 'blocking'),
    ).toBe(true);
    const performer = artifact.assertions.find((a) => a.assertionKind === 'performer');
    expect(performer!.totalCost).toBeUndefined();
    expect(artifact.summary.completenessStatus).toBe('incomplete');
  });

  it('maps totalCost exactly when the unit is declared', () => {
    const artifact = adaptR3PerformerArtifactToArtifactV1(r3Input(), adapterTestContext(), {
      costUnit: 'thousands',
    });
    const performer = artifact.assertions.find((a) => a.assertionKind === 'performer');
    expect(performer!.totalCost).toEqual({
      originalValue: '1250',
      originalUnit: 'thousands',
      valueMillions: '1.25',
    });
    expect(artifact.summary.completenessStatus).toBe('complete');
  });

  it('blocks the performer assertion when the PE code is invalid', () => {
    const artifact = adaptR3PerformerArtifactToArtifactV1(
      r3Input({ performers: [{ ...r3Input().performers[0]!, peCode: 'nope' }] }),
      adapterTestContext(),
      { costUnit: 'thousands' },
    );
    expect(artifact.assertions.filter((a) => a.assertionKind === 'performer')).toHaveLength(0);
    expect(artifact.omissions.some((o) => o.reason === 'invalid_identity')).toBe(true);
  });

  it('artifact-level error becomes a blocking warning, a source fact, and a blocking omission', () => {
    const artifact = adaptR3PerformerArtifactToArtifactV1(
      r3Input({ error: 'extractor exploded' }),
      adapterTestContext(),
      { costUnit: 'thousands' },
    );
    // Blocking warning exists.
    expect(
      artifact.warnings.some(
        (w) => w.code === 'legacy_r3_artifact_error' && w.severity === 'blocking',
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
    const first = adaptR3PerformerArtifactToArtifactV1(r3Input(), adapterTestContext(), {
      costUnit: 'thousands',
    });
    const second = adaptR3PerformerArtifactToArtifactV1(r3Input(), adapterTestContext(), {
      costUnit: 'thousands',
    });
    expect(second).toEqual(first);
    expect(second.artifactId).toBe(first.artifactId);
  });
});
