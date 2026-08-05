/**
 * Phase 5 Workstream L tests — MILCON composition, verification, and
 * reconciliation.
 */
import {
  reconcileMilconFunding,
  checkDd1391CostArithmetic,
  type MilconFundingValueV1,
} from './milcon-reconciliation-v1.js';
import {
  verifyMilconFamily,
  type MilconIdentityInput,
  type MilconVerificationInput,
} from './milcon-verification-policy-v1.js';
import { composeMilconFamily } from './milcon-composer-v1.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  DefenseBudgetAssertionV1,
} from '../contracts/extraction-artifact-v1.js';
import type { PrintedUnitV1 } from '../non-rdte/unit-semantics-v1.js';

const CYCLE_FY = 2027;

function makeFundingValue(
  overrides: Partial<MilconFundingValueV1> = {},
): MilconFundingValueV1 {
  return {
    identityNaturalKey: 'MILCON_PROJECT:ARMY:ABC-12345:NO_LOC:NO_LOC',
    printedProjectCode: 'ABC-12345',
    fundingType: 'request',
    fiscalYear: CYCLE_FY,
    originalValue: '45000',
    originalUnit: 'thousands' as PrintedUnitV1,
    valueMillions: '45',
    page: 1,
    ...overrides,
  };
}

function makeIdentityInput(
  overrides: Partial<MilconIdentityInput> = {},
): MilconIdentityInput {
  return {
    naturalKey: 'MILCON_PROJECT:ARMY:ABC-12345:NO_LOC:NO_LOC',
    printedProjectCode: 'ABC-12345',
    component: 'ARMY',
    exhibit: 'C-1',
    page: 1,
    hasScope: true,
    hasSchedule: true,
    hasNarrative: true,
    hasCostCategory: true,
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
      family: 'milcon',
      exhibit: 'C-1',
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

describe('milcon-reconciliation-v1', () => {
  it('matching C-1/DD1391 amounts pass', () => {
    const c1 = makeFundingValue({ valueMillions: '45' });
    const dd = makeFundingValue({ valueMillions: '45' });
    const comparisons = reconcileMilconFunding({ c1Values: [c1], dd1391Values: [dd] });
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]?.result).toBe('pass');
  });

  it('mismatch fails', () => {
    const c1 = makeFundingValue({ valueMillions: '45' });
    const dd = makeFundingValue({ valueMillions: '50' });
    const comparisons = reconcileMilconFunding({ c1Values: [c1], dd1391Values: [dd] });
    expect(comparisons[0]?.result).toBe('fail');
  });

  it('missing DD1391 is not_run', () => {
    const c1 = makeFundingValue();
    const comparisons = reconcileMilconFunding({ c1Values: [c1], dd1391Values: [] });
    expect(comparisons[0]?.result).toBe('not_run');
  });

  it('different FY does not reconcile', () => {
    const c1 = makeFundingValue({ fiscalYear: 2027 });
    const dd = makeFundingValue({ fiscalYear: 2028 });
    const comparisons = reconcileMilconFunding({ c1Values: [c1], dd1391Values: [dd] });
    /* Different FY → different scope keys → each not_run */
    expect(comparisons).toHaveLength(2);
    expect(comparisons[0]?.result).toBe('not_run');
    expect(comparisons[1]?.result).toBe('not_run');
  });

  it('same title but different project identity remains separate', () => {
    const c1a = makeFundingValue({
      identityNaturalKey: 'MILCON_PROJECT:ARMY:PROJ-001:FT_BRAGG:FT_BRAGG',
      printedProjectCode: 'PROJ-001',
      valueMillions: '30',
    });
    const c1b = makeFundingValue({
      identityNaturalKey: 'MILCON_PROJECT:ARMY:PROJ-001:FT_HOOD:FT_HOOD',
      printedProjectCode: 'PROJ-001',
      valueMillions: '25',
    });
    const dd1 = makeFundingValue({
      identityNaturalKey: 'MILCON_PROJECT:ARMY:PROJ-001:FT_BRAGG:FT_BRAGG',
      printedProjectCode: 'PROJ-001',
      valueMillions: '30',
    });
    const dd2 = makeFundingValue({
      identityNaturalKey: 'MILCON_PROJECT:ARMY:PROJ-001:FT_HOOD:FT_HOOD',
      printedProjectCode: 'PROJ-001',
      valueMillions: '25',
    });
    const comparisons = reconcileMilconFunding({
      c1Values: [c1a, c1b],
      dd1391Values: [dd1, dd2],
    });
    expect(comparisons).toHaveLength(2);
    expect(comparisons[0]?.result).toBe('pass');
    expect(comparisons[1]?.result).toBe('pass');
  });

  it('no comparison does not pass', () => {
    const comparisons = reconcileMilconFunding({ c1Values: [], dd1391Values: [] });
    expect(comparisons).toHaveLength(0);
  });
});

describe('milcon-verification-policy-v1', () => {
  function makeVerificationInput(
    overrides: Partial<MilconVerificationInput> = {},
  ): MilconVerificationInput {
    return {
      c1Identities: [makeIdentityInput()],
      dd1391Identities: [makeIdentityInput({ exhibit: 'DD1391' })],
      fundingComparisons: [],
      requiredIdentityKeys: [],
      dd1391Required: true,
      requiredNarrativeSections: ['requirement', 'impact'],
      costArithmetic: { applicable: false },
      ocrConfidenceIssues: [],
      ...overrides,
    };
  }

  it('passes with complete C-1/DD1391 and matching funding', () => {
    const result = verifyMilconFamily(
      makeVerificationInput({
        fundingComparisons: [
          {
            identityNaturalKey: 'test',
            printedProjectCode: 'ABC-12345',
            fiscalYear: CYCLE_FY,
            fundingType: 'request',
            c1ValueMillions: '45',
            dd1391ValueMillions: '45',
            result: 'pass',
          },
        ],
      }),
    );
    expect(result.decision).toBe('VERIFICATION_PASSED');
    expect(result.blocking).toBe(false);
  });

  it('blocks when C-1 is missing', () => {
    const result = verifyMilconFamily(makeVerificationInput({ c1Identities: [] }));
    expect(result.blocking).toBe(true);
    expect(result.decision).toBe('REJECTED');
  });

  it('blocks when DD1391 is required and missing', () => {
    const result = verifyMilconFamily(makeVerificationInput({ dd1391Identities: [] }));
    expect(result.blocking).toBe(true);
  });

  it('blocks on funding mismatch', () => {
    const result = verifyMilconFamily(
      makeVerificationInput({
        fundingComparisons: [
          {
            identityNaturalKey: 'test',
            printedProjectCode: 'ABC-12345',
            fiscalYear: CYCLE_FY,
            fundingType: 'request',
            c1ValueMillions: '45',
            dd1391ValueMillions: '50',
            result: 'fail',
          },
        ],
      }),
    );
    expect(result.blocking).toBe(true);
  });

  it('blocks on missing comparison when DD1391 required', () => {
    const result = verifyMilconFamily(
      makeVerificationInput({
        fundingComparisons: [
          {
            identityNaturalKey: 'test',
            printedProjectCode: 'ABC-12345',
            fiscalYear: CYCLE_FY,
            fundingType: 'request',
            result: 'not_run',
          },
        ],
      }),
    );
    expect(result.blocking).toBe(true);
  });

  it('review on missing scope', () => {
    const result = verifyMilconFamily(
      makeVerificationInput({
        dd1391Identities: [makeIdentityInput({ exhibit: 'DD1391', hasScope: false })],
      }),
    );
    expect(result.findings.some((f) => f.code === 'project_scope_missing')).toBe(true);
  });

  it('review on missing schedule', () => {
    const result = verifyMilconFamily(
      makeVerificationInput({
        dd1391Identities: [makeIdentityInput({ exhibit: 'DD1391', hasSchedule: false })],
      }),
    );
    expect(result.findings.some((f) => f.code === 'project_schedule_missing')).toBe(true);
  });

  it('review on cost arithmetic failure', () => {
    const result = verifyMilconFamily(
      makeVerificationInput({
        costArithmetic: { applicable: true, passed: false },
      }),
    );
    expect(result.findings.some((f) => f.code === 'dd1391_cost_arithmetic_mismatch')).toBe(true);
  });

  it('review on OCR low confidence', () => {
    const result = verifyMilconFamily(
      makeVerificationInput({
        ocrConfidenceIssues: [
          { identityNaturalKey: 'MILCON_PROJECT:ARMY:OCR-001:NO_LOC:NO_LOC', requiresReview: true },
        ],
      }),
    );
    expect(result.findings.some((f) => f.code === 'ocr_low_confidence')).toBe(true);
  });

  it('blocks on required identity missing', () => {
    const result = verifyMilconFamily(
      makeVerificationInput({
        requiredIdentityKeys: ['MILCON_PROJECT:ARMY:ZZZ-999:NO_LOC:NO_LOC'],
      }),
    );
    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'required_identity_not_found')).toBe(true);
  });

  it('no fuzzy title match can produce certification', () => {
    /* DD1391 identity without a C-1 counterpart by natural key → review */
    const result = verifyMilconFamily(
      makeVerificationInput({
        c1Identities: [makeIdentityInput({ naturalKey: 'MILCON_PROJECT:ARMY:C1-001:NO_LOC:NO_LOC' })],
        dd1391Identities: [
          makeIdentityInput({
            exhibit: 'DD1391',
            naturalKey: 'MILCON_PROJECT:ARMY:DD-001:NO_LOC:NO_LOC',
          }),
        ],
      }),
    );
    expect(result.findings.some((f) => f.code === 'dd1391_no_c1_counterpart')).toBe(true);
  });
});

describe('milcon-composer-v1', () => {
  it('composes empty artifacts to incomplete report', () => {
    const report = composeMilconFamily({
      artifacts: {
        c1Artifacts: [],
        dd1391Artifacts: [],
      },
      requiredIdentityKeys: [],
      dd1391Required: true,
      requiredNarrativeSections: [],
    });
    expect(report.completenessStatus).toBe('incomplete');
    expect(report.missingExhibits).toContain('C-1');
    expect(report.missingExhibits).toContain('DD1391');
  });

  it('no canonical writer is imported', () => {
    const composerSource = require('fs').readFileSync(
      require('path').join(__dirname, 'milcon-composer-v1.ts'),
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
});

describe('checkDd1391CostArithmetic', () => {
  it('returns not applicable when no total_request', () => {
    const result = checkDd1391CostArithmetic({
      costs: [
        { identityNaturalKey: 'k', costCategory: 'primary_facility', valueMillions: '30' },
      ],
    });
    expect(result.applicable).toBe(false);
  });

  it('returns not applicable when missing primary or contingency', () => {
    const result = checkDd1391CostArithmetic({
      costs: [
        { identityNaturalKey: 'k', costCategory: 'primary_facility', valueMillions: '30' },
        { identityNaturalKey: 'k', costCategory: 'total_request', valueMillions: '30' },
      ],
    });
    expect(result.applicable).toBe(false);
  });

  it('passes when sum equals total', () => {
    const result = checkDd1391CostArithmetic({
      costs: [
        { identityNaturalKey: 'k', costCategory: 'primary_facility', valueMillions: '30' },
        { identityNaturalKey: 'k', costCategory: 'contingency', valueMillions: '3' },
        { identityNaturalKey: 'k', costCategory: 'total_request', valueMillions: '33' },
      ],
    });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails when sum does not equal total', () => {
    const result = checkDd1391CostArithmetic({
      costs: [
        { identityNaturalKey: 'k', costCategory: 'primary_facility', valueMillions: '30' },
        { identityNaturalKey: 'k', costCategory: 'contingency', valueMillions: '3' },
        { identityNaturalKey: 'k', costCategory: 'total_request', valueMillions: '50' },
      ],
    });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
  });
});
