import {
  groupSnapshotRowsByParentV1,
  indexSnapshotRowsByNaturalKeyV1,
} from './snapshot-row-grouping-v1.js';
import type { SnapshotCanonicalRowV1 } from './snapshot-read-repository-v1.js';

const SNAP = 'aaaaaaaa-0000-0000-0000-000000000001';

function row(overrides: Partial<SnapshotCanonicalRowV1> = {}): SnapshotCanonicalRowV1 {
  return {
    snapshotId: SNAP,
    canonicalEntity: 'canonical_rdte_program_element_year',
    canonicalNaturalKey: 'PE0601|2027',
    parentNaturalKey: 'PE0601',
    family: 'rdte',
    fiscalYear: 2027,
    fundingField: 'request',
    stage: null,
    canonicalRowHash: 'hash-1',
    money: { originalValue: '9000', originalUnit: 'thousands', valueMillions: '9' },
    quantity: null,
    unitCostDollars: null,
    textValue: null,
    dateValue: null,
    attributes: {},
    directOrDerived: 'direct',
    lineage: {
      sourceProjectionId: 'proj-1',
      verificationCandidateId: 'cand-1',
      verificationRunId: 'run-1',
      artifactId: 'artifact-1',
      sourceDocumentId: 'doc-1',
      enactmentProofId: null,
    },
    ...overrides,
  };
}

describe('groupSnapshotRowsByParentV1', () => {
  it('separates parentless rows into roots', () => {
    const identity = row({
      canonicalEntity: 'canonical_rdte_program_element',
      canonicalNaturalKey: 'PE0601',
      parentNaturalKey: null,
    });
    const year = row({ parentNaturalKey: 'PE0601' });
    const { roots, byParent } = groupSnapshotRowsByParentV1([identity, year]);
    expect(roots).toEqual([identity]);
    expect(byParent.get('PE0601')).toEqual([year]);
  });

  it('groups multiple children under the same parent key, preserving order', () => {
    const y1 = row({ parentNaturalKey: 'PE0601', fiscalYear: 2027 });
    const y2 = row({ parentNaturalKey: 'PE0601', fiscalYear: 2028 });
    const other = row({ parentNaturalKey: 'PE0602', fiscalYear: 2027 });
    const { byParent, roots } = groupSnapshotRowsByParentV1([y1, y2, other]);
    expect(roots).toEqual([]);
    expect(byParent.get('PE0601')).toEqual([y1, y2]);
    expect(byParent.get('PE0602')).toEqual([other]);
  });

  it('returns an empty grouping for an empty input', () => {
    const { roots, byParent } = groupSnapshotRowsByParentV1([]);
    expect(roots).toEqual([]);
    expect(byParent.size).toBe(0);
  });
});

describe('indexSnapshotRowsByNaturalKeyV1', () => {
  it('indexes one row per key when keys are unique', () => {
    const a = row({ canonicalNaturalKey: 'PE0601|2027', fiscalYear: 2027 });
    const b = row({ canonicalNaturalKey: 'PE0601|2028', fiscalYear: 2028 });
    const byKey = indexSnapshotRowsByNaturalKeyV1([a, b]);
    expect(byKey.get('PE0601|2027')).toEqual([a]);
    expect(byKey.get('PE0601|2028')).toEqual([b]);
  });

  it('keeps every row under a colliding key rather than dropping one', () => {
    const a = row({ canonicalNaturalKey: 'PE0601|2027', canonicalRowHash: 'hash-a' });
    const b = row({ canonicalNaturalKey: 'PE0601|2027', canonicalRowHash: 'hash-b' });
    const byKey = indexSnapshotRowsByNaturalKeyV1([a, b]);
    expect(byKey.get('PE0601|2027')).toEqual([a, b]);
  });
});
