/**
 * Phase 7 Workstream C — the planner is pure, deterministic, and refuses
 * rather than resolves.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildExecutionExpectationsV1,
  buildPromotionPlanV1,
  classifyAlertV1,
  proposedRowHashV1,
  type CanonicalLineageV1,
  type DefenseBudgetPromotionPlanV1,
  type ManualOverlayV1,
  type PriorCanonicalRowV1,
  type PromotionPlanInputV1,
  type PromotionPlanItemV1,
  type PromotionProjectionInputV1,
} from './promotion-planner-v1.js';
import { canonicalMappingRegistryHashV1 } from './canonical-mapping-registry-v1.js';
import type { PromotionScopeV1 } from './promotion-eligibility-v1.js';

const SHA = (c: string) => c.repeat(64);
const ACTIVE = 'snap-active';

/** Checked accessor — the suite runs under `noUncheckedIndexedAccess`. */
function firstItem(plan: DefenseBudgetPromotionPlanV1): PromotionPlanItemV1 {
  const item = plan.items[0];
  if (item == null) throw new Error('expected the plan to contain at least one item');
  return item;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value == null) throw new Error(`expected an element at index ${index}`);
  return value;
}
const SAG_KEY = 'ARMY|OMA|SAG-111';
const YEAR_KEY = 'ARMY|OMA|SAG-111|2027|request';

const SCOPE: PromotionScopeV1 = {
  cycleId: 'cycle-fy2027',
  fiscalYear: 2027,
  families: ['om'],
  stages: [],
};

const LINEAGE: CanonicalLineageV1 = {
  sourceAssertionId: 'assert-1',
  evidenceIds: ['ev-1'],
  artifactId: 'artifact-1',
  artifactContentSha256: SHA('a'),
  verificationCandidateId: 'cand-1',
  verificationRunId: 'run-1',
  sourceDocumentId: 'doc-1',
  sourcePdfSha256: SHA('b'),
};

function sagIdentity(
  overrides: Partial<PromotionProjectionInputV1> = {},
): PromotionProjectionInputV1 {
  return {
    projectionId: 'proj-sag',
    projectionHash: SHA('1'),
    projectionKind: 'non_rdte:OmSag',
    naturalKey: SAG_KEY,
    directOrDerived: 'direct',
    values: { textValue: 'Operating Forces' },
    lineage: LINEAGE,
    ...overrides,
  };
}

function sagYear(overrides: Partial<PromotionProjectionInputV1> = {}): PromotionProjectionInputV1 {
  return {
    projectionId: 'proj-year',
    projectionHash: SHA('2'),
    projectionKind: 'non_rdte:OmSagYear',
    naturalKey: YEAR_KEY,
    parentNaturalKey: SAG_KEY,
    fiscalYear: 2027,
    fundingField: 'request',
    directOrDerived: 'direct',
    values: { money: { originalValue: '1250', originalUnit: 'thousands', valueMillions: '1.25' } },
    lineage: LINEAGE,
    ...overrides,
  };
}

/** Parent identity already live, so a year row has its dependency satisfied. */
function priorSag(snapshotId = ACTIVE): PriorCanonicalRowV1 {
  return {
    canonicalEntity: 'canonical_om_sag',
    naturalKey: SAG_KEY,
    rowHash: SHA('9'),
    snapshotId,
  };
}

function planInput(overrides: Partial<PromotionPlanInputV1> = {}): PromotionPlanInputV1 {
  return {
    planId: 'plan-1',
    eligibilityHash: SHA('e'),
    scope: SCOPE,
    mode: 'new_cycle',
    proposedSnapshotId: 'snap-next',
    expectedActiveSnapshotId: ACTIVE,
    actualActiveSnapshotId: ACTIVE,
    mappingRegistryHash: canonicalMappingRegistryHashV1(),
    projections: [sagYear()],
    priorRows: [priorSag()],
    overlays: [],
    ...overrides,
  };
}

const yearRowHash = (valueMillions = '1.25', originalValue = '1250') =>
  proposedRowHashV1({
    canonicalEntity: 'canonical_om_sag_year',
    naturalKey: YEAR_KEY,
    fiscalYear: 2027,
    fundingField: 'request',
    values: { money: { originalValue, originalUnit: 'thousands', valueMillions } },
  });

describe('Phase 7 Workstream C — congressional marks require a stage authority', () => {
  /*
   * The planner is the second of three layers that refuse this: the projector
   * refuses at source, the planner blocks a projection that reached it anyway,
   * and the canonical row's stage/field CHECK constraint refuses the insert.
   * A per-FY row may carry a congressional field, but only when the authority
   * that voted it is on the projection.
   */
  const congressionalYear = (overrides: Partial<PromotionProjectionInputV1> = {}) =>
    sagYear({
      naturalKey: `${SAG_KEY}|2027|ndaaConference`,
      fundingField: 'ndaaConference',
      ...overrides,
    });

  it('blocks a year row asserting a congressional mark with no authority', () => {
    const plan = buildPromotionPlanV1(planInput({ projections: [congressionalYear()] }));
    expect(firstItem(plan).operation).toBe('BLOCKED');
    expect(firstItem(plan).blockReason).toBe('field_authority_violation');
    expect(plan.blocked).toBe(true);
  });

  it('blocks it when a mismatched authority is supplied', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        projections: [congressionalYear({ stageAuthority: 'appropriations_conference' })],
      }),
    );
    expect(firstItem(plan).operation).toBe('BLOCKED');
    expect(firstItem(plan).blockReason).toBe('field_authority_violation');
  });

  it('admits it when the authority that owns the field published it', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        projections: [congressionalYear({ stageAuthority: 'ndaa_conference_authorization' })],
      }),
    );
    expect(firstItem(plan).operation).toBe('INSERT');
    expect(plan.blocked).toBe(false);
  });

  it('leaves the request field promotable with no authority at all', () => {
    const plan = buildPromotionPlanV1(planInput());
    expect(firstItem(plan).operation).toBe('INSERT');
    expect(firstItem(plan).blockReason).toBeNull();
  });
});

describe('Phase 7 Workstream C — operations', () => {
  it('plans an INSERT when no active row exists', () => {
    const plan = buildPromotionPlanV1(planInput());
    expect(plan.items).toHaveLength(1);
    expect(firstItem(plan).operation).toBe('INSERT');
    expect(firstItem(plan).priorRowHash).toBeNull();
    expect(firstItem(plan).proposedRowHash).toBe(yearRowHash());
    expect(plan.counts.insert).toBe(1);
    expect(plan.blocked).toBe(false);
  });

  it('plans UNCHANGED when the proposed hash equals the active hash', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        priorRows: [
          priorSag(),
          {
            canonicalEntity: 'canonical_om_sag_year',
            naturalKey: YEAR_KEY,
            rowHash: yearRowHash(),
            snapshotId: ACTIVE,
          },
        ],
      }),
    );
    expect(firstItem(plan).operation).toBe('UNCHANGED');
    expect(plan.counts.unchanged).toBe(1);
    expect(firstItem(plan).alertDisposition).toBe('none');
  });

  it('plans SUPERSEDE when the active row differs', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        priorRows: [
          priorSag(),
          {
            canonicalEntity: 'canonical_om_sag_year',
            naturalKey: YEAR_KEY,
            rowHash: yearRowHash('9.99', '9990'),
            snapshotId: ACTIVE,
          },
        ],
      }),
    );
    expect(firstItem(plan).operation).toBe('SUPERSEDE');
    expect(firstItem(plan).priorRowHash).toBe(yearRowHash('9.99', '9990'));
    expect(firstItem(plan).proposedRowHash).toBe(yearRowHash());
  });

  it('plans CORRECTION when the run is declared a correction', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        mode: 'correction',
        priorRows: [
          priorSag(),
          {
            canonicalEntity: 'canonical_om_sag_year',
            naturalKey: YEAR_KEY,
            rowHash: yearRowHash('9.99', '9990'),
            snapshotId: ACTIVE,
          },
        ],
      }),
    );
    expect(firstItem(plan).operation).toBe('CORRECTION');
    expect(plan.counts.correction).toBe(1);
  });

  it('distinguishes money that differs only in trailing decimal text', () => {
    // "1.10" and "1.1" are the same float and different canonical decimals.
    expect(yearRowHash('1.10')).not.toBe(yearRowHash('1.1'));
  });
});

describe('Phase 7 Workstream C — refusals, never resolutions', () => {
  it('blocks an unsupported mapping instead of dropping the item', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        projections: [
          sagYear(),
          sagYear({ projectionId: 'p-x', projectionKind: 'non_rdte:NotAKind', naturalKey: 'k-x' }),
        ],
      }),
    );
    expect(plan.items).toHaveLength(2);
    const blocked = plan.items.filter((item) => item.operation === 'BLOCKED');
    expect(blocked).toHaveLength(1);
    expect(at(blocked, 0).blockReason).toBe('unsupported_mapping');
    expect(at(blocked, 0).proposedRowHash).toBeNull();
    expect(plan.blocked).toBe(true);
  });

  it('blocks duplicate natural keys carrying identical values', () => {
    const plan = buildPromotionPlanV1(
      planInput({ projections: [sagYear(), sagYear({ projectionId: 'proj-year-2' })] }),
    );
    expect(plan.counts.blocked).toBe(2);
    for (const item of plan.items) expect(item.blockReason).toBe('duplicate_natural_key');
  });

  it('blocks duplicate natural keys carrying conflicting values — no last-wins', () => {
    const conflicting = sagYear({
      projectionId: 'proj-year-2',
      values: { money: { originalValue: '2500', originalUnit: 'thousands', valueMillions: '2.5' } },
    });
    const plan = buildPromotionPlanV1(planInput({ projections: [sagYear(), conflicting] }));
    expect(plan.counts.blocked).toBe(2);
    for (const item of plan.items) expect(item.blockReason).toBe('conflicting_duplicate_values');
    expect(plan.blockReasonCounts).toEqual([{ reason: 'conflicting_duplicate_values', count: 2 }]);
  });

  it('blocks every item when the active snapshot is not what eligibility expected', () => {
    const plan = buildPromotionPlanV1(planInput({ actualActiveSnapshotId: 'snap-someone-else' }));
    expect(firstItem(plan).operation).toBe('BLOCKED');
    expect(firstItem(plan).blockReason).toBe('active_row_drift');
  });

  it('blocks a prior row that belongs to a different snapshot', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        priorRows: [
          priorSag(),
          {
            canonicalEntity: 'canonical_om_sag_year',
            naturalKey: YEAR_KEY,
            rowHash: yearRowHash('9.99', '9990'),
            snapshotId: 'snap-stale',
          },
        ],
      }),
    );
    expect(firstItem(plan).blockReason).toBe('active_row_drift');
  });

  it('blocks a child row whose parent is neither active nor in the plan', () => {
    const plan = buildPromotionPlanV1(planInput({ priorRows: [] }));
    expect(firstItem(plan).blockReason).toBe('missing_dependency_row');
  });

  it('accepts a child row whose parent is created by the same plan', () => {
    const plan = buildPromotionPlanV1(
      planInput({ projections: [sagYear(), sagIdentity()], priorRows: [] }),
    );
    expect(plan.blocked).toBe(false);
    expect(plan.counts.insert).toBe(2);
  });

  it('blocks a child row that supplies no parent natural key at all', () => {
    const plan = buildPromotionPlanV1(
      planInput({ projections: [sagYear({ parentNaturalKey: null })] }),
    );
    expect(firstItem(plan).blockReason).toBe('missing_dependency_row');
  });

  it('blocks a candidate identity binding', () => {
    const plan = buildPromotionPlanV1(
      planInput({ projections: [sagYear({ bindingStatus: 'candidate' })] }),
    );
    expect(firstItem(plan).blockReason).toBe('candidate_identity_link');
  });

  it('blocks a conflicting identity binding', () => {
    const plan = buildPromotionPlanV1(
      planInput({ projections: [sagYear({ bindingStatus: 'conflicting' })] }),
    );
    expect(firstItem(plan).blockReason).toBe('candidate_identity_link');
  });

  it('blocks an enacted stage position with no enactment proof', () => {
    const enacted: PromotionProjectionInputV1 = {
      projectionId: 'proj-enacted',
      projectionHash: SHA('3'),
      projectionKind: 'phase6:stage_position',
      naturalKey: 'native-hash|2027|public_law|enacted',
      fiscalYear: 2027,
      fundingField: 'enacted',
      stageAuthority: 'enacted_public_law',
      bindingStatus: 'accepted',
      enactmentProofId: null,
      directOrDerived: 'direct',
      values: { money: { originalValue: '10', originalUnit: 'millions', valueMillions: '10' } },
      lineage: LINEAGE,
    };
    const plan = buildPromotionPlanV1(planInput({ projections: [enacted], priorRows: [] }));
    expect(firstItem(plan).blockReason).toBe('missing_enactment_proof');
  });

  it('blocks an NDAA conference authority writing the appropriations conference field', () => {
    const crossed: PromotionProjectionInputV1 = {
      projectionId: 'proj-crossed',
      projectionHash: SHA('4'),
      projectionKind: 'phase6:stage_position',
      naturalKey: 'native-hash|2027|ndaa_conference|conference',
      fiscalYear: 2027,
      fundingField: 'conference',
      stageAuthority: 'ndaa_conference_authorization',
      bindingStatus: 'accepted',
      directOrDerived: 'direct',
      values: { money: { originalValue: '10', originalUnit: 'millions', valueMillions: '10' } },
      lineage: LINEAGE,
    };
    const plan = buildPromotionPlanV1(planInput({ projections: [crossed], priorRows: [] }));
    expect(firstItem(plan).blockReason).toBe('field_authority_violation');
  });
});

describe('Phase 7 Workstream C — manual overrides', () => {
  const overlay = (status: ManualOverlayV1['status']): ManualOverlayV1 => ({
    canonicalEntity: 'canonical_om_sag_year',
    naturalKey: YEAR_KEY,
    fiscalYear: 2027,
    fundingField: 'request',
    status,
  });

  const changedPrior: PriorCanonicalRowV1[] = [
    priorSag(),
    {
      canonicalEntity: 'canonical_om_sag_year',
      naturalKey: YEAR_KEY,
      rowHash: yearRowHash('9.99', '9990'),
      snapshotId: ACTIVE,
    },
  ];

  it('blocks when the official value changes beneath an active override', () => {
    const plan = buildPromotionPlanV1(
      planInput({ priorRows: changedPrior, overlays: [overlay('active')] }),
    );
    expect(firstItem(plan).operation).toBe('BLOCKED');
    expect(firstItem(plan).blockReason).toBe('manual_override_collision');
  });

  it('does not block when the override has expired', () => {
    const plan = buildPromotionPlanV1(
      planInput({ priorRows: changedPrior, overlays: [overlay('expired')] }),
    );
    expect(firstItem(plan).operation).toBe('SUPERSEDE');
  });

  it('does not block when the override has been revoked', () => {
    const plan = buildPromotionPlanV1(
      planInput({ priorRows: changedPrior, overlays: [overlay('revoked')] }),
    );
    expect(firstItem(plan).operation).toBe('SUPERSEDE');
  });

  it('does not block when the official value is unchanged beneath an active override', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        priorRows: [
          priorSag(),
          {
            canonicalEntity: 'canonical_om_sag_year',
            naturalKey: YEAR_KEY,
            rowHash: yearRowHash(),
            snapshotId: ACTIVE,
          },
        ],
        overlays: [overlay('active')],
      }),
    );
    expect(firstItem(plan).operation).toBe('UNCHANGED');
  });
});

describe('Phase 7 Workstream C — alert classification', () => {
  it('suppresses every alert during initial baseline hydration', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        mode: 'baseline_hydration',
        expectedActiveSnapshotId: null,
        actualActiveSnapshotId: null,
        projections: [sagIdentity(), sagYear()],
        priorRows: [],
      }),
    );
    expect(plan.counts.insert).toBe(2);
    expect(plan.counts.alertEligible).toBe(0);
    const year = plan.items.find((item) => item.canonicalEntity === 'canonical_om_sag_year');
    expect(year?.alertDisposition).toBe('suppressed_hydration');
  });

  it('marks a new official material change alert-eligible', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        priorRows: [
          priorSag(),
          {
            canonicalEntity: 'canonical_om_sag_year',
            naturalKey: YEAR_KEY,
            rowHash: yearRowHash('9.99', '9990'),
            snapshotId: ACTIVE,
          },
        ],
      }),
    );
    expect(firstItem(plan).operation).toBe('SUPERSEDE');
    expect(firstItem(plan).alertDisposition).toBe('eligible');
    expect(plan.counts.alertEligible).toBe(1);
  });

  it('suppresses alerts on a correction run by default', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        mode: 'correction',
        priorRows: [
          priorSag(),
          {
            canonicalEntity: 'canonical_om_sag_year',
            naturalKey: YEAR_KEY,
            rowHash: yearRowHash('9.99', '9990'),
            snapshotId: ACTIVE,
          },
        ],
      }),
    );
    expect(firstItem(plan).alertDisposition).toBe('suppressed_correction');
    expect(plan.counts.alertEligible).toBe(0);
  });

  it('suppresses alerts on a rollback run by default', () => {
    const plan = buildPromotionPlanV1(planInput({ mode: 'rollback' }));
    expect(firstItem(plan).alertDisposition).toBe('suppressed_rollback');
  });

  it('never alerts for an entity the registry marks non-alertable', () => {
    const plan = buildPromotionPlanV1(planInput({ projections: [sagIdentity()], priorRows: [] }));
    expect(firstItem(plan).alertDisposition).toBe('suppressed_not_alertable');
  });

  it('checks run-mode suppression before entity eligibility', () => {
    expect(
      classifyAlertV1({ operation: 'INSERT', mode: 'baseline_hydration', alertEligible: true }),
    ).toBe('suppressed_hydration');
    expect(classifyAlertV1({ operation: 'INSERT', mode: 'new_cycle', alertEligible: true })).toBe(
      'eligible',
    );
    expect(
      classifyAlertV1({ operation: 'UNCHANGED', mode: 'new_cycle', alertEligible: true }),
    ).toBe('none');
    expect(classifyAlertV1({ operation: 'BLOCKED', mode: 'new_cycle', alertEligible: true })).toBe(
      'none',
    );
  });
});

describe('Phase 7 Workstream C — determinism', () => {
  it('produces the same plan hash for reordered equivalent inputs', () => {
    const forward = buildPromotionPlanV1(
      planInput({ projections: [sagIdentity(), sagYear()], priorRows: [] }),
    );
    const reversed = buildPromotionPlanV1(
      planInput({ projections: [sagYear(), sagIdentity()], priorRows: [] }),
    );
    expect(reversed.planHash).toBe(forward.planHash);
    expect(reversed.items).toEqual(forward.items);
  });

  it('is stable across repeated builds of the same input', () => {
    const input = planInput();
    expect(buildPromotionPlanV1(input).planHash).toBe(buildPromotionPlanV1(input).planHash);
  });

  it('stays deterministic under permutation of a large fixture', () => {
    const projections: PromotionProjectionInputV1[] = [];
    for (let index = 0; index < 250; index += 1) {
      const sagKey = `ARMY|OMA|SAG-${String(index).padStart(4, '0')}`;
      projections.push(
        sagIdentity({ projectionId: `sag-${index}`, naturalKey: sagKey }),
        sagYear({
          projectionId: `year-${index}`,
          naturalKey: `${sagKey}|2027|request`,
          parentNaturalKey: sagKey,
          values: {
            money: {
              originalValue: `${index}50`,
              originalUnit: 'thousands',
              valueMillions: `0.${String(index).padStart(3, '0')}5`,
            },
          },
        }),
      );
    }

    const forward = buildPromotionPlanV1(planInput({ projections, priorRows: [] }));
    // Deterministic permutation: reverse, then interleave halves.
    const shuffled = [...projections].reverse();
    const half = Math.floor(shuffled.length / 2);
    const interleaved: PromotionProjectionInputV1[] = [];
    for (let index = 0; index < half; index += 1) {
      interleaved.push(at(shuffled, index), at(shuffled, index + half));
    }
    if (shuffled.length % 2 === 1) interleaved.push(at(shuffled, shuffled.length - 1));

    const permuted = buildPromotionPlanV1(planInput({ projections: interleaved, priorRows: [] }));
    expect(permuted.planHash).toBe(forward.planHash);
    expect(forward.counts.total).toBe(500);
    expect(forward.blocked).toBe(false);
  });

  it('changes the plan hash when any proposed value changes', () => {
    const baseline = buildPromotionPlanV1(planInput()).planHash;
    const changed = buildPromotionPlanV1(
      planInput({
        projections: [
          sagYear({
            values: {
              money: { originalValue: '1251', originalUnit: 'thousands', valueMillions: '1.251' },
            },
          }),
        ],
      }),
    ).planHash;
    expect(changed).not.toBe(baseline);
  });

  it('summarizes diffs by family, entity, fiscal year, and funding field', () => {
    const plan = buildPromotionPlanV1(
      planInput({ projections: [sagIdentity(), sagYear()], priorRows: [] }),
    );
    expect(plan.diffsByFamily.map((bucket) => bucket.key)).toEqual(['om']);
    expect(plan.diffsByEntity.map((bucket) => bucket.key)).toEqual([
      'canonical_om_sag',
      'canonical_om_sag_year',
    ]);
    expect(plan.diffsByFiscalYear.map((bucket) => bucket.key)).toEqual(['(none)', '2027']);
    expect(plan.diffsByFundingField.map((bucket) => bucket.key)).toEqual(['(none)', 'request']);
  });
});

describe('Phase 7 Workstream C — execution expectations', () => {
  it('authorizes exactly the rows that change, and no others', () => {
    const plan = buildPromotionPlanV1(
      planInput({
        projections: [sagIdentity(), sagYear()],
        priorRows: [
          {
            canonicalEntity: 'canonical_om_sag',
            naturalKey: SAG_KEY,
            rowHash: proposedRowHashV1({
              canonicalEntity: 'canonical_om_sag',
              naturalKey: SAG_KEY,
              fiscalYear: null,
              fundingField: null,
              values: { textValue: 'Operating Forces' },
            }),
            snapshotId: ACTIVE,
          },
        ],
      }),
    );

    // The identity row is UNCHANGED; only the year row is staged.
    const expectations = buildExecutionExpectationsV1(plan);
    expect(expectations).toHaveLength(1);
    expect(expectations[0]).toEqual({
      canonicalEntity: 'canonical_om_sag_year',
      naturalKey: YEAR_KEY,
      rowHash: yearRowHash(),
      operation: 'INSERT',
    });
  });

  it('excludes blocked items from the executable set', () => {
    const plan = buildPromotionPlanV1(planInput({ priorRows: [] }));
    expect(firstItem(plan).operation).toBe('BLOCKED');
    expect(buildExecutionExpectationsV1(plan)).toEqual([]);
  });
});

describe('Phase 7 Workstream C — the planner writes nothing', () => {
  const source = readFileSync(join(__dirname, 'promotion-planner-v1.ts'), 'utf8');

  it('imports no Prisma client', () => {
    expect(source).not.toMatch(/from\s+['"]@prisma\/client['"]/);
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma[^'"]*['"]/i);
  });

  it('contains no Prisma DML call', () => {
    // Anchored to an identifier receiver so `createHash(...).update(...)` and
    // similar non-DML calls cannot produce a false positive, which is how the
    // Phase 6 gate misfired.
    const dml =
      /\b[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|executeRawUnsafe)\s*\(/;
    expect(dml.test(source)).toBe(false);
  });

  it('reads no clock and no random source', () => {
    expect(source).not.toMatch(/Date\s*\.\s*now\s*\(/);
    expect(source).not.toMatch(/new\s+Date\s*\(/);
    expect(source).not.toMatch(/Math\s*\.\s*random\s*\(/);
  });
});
