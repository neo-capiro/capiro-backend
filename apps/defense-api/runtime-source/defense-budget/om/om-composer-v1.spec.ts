/**
 * Phase 5 Workstream I tests — O&M composition, verification, and
 * reconciliation.
 */
import {
  reconcileOmFunding,
  checkOp5ChangeArithmetic,
  type OmFundingValueV1,
} from './om-reconciliation-v1.js';
import {
  verifyOmFamily,
  type OmIdentityInput,
  type OmVerificationInput,
} from './om-verification-policy-v1.js';
import { composeOmFamily } from './om-composer-v1.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  DefenseBudgetAssertionV1,
} from '../contracts/extraction-artifact-v1.js';
import type { ColumnBindingV1 } from '../non-rdte/column-semantics-v1.js';
import type { PrintedUnitV1 } from '../non-rdte/unit-semantics-v1.js';

const CYCLE_FY = 2027;

function makeColumnBinding(overrides: Partial<ColumnBindingV1> = {}): ColumnBindingV1 {
  return {
    columnIndex: 0,
    headerText: 'FY 2027 Request ($ in Millions)',
    fiscalYear: CYCLE_FY,
    valueKind: 'money',
    baseOcoStatus: 'none',
    fundingStage: 'budget_year_request',
    confident: true,
    reason: 'test',
    ...overrides,
  };
}

function makeFundingValue(overrides: Partial<OmFundingValueV1> = {}): OmFundingValueV1 {
  return {
    identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
    identity: {
      lineKind: 'OM_SAG',
      code: '1A',
      printedCode: '1A',
      account: 'O&M, ARMY',
      component: 'ARMY',
      naturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
    },
    fiscalYear: CYCLE_FY,
    columnBinding: makeColumnBinding(),
    originalValue: '150',
    originalUnit: 'millions' as PrintedUnitV1,
    valueMillions: '150',
    page: 1,
    ...overrides,
  };
}

function makeIdentityInput(overrides: Partial<OmIdentityInput> = {}): OmIdentityInput {
  return {
    naturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
    printedCode: '1A',
    account: 'O&M, Army',
    component: 'ARMY',
    exhibit: 'O-1',
    page: 1,
    hasNarrative: false,
    hasQuantity: false,
    hasFunding: true,
    ...overrides,
  };
}

function makeArtifact(assertions: DefenseBudgetAssertionV1[]): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: 'dbx1_test',
    contentSha256: '0'.repeat(64),
    source: {
      manifestDocumentKey: 'test',
      sourcePdfSha256: 'e'.repeat(64),
      sourceLocator: 's3://test',
      fiscalYear: CYCLE_FY,
      family: 'om',
      exhibit: 'O-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb_fy2027',
      documentType: 'pb_exhibit',
    },
    parserRuns: [],
    evidence: [],
    sourceFacts: [],
    assertions,
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: assertions.length,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
  };
}

describe('om-reconciliation-v1', () => {
  it('matching O-1/OP-5 amounts pass', () => {
    const o1 = makeFundingValue({ valueMillions: '150', originalValue: '150' });
    const op5 = makeFundingValue({ valueMillions: '150', originalValue: '150' });
    const comparisons = reconcileOmFunding({ o1Values: [o1], op5Values: [op5] });
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]?.result).toBe('pass');
  });

  it('unit-converted equivalent values pass', () => {
    const o1 = makeFundingValue({
      valueMillions: '150',
      originalValue: '150000',
      originalUnit: 'thousands' as PrintedUnitV1,
    });
    const op5 = makeFundingValue({
      valueMillions: '150',
      originalValue: '150',
      originalUnit: 'millions' as PrintedUnitV1,
    });
    const comparisons = reconcileOmFunding({ o1Values: [o1], op5Values: [op5] });
    expect(comparisons[0]?.result).toBe('pass');
  });

  it('material mismatch fails', () => {
    const o1 = makeFundingValue({ valueMillions: '150' });
    const op5 = makeFundingValue({ valueMillions: '200' });
    const comparisons = reconcileOmFunding({ o1Values: [o1], op5Values: [op5] });
    expect(comparisons[0]?.result).toBe('fail');
  });

  it('missing OP-5 is not_run', () => {
    const o1 = makeFundingValue();
    const comparisons = reconcileOmFunding({ o1Values: [o1], op5Values: [] });
    expect(comparisons[0]?.result).toBe('not_run');
  });

  it('different scope does not reconcile', () => {
    const o1 = makeFundingValue({
      columnBinding: makeColumnBinding({ fundingStage: 'budget_year_request' }),
    });
    const op5 = makeFundingValue({
      columnBinding: makeColumnBinding({ fundingStage: 'prior_actual' }),
    });
    const comparisons = reconcileOmFunding({ o1Values: [o1], op5Values: [op5] });
    /* Different funding stages → different scope keys → each not_run */
    expect(comparisons).toHaveLength(2);
    expect(comparisons[0]?.result).toBe('not_run');
    expect(comparisons[1]?.result).toBe('not_run');
  });

  it('same SAG code in different accounts remains separate', () => {
    const o1a = makeFundingValue({
      identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
      valueMillions: '100',
    });
    const o1b = makeFundingValue({
      identityNaturalKey: 'OM_SAG:NAVY:O&M, NAVY:1A',
      valueMillions: '200',
    });
    const op5a = makeFundingValue({
      identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
      valueMillions: '100',
    });
    const op5b = makeFundingValue({
      identityNaturalKey: 'OM_SAG:NAVY:O&M, NAVY:1A',
      valueMillions: '200',
    });
    const comparisons = reconcileOmFunding({
      o1Values: [o1a, o1b],
      op5Values: [op5a, op5b],
    });
    expect(comparisons).toHaveLength(2);
    expect(comparisons[0]?.result).toBe('pass');
    expect(comparisons[1]?.result).toBe('pass');
  });

  it('NaN/ambiguous units reject before comparison', () => {
    const o1 = makeFundingValue({ valueMillions: 'NaN' });
    const op5 = makeFundingValue({ valueMillions: '150' });
    const comparisons = reconcileOmFunding({ o1Values: [o1], op5Values: [op5] });
    expect(comparisons[0]?.result).toBe('review');
  });

  it('no comparison does not pass', () => {
    const comparisons = reconcileOmFunding({ o1Values: [], op5Values: [] });
    expect(comparisons).toHaveLength(0);
  });
});

describe('om-verification-policy-v1', () => {
  function makeVerificationInput(
    overrides: Partial<OmVerificationInput> = {},
  ): OmVerificationInput {
    return {
      o1Identities: [makeIdentityInput()],
      op5Identities: [makeIdentityInput({ exhibit: 'OP-5' })],
      fundingComparisons: [],
      requiredIdentityKeys: [],
      op5Required: true,
      requiredNarrativeSections: ['mission', 'justification'],
      requiredQuantityCategories: ['workload'],
      changeArithmetic: { applicable: false },
      ...overrides,
    };
  }

  it('passes with complete O-1/OP-5 and matching funding', () => {
    const result = verifyOmFamily(
      makeVerificationInput({
        op5Identities: [
          makeIdentityInput({
            exhibit: 'OP-5',
            hasNarrative: true,
            hasQuantity: true,
          }),
        ],
        fundingComparisons: [
          {
            identityNaturalKey: 'test',
            printedCode: '1A',
            fiscalYear: CYCLE_FY,
            columnRole: 'budget_year_request',
            o1ValueMillions: '150',
            op5ValueMillions: '150',
            result: 'pass',
          },
        ],
      }),
    );
    expect(result.decision).toBe('VERIFICATION_PASSED');
    expect(result.blocking).toBe(false);
  });

  it('blocks when O-1 is missing', () => {
    const result = verifyOmFamily(makeVerificationInput({ o1Identities: [] }));
    expect(result.blocking).toBe(true);
    expect(result.decision).toBe('REJECTED');
  });

  it('blocks when OP-5 is required and missing', () => {
    const result = verifyOmFamily(makeVerificationInput({ op5Identities: [] }));
    expect(result.blocking).toBe(true);
  });

  it('blocks on funding mismatch', () => {
    const result = verifyOmFamily(
      makeVerificationInput({
        fundingComparisons: [
          {
            identityNaturalKey: 'test',
            printedCode: '1A',
            fiscalYear: CYCLE_FY,
            columnRole: 'budget_year_request',
            o1ValueMillions: '150',
            op5ValueMillions: '200',
            result: 'fail',
          },
        ],
      }),
    );
    expect(result.blocking).toBe(true);
  });

  it('blocks on missing comparison when OP-5 required', () => {
    const result = verifyOmFamily(
      makeVerificationInput({
        fundingComparisons: [
          {
            identityNaturalKey: 'test',
            printedCode: '1A',
            fiscalYear: CYCLE_FY,
            columnRole: 'budget_year_request',
            result: 'not_run',
          },
        ],
      }),
    );
    expect(result.blocking).toBe(true);
  });

  it('review when narrative missing', () => {
    const result = verifyOmFamily(
      makeVerificationInput({
        op5Identities: [makeIdentityInput({ exhibit: 'OP-5', hasNarrative: false })],
        requiredNarrativeSections: ['mission'],
      }),
    );
    expect(result.findings.some((f) => f.code === 'required_narrative_missing')).toBe(true);
  });

  it('review when quantity missing', () => {
    const result = verifyOmFamily(
      makeVerificationInput({
        op5Identities: [makeIdentityInput({ exhibit: 'OP-5', hasQuantity: false })],
        requiredQuantityCategories: ['workload'],
      }),
    );
    expect(result.findings.some((f) => f.code === 'required_quantity_missing')).toBe(true);
  });

  it('review when change arithmetic fails', () => {
    const result = verifyOmFamily(
      makeVerificationInput({
        changeArithmetic: { applicable: true, passed: false },
      }),
    );
    expect(result.findings.some((f) => f.code === 'op5_change_arithmetic_mismatch')).toBe(true);
  });

  it('blocks on duplicate O-1 identity', () => {
    const result = verifyOmFamily(
      makeVerificationInput({
        o1Identities: [
          makeIdentityInput({ naturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A' }),
          makeIdentityInput({ naturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A' }),
        ],
      }),
    );
    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'duplicate_o1_identity')).toBe(true);
  });

  it('blocks on required identity missing', () => {
    const result = verifyOmFamily(
      makeVerificationInput({
        requiredIdentityKeys: ['OM_SAG:ARMY:O&M, ARMY:ZZZ'],
      }),
    );
    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'required_identity_not_found')).toBe(true);
  });
});

describe('om-composer-v1', () => {
  it('composes empty artifacts to incomplete report', () => {
    const report = composeOmFamily({
      artifacts: {
        o1Artifacts: [],
        op5Artifacts: [],
      },
      requiredIdentityKeys: [],
      op5Required: true,
      requiredNarrativeSections: [],
      requiredQuantityCategories: [],
    });
    expect(report.completenessStatus).toBe('incomplete');
    expect(report.missingExhibits).toContain('O-1');
    expect(report.missingExhibits).toContain('OP-5');
  });

  it('no canonical writer is imported', () => {
    const composerSource = require('fs').readFileSync(
      require('path').join(__dirname, 'om-composer-v1.ts'),
      'utf-8',
    );
    const importLines = composerSource
      .split('\n')
      .filter((l: string) => l.trim().startsWith('import '));
    for (const line of importLines) {
      expect(line).not.toContain('ProgramElementWriterService');
      expect(line).not.toContain('upsertProgramElement');
      expect(line).not.toContain('assertPromotionReady');
      expect(line).not.toContain('getCanonicalPromotionRecords');
      expect(line).not.toContain('promotionReady');
      expect(line).not.toContain('canonicalEligible');
    }
  });

  it('parser warning forces review', () => {
    /* When there are review-severity findings (e.g. narrative missing),
     * the completeness status should be needs_review, not complete. */
    const omLineAssertion: DefenseBudgetAssertionV1 = {
      assertionId: 'test_om_line',
      assertionKind: 'om_line',
      sourceFactIds: [],
      evidenceIds: [],
      confidence: 1,
      identity: {
        lineKind: 'OM_SAG',
        code: '1A',
        account: 'O&M, ARMY',
        component: 'ARMY',
      },
      title: 'Test SAG',
    } as DefenseBudgetAssertionV1;

    const report = composeOmFamily({
      artifacts: {
        o1Artifacts: [makeArtifact([omLineAssertion])],
        op5Artifacts: [makeArtifact([omLineAssertion])],
      },
      requiredIdentityKeys: [],
      op5Required: true,
      requiredNarrativeSections: ['mission'],
      requiredQuantityCategories: ['workload'],
    });
    /* Should be needs_review because narrative and quantity are missing */
    expect(report.completenessStatus).not.toBe('complete');
  });
});

describe('checkOp5ChangeArithmetic', () => {
  it('returns not applicable when components are missing', () => {
    const result = checkOp5ChangeArithmetic({
      changes: [
        {
          identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
          changeType: 'price_change',
          fiscalYear: CYCLE_FY,
          valueMillions: '10',
          originalValue: '10',
        },
      ],
    });
    expect(result.applicable).toBe(false);
  });

  it('passes when arithmetic is correct', () => {
    const result = checkOp5ChangeArithmetic({
      changes: [
        {
          identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
          changeType: 'price_change',
          fiscalYear: CYCLE_FY,
          valueMillions: '10',
          originalValue: '10',
        },
        {
          identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
          changeType: 'program_change',
          fiscalYear: CYCLE_FY,
          valueMillions: '5',
          originalValue: '5',
        },
        {
          identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
          changeType: 'transfer',
          fiscalYear: CYCLE_FY,
          valueMillions: '2',
          originalValue: '2',
        },
        {
          identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
          changeType: 'total_change',
          fiscalYear: CYCLE_FY,
          valueMillions: '17',
          originalValue: '17',
        },
      ],
    });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails when arithmetic is incorrect', () => {
    const result = checkOp5ChangeArithmetic({
      changes: [
        {
          identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
          changeType: 'price_change',
          fiscalYear: CYCLE_FY,
          valueMillions: '10',
          originalValue: '10',
        },
        {
          identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
          changeType: 'program_change',
          fiscalYear: CYCLE_FY,
          valueMillions: '5',
          originalValue: '5',
        },
        {
          identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:1A',
          changeType: 'total_change',
          fiscalYear: CYCLE_FY,
          valueMillions: '20',
          originalValue: '20',
        },
      ],
    });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
  });
});
