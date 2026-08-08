import {
  buildPhase6ProjectionPlanDocumentV1,
  PHASE6_PROJECTION_PLAN_SCHEMA_VERSION,
} from './phase6-projection-plan-builder-v1.js';
import type { Phase6NativeProjectionV1 } from './phase6-native-projection-v1.js';
import {
  projectionPlanDocumentViewV1Schema,
  summarizeProjectionPlanV1,
} from '../projection-plan/projection-plan-record-v1.js';

const SHA = (c: string) => c.repeat(64);

function row(overrides: Partial<Phase6NativeProjectionV1> = {}): Phase6NativeProjectionV1 {
  return {
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: 'p6proj-1',
    naturalKey: `${SHA('a')}|2027|hac_d|hacDMark`,
    idempotencyKey: 'idem-1',
    projectionKind: 'stage_position',
    verificationCandidateId: 'vc-1',
    verificationRunId: 'vr-1',
    artifactId: 'artifact-1',
    artifactContentSha256: SHA('b'),
    sourceDocumentId: 'doc-1',
    sourcePdfSha256: SHA('c'),
    sourceProfileHash: SHA('d'),
    nativeIdentityHash: SHA('a'),
    track: 'appropriations',
    stage: 'hac_d',
    fundingField: 'hacDMark',
    money: { originalValue: '125', originalUnit: 'millions', valueMillions: '125' },
    directOrDerived: 'direct',
    evidenceIds: ['ev-1'],
    bindingStatus: 'accepted',
    projectionStatus: 'verified',
    payload: { fiscalYear: 2027 },
    canonicalWriteAllowed: false,
    ...overrides,
  };
}

describe('buildPhase6ProjectionPlanDocumentV1 — A1: candidate boundary', () => {
  it('turns one native projection row into one candidate', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'cycle-fy2027',
      fiscalYear: 2027,
      rows: [row()],
    });
    expect(doc.candidates).toHaveLength(1);
    expect(doc.schemaVersion).toBe(PHASE6_PROJECTION_PLAN_SCHEMA_VERSION);
  });

  it('does not group two different natural keys together', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'cycle-fy2027',
      fiscalYear: 2027,
      rows: [
        row({ projectionId: 'a', naturalKey: 'key-a' }),
        row({ projectionId: 'b', naturalKey: 'key-b' }),
      ],
    });
    expect(doc.candidates).toHaveLength(2);
  });

  it('excludes superseded rows from candidacy entirely', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'cycle-fy2027',
      fiscalYear: 2027,
      rows: [row({ projectionStatus: 'superseded' })],
    });
    expect(doc.candidates).toHaveLength(0);
  });

  it('preserves enough identity to reconstruct the source row', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'cycle-fy2027',
      fiscalYear: 2027,
      rows: [row()],
    });
    expect(doc.candidates[0]).toMatchObject({
      sourceProjectionIds: ['p6proj-1'],
      nativeIdentityHash: SHA('a'),
      verificationCandidateId: 'vc-1',
      verificationRunId: 'vr-1',
      sourceDocumentId: 'doc-1',
      sourcePdfSha256: SHA('c'),
      projectionKind: 'stage_position',
    });
  });
});

describe('buildPhase6ProjectionPlanDocumentV1 — A2: operation semantics', () => {
  it('never emits "update" — it is unused in this schema version', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [
        row({ projectionId: 'a', naturalKey: 'k1', bindingStatus: 'accepted' }),
        row({ projectionId: 'b', naturalKey: 'k2', bindingStatus: 'conflicting' }),
        row({ projectionId: 'c', naturalKey: 'k3', projectionStatus: 'candidate' }),
        row({ projectionId: 'd', naturalKey: 'k4', projectionStatus: 'blocked' }),
      ],
    });
    expect(doc.candidates.map((c) => c.operation)).not.toContain('update');
  });
});

describe('buildPhase6ProjectionPlanDocumentV1 — A3: status/binding mapping', () => {
  it('maps verified + accepted to insert with no exclusion reason', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [row({ projectionStatus: 'verified', bindingStatus: 'accepted' })],
    });
    expect(doc.candidates[0]).toMatchObject({ operation: 'insert' });
    expect(doc.candidates[0]!.exclusionReason).toBeUndefined();
  });

  it.each([
    ['candidate' as const, 'unresolved_binding'],
    ['unresolved' as const, 'unresolved_binding'],
  ])('maps verified + %s binding to no_op / %s', (bindingStatus, reason) => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [row({ projectionStatus: 'verified', bindingStatus })],
    });
    expect(doc.candidates[0]).toMatchObject({ operation: 'no_op', exclusionReason: reason });
  });

  it('maps verified + conflicting binding to conflict / binding_conflict', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [row({ projectionStatus: 'verified', bindingStatus: 'conflicting' })],
    });
    expect(doc.candidates[0]).toMatchObject({
      operation: 'conflict',
      exclusionReason: 'binding_conflict',
    });
  });

  it('maps verified + not_applicable binding to no_op / unsupported_projection', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [
        row({
          projectionStatus: 'verified',
          bindingStatus: 'not_applicable',
          projectionKind: 'vehicle_proof',
          fundingField: undefined,
          money: undefined,
        }),
      ],
    });
    expect(doc.candidates[0]).toMatchObject({
      operation: 'no_op',
      exclusionReason: 'unsupported_projection',
    });
  });

  it('maps projectionStatus candidate to no_op / artifact_needs_review, reusing the existing reason', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [row({ projectionStatus: 'candidate' })],
    });
    expect(doc.candidates[0]).toMatchObject({
      operation: 'no_op',
      exclusionReason: 'artifact_needs_review',
    });
  });

  it('maps projectionStatus blocked to no_op / phase6_projection_blocked, checked before bindingStatus', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [row({ projectionStatus: 'blocked', bindingStatus: 'accepted' })],
    });
    expect(doc.candidates[0]).toMatchObject({
      operation: 'no_op',
      exclusionReason: 'phase6_projection_blocked',
    });
  });
});

describe('buildPhase6ProjectionPlanDocumentV1 — duplicate natural key composition policy', () => {
  it('collapses same natural key + identical content into one candidate', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [
        row({
          projectionId: 'a',
          artifactId: 'art-a',
          artifactContentSha256: SHA('1'),
          evidenceIds: ['ev-a'],
        }),
        row({
          projectionId: 'b',
          artifactId: 'art-b',
          artifactContentSha256: SHA('2'),
          evidenceIds: ['ev-b'],
        }),
      ],
    });
    expect(doc.candidates).toHaveLength(1);
    expect(doc.candidates[0]!.operation).toBe('insert');
    expect(doc.candidates[0]!.sourceProjectionIds).toEqual(['a', 'b']);
  });

  it('binds a collapsed duplicate to the deterministic artifact-set hash, not an arbitrary pick', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [
        row({ projectionId: 'a', artifactContentSha256: SHA('1') }),
        row({ projectionId: 'b', artifactContentSha256: SHA('2') }),
      ],
    });
    const hash = doc.candidates[0]!.artifactContentSha256;
    expect(hash).not.toBe(SHA('1'));
    expect(hash).not.toBe(SHA('2'));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not compute a set hash when every duplicate shares one artifact', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [
        row({ projectionId: 'a', artifactContentSha256: SHA('1') }),
        row({ projectionId: 'b', artifactContentSha256: SHA('1') }),
      ],
    });
    expect(doc.candidates[0]!.artifactContentSha256).toBe(SHA('1'));
  });

  it('splits same natural key + differing content into separate conflict candidates, never last-wins', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [
        row({
          projectionId: 'a',
          money: { originalValue: '100', originalUnit: 'millions', valueMillions: '100' },
        }),
        row({
          projectionId: 'b',
          money: { originalValue: '200', originalUnit: 'millions', valueMillions: '200' },
        }),
      ],
    });
    expect(doc.candidates).toHaveLength(2);
    expect(doc.candidates.every((c) => c.operation === 'conflict')).toBe(true);
    expect(doc.candidates.every((c) => c.exclusionReason === 'binding_conflict')).toBe(true);
    expect(new Set(doc.candidates.flatMap((c) => c.sourceProjectionIds))).toEqual(
      new Set(['a', 'b']),
    );
  });

  it('preserves conflicting candidates rather than dropping them', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [
        row({
          projectionId: 'a',
          money: { originalValue: '100', originalUnit: 'millions', valueMillions: '100' },
        }),
        row({
          projectionId: 'b',
          money: { originalValue: '200', originalUnit: 'millions', valueMillions: '200' },
        }),
      ],
    });
    expect(doc.candidates.length).toBeGreaterThan(0);
  });
});

describe('buildPhase6ProjectionPlanDocumentV1 — determinism and interop with the shared substrate', () => {
  it('is deterministic: rebuilding from the same rows yields the same contentSha256', () => {
    const rows = [row({ projectionId: 'a' }), row({ projectionId: 'b', naturalKey: 'other-key' })];
    const a = buildPhase6ProjectionPlanDocumentV1({ cycleId: 'c', fiscalYear: 2027, rows });
    const b = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [...rows].reverse(),
    });
    expect(a.contentSha256).toBe(b.contentSha256);
  });

  it('parses through the shared structural view the plan substrate reads', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [row()],
    });
    expect(() => projectionPlanDocumentViewV1Schema.parse(doc)).not.toThrow();
  });

  it('summarizes without throwing on an unclassified reason — every reason this builder emits is classified', () => {
    const doc = buildPhase6ProjectionPlanDocumentV1({
      cycleId: 'c',
      fiscalYear: 2027,
      rows: [
        row({ projectionId: 'a', naturalKey: 'k1', bindingStatus: 'accepted' }),
        row({ projectionId: 'b', naturalKey: 'k2', bindingStatus: 'unresolved' }),
        row({ projectionId: 'c', naturalKey: 'k3', bindingStatus: 'conflicting' }),
        row({ projectionId: 'd', naturalKey: 'k4', bindingStatus: 'not_applicable' }),
        row({ projectionId: 'e', naturalKey: 'k5', projectionStatus: 'candidate' }),
        row({ projectionId: 'f', naturalKey: 'k6', projectionStatus: 'blocked' }),
      ],
    });
    const view = projectionPlanDocumentViewV1Schema.parse(doc);
    expect(() => summarizeProjectionPlanV1(view)).not.toThrow();
    const summary = summarizeProjectionPlanV1(view);
    expect(summary.status).toBe('BLOCKED');
    expect(summary.conflictCount).toBe(1);
    // k2 (unresolved_binding) + k3 (binding_conflict, ALSO counted here, same
    // as RDTE's duplicate_conflict double-counts conflict+unsupported) + k4
    // (unsupported_projection) + k5 (artifact_needs_review) + k6
    // (phase6_projection_blocked) = 5.
    expect(summary.unsupportedCount).toBe(5);
  });
});
