import { projectPeProjectsV1 } from './pe-project-projector-v1.js';
import type { SnapshotReadRowV1 } from '../../defense-budget/promotion/manual-override-overlay-v1.js';

const SNAP = 'aaaaaaaa-0000-0000-0000-000000000001';

function projectRow(overrides: Partial<SnapshotReadRowV1> = {}): SnapshotReadRowV1 {
  return {
    snapshotId: SNAP,
    canonicalEntity: 'canonical_rdte_project',
    canonicalNaturalKey: 'PE0601|P123',
    parentNaturalKey: 'PE0601',
    family: 'rdte',
    fiscalYear: null,
    fundingField: null,
    stage: null,
    canonicalRowHash: 'hash-1',
    money: null,
    quantity: null,
    unitCostDollars: null,
    textValue: null,
    dateValue: null,
    attributes: {
      peCode: 'PE0601',
      projectCode: 'P123',
      title: 'Hypersonic Airframe',
      mission: 'Applied research',
      budgetActivity: '02',
    },
    directOrDerived: 'direct',
    lineage: {
      sourceProjectionId: 'proj-1',
      verificationCandidateId: 'cand-1',
      verificationRunId: 'run-1',
      artifactId: 'artifact-1',
      sourceDocumentId: 'doc-1',
      enactmentProofId: null,
    },
    override: null,
    officialMoney: null,
    ...overrides,
  };
}

describe('projectPeProjectsV1', () => {
  it('maps a project row onto the legacy getProjects shape', () => {
    const [row] = projectPeProjectsV1([projectRow()]);
    expect(row).toEqual({
      id: null,
      projectCode: 'P123',
      title: 'Hypersonic Airframe',
      mission: 'Applied research',
      budgetActivity: '02',
      fy: null,
      sourceUrl: null,
      pageNumber: null,
      confidence: null,
    });
  });

  it('ignores rows belonging to any other canonical entity', () => {
    const foreign = projectRow({ canonicalEntity: 'canonical_rdte_budget_position' });
    expect(projectPeProjectsV1([foreign])).toEqual([]);
  });

  /**
   * `buildAttributes` drops values already consumed by a typed axis, so a real
   * promoted row may carry no `projectCode` attribute at all — the identity axis
   * is exactly where a natural-key component gets consumed. Falling back to the
   * key's second segment is what keeps such a row projectable.
   */
  it('recovers projectCode from the natural key when the attribute was consumed', () => {
    const consumed = projectRow({ attributes: { peCode: 'PE0601', title: 'Recovered' } });
    const [row] = projectPeProjectsV1([consumed]);
    expect(row!.projectCode).toBe('P123');
    expect(row!.title).toBe('Recovered');
  });

  it('falls back to textValue when no title attribute is present', () => {
    const textTitled = projectRow({
      attributes: { peCode: 'PE0601', projectCode: 'P123' },
      textValue: 'Title From Text Axis',
    });
    expect(projectPeProjectsV1([textTitled])[0]!.title).toBe('Title From Text Axis');
  });

  /**
   * A row with no resolvable project code is skipped, not emitted with a guessed
   * or empty identity — the project code is the whole identity of the record and
   * a caller could not match a codeless row to anything.
   */
  it('skips a row whose project code cannot be resolved at all', () => {
    const unusable = projectRow({
      canonicalNaturalKey: 'PE0601',
      attributes: { peCode: 'PE0601' },
    });
    expect(projectPeProjectsV1([unusable])).toEqual([]);
  });

  it('sorts by projectCode, matching the legacy orderBy', () => {
    const rows = projectPeProjectsV1([
      projectRow({ canonicalNaturalKey: 'PE0601|P300', attributes: { projectCode: 'P300' } }),
      projectRow({ canonicalNaturalKey: 'PE0601|P100', attributes: { projectCode: 'P100' } }),
      projectRow({ canonicalNaturalKey: 'PE0601|P200', attributes: { projectCode: 'P200' } }),
    ]);
    expect(rows.map((r) => r.projectCode)).toEqual(['P100', 'P200', 'P300']);
  });

  /**
   * The four columns with no canonical source are asserted as null explicitly,
   * so that anyone later tempted to synthesise one — an `fy` from the snapshot's
   * cycle, an `id` from the row hash — has to delete a test that says why not.
   */
  it('holds the four unsourced legacy columns at null rather than inventing them', () => {
    const [row] = projectPeProjectsV1([projectRow({ fiscalYear: 2027 })]);
    expect(row!.id).toBeNull();
    expect(row!.fy).toBeNull();
    expect(row!.sourceUrl).toBeNull();
    expect(row!.pageNumber).toBeNull();
    expect(row!.confidence).toBeNull();
  });
});
