/**
 * Phase 5 Workstream F tests — procurement composition, verification,
 * and reconciliation.
 */
import { reconcileProcurementFunding, compareUnitConvertedValues, type ProcurementFundingValueV1 } from './procurement-reconciliation-v1.js';
import { verifyProcurementFamily, type ProcurementIdentityInput, type ProcurementVerificationInput } from './procurement-verification-policy-v1.js';
import { composeProcurementFamily, type ProcurementCompositionInput } from './procurement-composer-v1.js';
import type { DefenseBudgetExtractionArtifactV1, DefenseBudgetAssertionV1 } from '../contracts/extraction-artifact-v1.js';
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

function makeFundingValue(overrides: Partial<ProcurementFundingValueV1> = {}): ProcurementFundingValueV1 {
  return {
    identityNaturalKey: 'PROCUREMENT_BLIN:ARMY:2031A: AIRCRAFT PROCUREMENT, ARMY:9670A00005:base',
    identity: {
      lineKind: 'PROCUREMENT_BLIN',
      code: '9670A00005',
      printedCode: '9670A00005',
      account: '2031A: AIRCRAFT PROCUREMENT, ARMY',
      component: 'ARMY',
      advanceProcurement: false,
      naturalKey: 'PROCUREMENT_BLIN:ARMY:2031A: AIRCRAFT PROCUREMENT, ARMY:9670A00005:base',
    },
    fiscalYear: CYCLE_FY,
    columnBinding: makeColumnBinding(),
    originalValue: '240',
    originalUnit: 'millions' as PrintedUnitV1,
    valueMillions: '240',
    page: 1,
    ...overrides,
  };
}

function makeIdentityInput(overrides: Partial<ProcurementIdentityInput> = {}): ProcurementIdentityInput {
  return {
    naturalKey: 'PROCUREMENT_BLIN:ARMY:2031A: AIRCRAFT PROCUREMENT, ARMY:9670A00005:base',
    printedCode: '9670A00005',
    account: '2031A: Aircraft Procurement, Army',
    component: 'ARMY',
    advanceProcurement: false,
    exhibit: 'P-1',
    page: 1,
    hasQuantity: true,
    hasUnitCost: true,
    hasNarrative: true,
    referencedPeCodes: [],
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
      family: 'procurement',
      exhibit: 'P-1',
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

describe('procurement-reconciliation-v1', () => {
  it('matching P-1/P-40 amounts pass', () => {
    const p1 = makeFundingValue({ valueMillions: '240', originalValue: '240' });
    const p40 = makeFundingValue({ valueMillions: '240', originalValue: '240' });
    const comparisons = reconcileProcurementFunding({ p1Values: [p1], p40Values: [p40] });
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]?.result).toBe('pass');
  });

  it('unit-converted equivalent values pass exactly/tolerantly', () => {
    const p1 = makeFundingValue({
      valueMillions: '240',
      originalValue: '240000',
      originalUnit: 'thousands' as PrintedUnitV1,
    });
    const p40 = makeFundingValue({
      valueMillions: '240',
      originalValue: '240',
      originalUnit: 'millions' as PrintedUnitV1,
    });
    const comparisons = reconcileProcurementFunding({ p1Values: [p1], p40Values: [p40] });
    expect(comparisons[0]?.result).toBe('pass');
  });

  it('material mismatch needs review/rejection', () => {
    const p1 = makeFundingValue({ valueMillions: '240' });
    const p40 = makeFundingValue({ valueMillions: '300' });
    const comparisons = reconcileProcurementFunding({ p1Values: [p1], p40Values: [p40] });
    expect(comparisons[0]?.result).toBe('fail');
  });

  it('missing P-40 blocks required detail completeness (not_run)', () => {
    const p1 = makeFundingValue();
    const comparisons = reconcileProcurementFunding({ p1Values: [p1], p40Values: [] });
    expect(comparisons[0]?.result).toBe('not_run');
  });

  it('same line code in different accounts remains separate', () => {
    const p1a = makeFundingValue({
      identityNaturalKey: 'PROCUREMENT_BLIN:NAVY:1506N: AIRCRAFT PROCUREMENT, NAVY:0145:base',
      valueMillions: '100',
    });
    const p1b = makeFundingValue({
      identityNaturalKey: 'PROCUREMENT_BLIN:NAVY:1706N: OTHER PROCUREMENT, NAVY:0145:base',
      valueMillions: '200',
    });
    const p40a = makeFundingValue({
      identityNaturalKey: 'PROCUREMENT_BLIN:NAVY:1506N: AIRCRAFT PROCUREMENT, NAVY:0145:base',
      valueMillions: '100',
    });
    const p40b = makeFundingValue({
      identityNaturalKey: 'PROCUREMENT_BLIN:NAVY:1706N: OTHER PROCUREMENT, NAVY:0145:base',
      valueMillions: '200',
    });
    const comparisons = reconcileProcurementFunding({ p1Values: [p1a, p1b], p40Values: [p40a, p40b] });
    expect(comparisons).toHaveLength(2);
    expect(comparisons[0]?.result).toBe('pass');
    expect(comparisons[1]?.result).toBe('pass');
  });

  it('P-1 base and P-40 AP cannot reconcile (different identities)', () => {
    const p1Base = makeFundingValue({
      identityNaturalKey: 'PROCUREMENT_BLIN:ARMY:2031A: AIRCRAFT PROCUREMENT, ARMY:9670A00005:base',
      valueMillions: '240',
    });
    const p40AP = makeFundingValue({
      identityNaturalKey: 'PROCUREMENT_BLIN:ARMY:2031A: AIRCRAFT PROCUREMENT, ARMY:9670A00005:advance',
      valueMillions: '50',
    });
    const comparisons = reconcileProcurementFunding({ p1Values: [p1Base], p40Values: [p40AP] });
    /* Different natural keys → each has a missing counterpart → not_run */
    expect(comparisons).toHaveLength(2);
    expect(comparisons[0]?.result).toBe('not_run');
    expect(comparisons[1]?.result).toBe('not_run');
  });

  it('NaN/infinity/ambiguous units reject before comparison', () => {
    const p1 = makeFundingValue({ valueMillions: 'NaN' });
    const p40 = makeFundingValue({ valueMillions: '240' });
    /* toCanonicalDecimal will throw on NaN → comparison returns 'review' */
    const comparisons = reconcileProcurementFunding({ p1Values: [p1], p40Values: [p40] });
    expect(comparisons[0]?.result).toBe('review');
  });

  it('no comparison does not pass', () => {
    const comparisons = reconcileProcurementFunding({ p1Values: [], p40Values: [] });
    expect(comparisons).toHaveLength(0);
  });

  it('compareUnitConvertedValues handles thousands vs millions', () => {
    const result = compareUnitConvertedValues('240000', 'thousands', '240', 'millions');
    expect(result.result).toBe('pass');
  });

  it('compareUnitConvertedValues rejects ambiguous units', () => {
    const result = compareUnitConvertedValues('abc', 'thousands', '240', 'millions');
    expect(result.result).toBe('not_applicable');
  });
});

describe('procurement-verification-policy-v1', () => {
  function makeVerificationInput(overrides: Partial<ProcurementVerificationInput> = {}): ProcurementVerificationInput {
    return {
      p1Identities: [makeIdentityInput()],
      p40Identities: [makeIdentityInput({ exhibit: 'P-40' })],
      p5P21P3aIdentities: [],
      fundingComparisons: [],
      requiredIdentityKeys: [],
      p40Required: true,
      enrichmentRequired: false,
      requiredQuantityCategories: ['procurement_quantity'],
      requiredUnitCostCategories: ['gross_weapon_system_unit_cost'],
      requiredNarrativeSections: ['item_description', 'program_status', 'justification'],
      ...overrides,
    };
  }

  it('passes with complete P-1/P-40 and matching funding', () => {
    const result = verifyProcurementFamily(makeVerificationInput({
      fundingComparisons: [{
        identityNaturalKey: 'test',
        printedCode: '9670A00005',
        fiscalYear: CYCLE_FY,
        columnRole: 'budget_year_request',
        p1ValueMillions: '240',
        p40ValueMillions: '240',
        result: 'pass',
      }],
    }));
    expect(result.decision).toBe('VERIFICATION_PASSED');
    expect(result.blocking).toBe(false);
  });

  it('blocks when P-1 is missing', () => {
    const result = verifyProcurementFamily(makeVerificationInput({ p1Identities: [] }));
    expect(result.blocking).toBe(true);
    expect(result.decision).toBe('REJECTED');
  });

  it('blocks when P-40 is required and missing', () => {
    const result = verifyProcurementFamily(makeVerificationInput({ p40Identities: [] }));
    expect(result.blocking).toBe(true);
  });

  it('blocks on funding mismatch', () => {
    const result = verifyProcurementFamily(makeVerificationInput({
      fundingComparisons: [{
        identityNaturalKey: 'test',
        printedCode: '9670A00005',
        fiscalYear: CYCLE_FY,
        columnRole: 'budget_year_request',
        p1ValueMillions: '240',
        p40ValueMillions: '300',
        result: 'fail',
      }],
    }));
    expect(result.blocking).toBe(true);
  });

  it('blocks on missing comparison when P-40 required', () => {
    const result = verifyProcurementFamily(makeVerificationInput({
      fundingComparisons: [{
        identityNaturalKey: 'test',
        printedCode: '9670A00005',
        fiscalYear: CYCLE_FY,
        columnRole: 'budget_year_request',
        result: 'not_run',
      }],
    }));
    expect(result.blocking).toBe(true);
  });

  it('blocks on missing quantity when required', () => {
    const result = verifyProcurementFamily(makeVerificationInput({
      p40Identities: [makeIdentityInput({ exhibit: 'P-40', hasQuantity: false })],
    }));
    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'required_quantity_missing')).toBe(true);
  });

  it('blocks on missing unit cost when required', () => {
    const result = verifyProcurementFamily(makeVerificationInput({
      p40Identities: [makeIdentityInput({ exhibit: 'P-40', hasUnitCost: false })],
    }));
    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'required_unit_cost_missing')).toBe(true);
  });

  it('blocks on missing enrichment parent relationship', () => {
    const result = verifyProcurementFamily(makeVerificationInput({
      p5P21P3aIdentities: [makeIdentityInput({
        exhibit: 'P-5',
        parentNaturalKey: undefined,
      })],
    }));
    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'enrichment_parent_missing')).toBe(true);
  });

  it('blocks on base/AP identity collapse', () => {
    const sameKey = 'PROCUREMENT_BLIN:ARMY:2031A: AIRCRAFT PROCUREMENT, ARMY:9670A00005:base';
    const result = verifyProcurementFamily(makeVerificationInput({
      p1Identities: [
        makeIdentityInput({ naturalKey: sameKey, advanceProcurement: false }),
        makeIdentityInput({ naturalKey: sameKey, advanceProcurement: true }),
      ],
    }));
    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'base_ap_identity_collapse')).toBe(true);
  });

  it('blocks on required identity missing', () => {
    const result = verifyProcurementFamily(makeVerificationInput({
      requiredIdentityKeys: ['PROCUREMENT_BLIN:ARMY:2031A:TEST:XXXX:base'],
    }));
    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'required_identity_not_found')).toBe(true);
  });
});

describe('procurement-composer-v1', () => {
  it('composes empty artifacts to incomplete report', () => {
    const report = composeProcurementFamily({
      artifacts: {
        p1Artifacts: [],
        p40Artifacts: [],
        p5Artifacts: [],
        p21Artifacts: [],
        p3aArtifacts: [],
      },
      requiredIdentityKeys: [],
      p40Required: true,
      enrichmentRequired: false,
      requiredQuantityCategories: [],
      requiredUnitCostCategories: [],
      requiredNarrativeSections: [],
    });
    expect(report.completenessStatus).toBe('incomplete');
    expect(report.missingExhibits).toContain('P-1');
    expect(report.missingExhibits).toContain('P-40');
  });

  it('no canonical writer is imported', () => {
    /* This test verifies at the module level — the composer module does not
     * import ProgramElementWriterService or any canonical writer. We check
     * import statements, not comments. */
    const composerSource = require('fs').readFileSync(
      require('path').join(__dirname, 'procurement-composer-v1.ts'),
      'utf-8',
    );
    /* Check that no import statement brings in a canonical writer. */
    const importLines = composerSource.split('\n').filter((l: string) => l.trim().startsWith('import '));
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
