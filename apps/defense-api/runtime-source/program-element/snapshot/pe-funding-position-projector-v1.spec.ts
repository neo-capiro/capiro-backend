import {
  projectPeBudgetPositionsV1,
  toBudgetPositionLikeV1,
} from './pe-funding-position-projector-v1.js';
import type { SnapshotReadRowV1 } from '../../defense-budget/promotion/manual-override-overlay-v1.js';

const SNAP = 'aaaaaaaa-0000-0000-0000-000000000001';

function positionRow(overrides: Partial<SnapshotReadRowV1> = {}): SnapshotReadRowV1 {
  return {
    snapshotId: SNAP,
    canonicalEntity: 'canonical_rdte_budget_position',
    canonicalNaturalKey: 'PE0601|pb_fy2027|2027|total',
    parentNaturalKey: 'PE0601',
    family: 'rdte',
    fiscalYear: 2027,
    fundingField: null,
    stage: null,
    canonicalRowHash: 'hash-1',
    money: { originalValue: '5000', originalUnit: 'thousands', valueMillions: '5' },
    quantity: null,
    unitCostDollars: null,
    textValue: null,
    dateValue: null,
    attributes: { peCode: 'PE0601', positionCycle: 'pb_fy2027', valueKind: 'total' },
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

describe('projectPeBudgetPositionsV1', () => {
  it('maps a total-kind row into amount, leaving quantity null', () => {
    const [row] = projectPeBudgetPositionsV1([positionRow()]);
    expect(row).toEqual({
      positionCycle: 'pb_fy2027',
      assertedFy: 2027,
      amount: '5',
      quantity: null,
      valueKind: 'total',
      sourceUrl: null,
      pageNumber: null,
    });
  });

  it('maps a quantity-kind row into quantity, leaving amount null', () => {
    const row = positionRow({
      attributes: { peCode: 'PE0601', positionCycle: 'pb_fy2027', valueKind: 'quantity' },
      money: { originalValue: '12', originalUnit: 'each', valueMillions: '12' },
    });
    const [out] = projectPeBudgetPositionsV1([row]);
    expect(out).toEqual({
      positionCycle: 'pb_fy2027',
      assertedFy: 2027,
      amount: null,
      quantity: '12',
      valueKind: 'quantity',
      sourceUrl: null,
      pageNumber: null,
    });
  });

  it('ignores rows from a different canonical entity', () => {
    const out = projectPeBudgetPositionsV1([
      positionRow({ canonicalEntity: 'canonical_rdte_program_element_year' }),
    ]);
    expect(out).toEqual([]);
  });

  it('skips a row missing positionCycle or valueKind rather than guessing', () => {
    const missingCycle = positionRow({ attributes: { peCode: 'PE0601', valueKind: 'total' } });
    const missingKind = positionRow({
      attributes: { peCode: 'PE0601', positionCycle: 'pb_fy2027' },
    });
    expect(projectPeBudgetPositionsV1([missingCycle])).toEqual([]);
    expect(projectPeBudgetPositionsV1([missingKind])).toEqual([]);
  });

  it('sorts by assertedFy, then positionCycle, then valueKind', () => {
    const a = positionRow({ fiscalYear: 2028, canonicalNaturalKey: 'a' });
    const b = positionRow({
      fiscalYear: 2027,
      attributes: { peCode: 'PE0601', positionCycle: 'pb_fy2026', valueKind: 'total' },
      canonicalNaturalKey: 'b',
    });
    const c = positionRow({
      fiscalYear: 2027,
      attributes: { peCode: 'PE0601', positionCycle: 'pb_fy2027', valueKind: 'quantity' },
      canonicalNaturalKey: 'c',
    });
    const d = positionRow({ fiscalYear: 2027, canonicalNaturalKey: 'd' }); // fy2027, pb_fy2027, total
    const out = projectPeBudgetPositionsV1([a, b, c, d]);
    expect(out.map((r) => [r.assertedFy, r.positionCycle, r.valueKind])).toEqual([
      [2027, 'pb_fy2026', 'total'],
      [2027, 'pb_fy2027', 'quantity'],
      [2027, 'pb_fy2027', 'total'],
      [2028, 'pb_fy2027', 'total'],
    ]);
  });

  it('uses the override value, not the official one, when a row is overridden', () => {
    const row = positionRow({
      money: { originalValue: '9', originalUnit: 'millions', valueMillions: '9' },
      officialMoney: { originalValue: '5000', originalUnit: 'thousands', valueMillions: '5' },
      override: {
        label: 'manual_override',
        overrideId: 'ovr-1',
        version: 1,
        reason: 'OCR misread',
        approverActorId: 'approver-1',
        approvedAt: '2026-08-01T00:00:00.000Z',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        effectiveTo: null,
      },
    });
    const out = projectPeBudgetPositionsV1([row])[0]!;
    expect(out.amount).toBe('9');
  });
});

describe('toBudgetPositionLikeV1', () => {
  it('narrows to the fields computePbComparison needs, passing amount through unmodified', () => {
    const projected = projectPeBudgetPositionsV1([positionRow()])[0]!;
    const like = toBudgetPositionLikeV1([projected])[0]!;
    expect(like).toEqual({
      positionCycle: 'pb_fy2027',
      assertedFy: 2027,
      amount: '5',
      valueKind: 'total',
    });
  });
});
