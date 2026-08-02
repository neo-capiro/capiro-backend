import {
  adaptR3PerformerArtifactToArtifactV1,
  type R3PerformerArtifactV1Input,
} from './r3-performer-artifact-v1.adapter.js';
import { adapterTestContext } from './testing-helpers.js';

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
    expect(artifact.summary.completenessStatus).toBe('complete_with_omissions');
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
