import { adaptR2ArtifactToArtifactV1, type R2ArtifactV1Input } from './r2-artifact-v1.adapter.js';
import { adapterTestContext } from './testing-helpers.js';

function r2Input(overrides: Partial<R2ArtifactV1Input> = {}): R2ArtifactV1Input {
  return {
    docType: 'jbook',
    exhibitType: 'R-2',
    fy: 2099,
    sourceUrl: 'https://example.invalid/r2.pdf',
    volumeId: 'vol1',
    pageCount: 300,
    programElements: [
      {
        peCode: '0602308A',
        peName: 'Test PE',
        budgetActivity: 'BA 3',
        appropriation: 'RDT&E, Army',
        pageStart: 100,
        pageEnd: 104,
        mission: 'Develop things.',
        projects: [
          { projectCode: 'ZN9', title: 'Project ZN9', mission: 'Project mission.', page: 102 },
        ],
      },
    ],
    stats: { program_elements: 1, projects: 1, pages_with_exhibits: 5 },
    ...overrides,
  };
}

describe('adaptR2ArtifactToArtifactV1', () => {
  it('covers PE identity, mission narrative, and project', () => {
    const artifact = adaptR2ArtifactToArtifactV1(r2Input(), adapterTestContext());
    expect(
      artifact.assertions.filter((a) => a.assertionKind === 'program_element_identity'),
    ).toHaveLength(1);
    const narratives = artifact.assertions.filter((a) => a.assertionKind === 'narrative');
    expect(narratives).toHaveLength(1);
    expect(narratives[0]!.narrativeType).toBe('mission');
    const projects = artifact.assertions.filter((a) => a.assertionKind === 'project');
    expect(projects).toHaveLength(1);
    expect(projects[0]!).toMatchObject({ parentPeCode: '0602308A', projectCode: 'ZN9' });
    expect(artifact.summary.completenessStatus).toBe('complete');
  });

  it('scopes project codes to the parent PE', () => {
    const artifact = adaptR2ArtifactToArtifactV1(r2Input(), adapterTestContext());
    const project = artifact.assertions.find((a) => a.assertionKind === 'project');
    expect(project!.parentPeCode).toBe('0602308A');
  });

  it('blocks project assertions when the parent PE code is invalid', () => {
    const artifact = adaptR2ArtifactToArtifactV1(
      r2Input({
        programElements: [
          {
            peCode: 'bad-code',
            peName: 'Bad',
            budgetActivity: null,
            appropriation: null,
            pageStart: 10,
            pageEnd: 12,
            mission: 'm',
            projects: [{ projectCode: 'X1', title: 't', mission: 'm', page: 11 }],
          },
        ],
      }),
      adapterTestContext(),
    );
    expect(artifact.assertions.filter((a) => a.assertionKind === 'project')).toHaveLength(0);
    expect(artifact.omissions.some((o) => o.reason === 'invalid_identity')).toBe(true);
  });

  it('maps optional project funding rows to project_funding', () => {
    const artifact = adaptR2ArtifactToArtifactV1(
      r2Input({
        programElements: [
          {
            peCode: '0602308A',
            peName: 'Test PE',
            budgetActivity: null,
            appropriation: null,
            pageStart: 100,
            pageEnd: 104,
            mission: 'm',
            projects: [
              {
                projectCode: 'ZN9',
                title: 'Project ZN9',
                mission: 'pm',
                page: 102,
                fyData: [{ fy: 2099, field: 'request', value: 2500, unit: 'thousands', page: 103 }],
              },
            ],
          },
        ],
      }),
      adapterTestContext(),
    );
    const projectFunding = artifact.assertions.filter((a) => a.assertionKind === 'project_funding');
    expect(projectFunding).toHaveLength(1);
    expect(projectFunding[0]!.money.valueMillions).toBe('2.5');
    expect(projectFunding[0]!.parentPeCode).toBe('0602308A');
    expect(projectFunding[0]!.projectCode).toBe('ZN9');
  });

  it('documents missing legacy project funding instead of fabricating it', () => {
    const artifact = adaptR2ArtifactToArtifactV1(r2Input(), adapterTestContext());
    expect(
      artifact.warnings.some((w) => w.code === 'legacy_r2a_artifact_missing_project_funding'),
    ).toBe(true);
    expect(artifact.assertions.filter((a) => a.assertionKind === 'project_funding')).toHaveLength(
      0,
    );
  });

  it('uses truthful page_only evidence (PE at pageStart, project at its page)', () => {
    const artifact = adaptR2ArtifactToArtifactV1(r2Input(), adapterTestContext());
    const projectAssertion = artifact.assertions.find((a) => a.assertionKind === 'project');
    const projectEvidence = artifact.evidence.find(
      (e) => e.evidenceId === projectAssertion!.evidenceIds[0],
    );
    expect(projectEvidence).toMatchObject({ granularity: 'page_only', page: 102 });
    expect(projectEvidence!.boundingBox).toBeUndefined();
    const peIdentity = artifact.assertions.find(
      (a) => a.assertionKind === 'program_element_identity',
    );
    const peEvidence = artifact.evidence.find((e) => e.evidenceId === peIdentity!.evidenceIds[0]);
    expect(peEvidence).toMatchObject({ granularity: 'page_only', page: 100 });
  });

  it('keeps duplicate project codes as duplicate assertions', () => {
    const artifact = adaptR2ArtifactToArtifactV1(
      r2Input({
        programElements: [
          {
            peCode: '0602308A',
            peName: 'Test PE',
            budgetActivity: null,
            appropriation: null,
            pageStart: 100,
            pageEnd: 110,
            mission: 'm',
            projects: [
              { projectCode: 'ZN9', title: 'First', mission: 'm1', page: 102 },
              { projectCode: 'ZN9', title: 'Duplicate', mission: 'm2', page: 105 },
            ],
          },
        ],
      }),
      adapterTestContext(),
    );
    expect(artifact.assertions.filter((a) => a.assertionKind === 'project')).toHaveLength(2);
  });

  it('maps optional PE fyData and narratives', () => {
    const artifact = adaptR2ArtifactToArtifactV1(
      r2Input({
        programElements: [
          {
            peCode: '0602308A',
            peName: 'Test PE',
            budgetActivity: null,
            appropriation: null,
            pageStart: 100,
            pageEnd: 104,
            mission: 'm',
            accomplishments: 'Did stuff.',
            plans: 'Will do more.',
            fyData: [{ fy: 2099, field: 'request', value: 1250, unit: 'thousands', page: 101 }],
            projects: [],
          },
        ],
      }),
      adapterTestContext(),
    );
    const kinds = artifact.assertions.map((a) => a.assertionKind);
    expect(kinds).toContain('funding');
    const narrativeTypes = artifact.assertions
      .filter((a) => a.assertionKind === 'narrative')
      .map((a) => a.narrativeType)
      .sort();
    expect(narrativeTypes).toEqual(['accomplishments', 'mission', 'plans']);
    // No projects anywhere, so no missing-project-funding warning.
    expect(
      artifact.warnings.some((w) => w.code === 'legacy_r2a_artifact_missing_project_funding'),
    ).toBe(false);
  });

  it('replay is deterministic', () => {
    const first = adaptR2ArtifactToArtifactV1(r2Input(), adapterTestContext());
    const second = adaptR2ArtifactToArtifactV1(r2Input(), adapterTestContext());
    expect(second).toEqual(first);
    expect(second.artifactId).toBe(first.artifactId);
  });
});
