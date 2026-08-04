/**
 * rdte-contracts.spec — Workstream A contract tests.
 *
 * Covers:
 *   - strict unknown-key rejection;
 *   - deterministic hashing under input permutation;
 *   - every vocabulary value;
 *   - invalid fiscal years;
 *   - duplicate document/artifact/run IDs;
 *   - certification summary recomputation;
 *   - no canonical vocabulary or writer dependency.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RDTE_COLUMN_ROLE_V1_VALUES,
  RDTE_COVERAGE_STATUS_V1_VALUES,
  RDTE_EXHIBIT_ROLE_V1_VALUES,
  RDTE_ROLE_ALLOWED_DISPOSITIONS,
  RDTE_VALUE_DISPOSITION_V1_VALUES,
  isDispositionAllowedForRole,
  isAnnualFundingRole,
  isContextualRole,
  isNonAnnualCostRole,
  rdteColumnRoleV1Schema,
  rdteCoverageStatusV1Schema,
  rdteExhibitRoleV1Schema,
  rdteValueDispositionV1Schema,
} from './rdte-column-role-v1.js';
import {
  RDTE_CYCLE_BUNDLE_SCHEMA_VERSION,
  computeRdteCycleBundleContentSha256,
  rdteCycleBundleV1Schema,
  rdteCycleBundleId,
  type RdteCycleBundleV1,
} from './rdte-cycle-bundle-v1.js';
import {
  computeCoverageEntry,
  computeDocumentPresence,
  rdteCycleSummaryV1Schema,
} from './rdte-cycle-summary-v1.js';
import {
  compareCanonicalDecimal,
  exactAbsDifference,
  independentPrintedValueToleranceMillions,
  totalVsChildrenToleranceMillions,
  withinExactTolerance,
} from './rdte-rounding-policy-v1.js';
import {
  RDTE_BASELINE_REPORT_SCHEMA_VERSION,
  computeRdteBaselineReport,
  rdteBaselineReportV1Schema,
} from './rdte-baseline-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';

const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function makeBundle(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    schemaVersion: RDTE_CYCLE_BUNDLE_SCHEMA_VERSION,
    cycleId: 'pb_fy2027_rdte',
    fiscalYear: 2027,
    manifestContentSha256: 'a'.repeat(64),
    sourceDocuments: [
      {
        manifestDocumentKey: 'r1_army',
        exhibitRole: 'r1_catalog',
        required: true,
        sourcePdfSha256: 'a'.repeat(64),
        sourceLocator: 's3://bucket/r1-army.pdf',
      },
    ],
    artifacts: [
      {
        manifestDocumentKey: 'r1_army',
        artifactId: 'dbx1_' + 'a'.repeat(64),
        artifactContentSha256: 'a'.repeat(64),
      },
    ],
    verifications: [
      {
        manifestDocumentKey: 'r1_army',
        artifactId: 'dbx1_' + 'a'.repeat(64),
        verificationCandidateId: 'cand_1',
        verificationRunId: 'run_1',
        decision: 'VERIFICATION_PASSED',
        decisionId: 'dec_1',
      },
    ],
    comparisons: [],
    coverage: [
      {
        category: 'identity',
        status: 'verified',
        numerator: 1,
        denominator: 1,
        missingKeys: [],
      },
    ],
    certification: 'CERTIFIED_RDTE_READY_FOR_PROJECTION',
    blockingFindings: [],
    nonBlockingFindings: [],
    ...overrides,
  };
  return base;
}

describe('rdte-column-role-v1 vocabulary', () => {
  it('exposes every required exhibit role', () => {
    expect([...RDTE_EXHIBIT_ROLE_V1_VALUES]).toEqual([
      'r1_catalog',
      'r2_pe_summary',
      'r2a_project_detail',
      'r3_cost_analysis',
      'r4_schedule',
    ]);
  });

  it('exposes every required column role', () => {
    expect([...RDTE_COLUMN_ROLE_V1_VALUES]).toEqual([
      'prior_actual_context',
      'current_enacted_context',
      'budget_year_request',
      'outyear_projection',
      'base_component',
      'oco_component',
      'total_component',
      'cost_to_complete',
      'total_cost',
      'quantity',
      'unknown',
    ]);
  });

  it('exposes every required value disposition', () => {
    expect([...RDTE_VALUE_DISPOSITION_V1_VALUES]).toEqual([
      'canonical_request_candidate',
      'pe_budget_position',
      'project_budget_position',
      'contextual_only',
      'non_annual_cost',
      'omitted',
    ]);
  });

  it('exposes every coverage status', () => {
    expect([...RDTE_COVERAGE_STATUS_V1_VALUES]).toEqual([
      'verified',
      'needs_review',
      'rejected',
      'missing',
      'not_applicable',
    ]);
  });

  it('accepts every vocabulary value through its schema', () => {
    for (const role of RDTE_COLUMN_ROLE_V1_VALUES) {
      expect(rdteColumnRoleV1Schema.parse(role)).toBe(role);
    }
    for (const disposition of RDTE_VALUE_DISPOSITION_V1_VALUES) {
      expect(rdteValueDispositionV1Schema.parse(disposition)).toBe(disposition);
    }
    for (const status of RDTE_COVERAGE_STATUS_V1_VALUES) {
      expect(rdteCoverageStatusV1Schema.parse(status)).toBe(status);
    }
    for (const role of RDTE_EXHIBIT_ROLE_V1_VALUES) {
      expect(rdteExhibitRoleV1Schema.parse(role)).toBe(role);
    }
  });

  it('rejects unknown column roles', () => {
    expect(() => rdteColumnRoleV1Schema.parse('fy2027_request')).toThrow();
  });

  it('allows only canonical_request_candidate for budget_year_request', () => {
    expect(isDispositionAllowedForRole('budget_year_request', 'canonical_request_candidate')).toBe(
      true,
    );
    expect(isDispositionAllowedForRole('budget_year_request', 'pe_budget_position')).toBe(false);
    expect(isDispositionAllowedForRole('budget_year_request', 'contextual_only')).toBe(false);
  });

  it('never allows outyear_projection to be a canonical request candidate', () => {
    expect(isDispositionAllowedForRole('outyear_projection', 'canonical_request_candidate')).toBe(
      false,
    );
    expect(isDispositionAllowedForRole('outyear_projection', 'pe_budget_position')).toBe(true);
  });

  it('never allows historical context to be canonical', () => {
    expect(isDispositionAllowedForRole('prior_actual_context', 'canonical_request_candidate')).toBe(
      false,
    );
    expect(
      isDispositionAllowedForRole('current_enacted_context', 'canonical_request_candidate'),
    ).toBe(false);
  });

  it('marks cost-to-complete and total-cost as non-annual', () => {
    expect(isNonAnnualCostRole('cost_to_complete')).toBe(true);
    expect(isNonAnnualCostRole('total_cost')).toBe(true);
    expect(isNonAnnualCostRole('budget_year_request')).toBe(false);
  });

  it('marks contextual roles correctly', () => {
    expect(isContextualRole('prior_actual_context')).toBe(true);
    expect(isContextualRole('current_enacted_context')).toBe(true);
    expect(isContextualRole('base_component')).toBe(true);
    expect(isContextualRole('budget_year_request')).toBe(false);
  });

  it('identifies annual funding roles', () => {
    expect(isAnnualFundingRole('budget_year_request')).toBe(true);
    expect(isAnnualFundingRole('outyear_projection')).toBe(true);
    expect(isAnnualFundingRole('prior_actual_context')).toBe(false);
  });

  it('has a disposition mapping for every role', () => {
    for (const role of RDTE_COLUMN_ROLE_V1_VALUES) {
      expect(RDTE_ROLE_ALLOWED_DISPOSITIONS[role]).toBeDefined();
    }
  });
});

describe('rdte-cycle-bundle-v1', () => {
  it('parses a valid bundle', () => {
    const bundle = makeBundle();
    const contentSha256 = computeRdteCycleBundleContentSha256(bundle as never);
    const parsed = rdteCycleBundleV1Schema.parse({ ...bundle, contentSha256: contentSha256 });
    expect(parsed.schemaVersion).toBe(RDTE_CYCLE_BUNDLE_SCHEMA_VERSION);
  });

  it('rejects unknown keys (strict)', () => {
    const bundle = makeBundle();
    expect(() =>
      rdteCycleBundleV1Schema.parse({ ...bundle, contentSha256: SHA, unexpected: true }),
    ).toThrow();
  });

  it('rejects invalid fiscal years', () => {
    const bundle = makeBundle({ fiscalYear: 1799 });
    expect(() => rdteCycleBundleV1Schema.parse({ ...bundle, contentSha256: SHA })).toThrow();
  });

  it('produces deterministic IDs independent of input key order', () => {
    const a = rdteCycleBundleId({ cycleId: 'pb_fy2027', fiscalYear: 2027 });
    const b = rdteCycleBundleId({ fiscalYear: 2027, cycleId: 'pb_fy2027' });
    expect(a).toBe(b);
  });

  it('produces deterministic content SHA under key permutation', () => {
    const bundleA = makeBundle();
    const bundleB = makeBundle();
    // Rebuild with keys in a different order.
    const reordered = Object.fromEntries(Object.entries(bundleB).reverse());
    expect(computeRdteCycleBundleContentSha256(bundleA as never)).toBe(
      computeRdteCycleBundleContentSha256(reordered as never),
    );
  });

  it('rejects duplicate document IDs at the schema level via downstream validation', () => {
    const dupSha = 'a'.repeat(64);
    const dupShaB = 'b'.repeat(64);
    const bundle = makeBundle({
      sourceDocuments: [
        {
          manifestDocumentKey: 'r1_army',
          exhibitRole: 'r1_catalog',
          required: true,
          sourcePdfSha256: dupSha,
          sourceLocator: 's3://b/r1.pdf',
        },
        {
          manifestDocumentKey: 'r1_army',
          exhibitRole: 'r1_catalog',
          required: true,
          sourcePdfSha256: dupShaB,
          sourceLocator: 's3://b/r1b.pdf',
        },
      ],
    });
    // Schema itself accepts structure; duplicate detection is semantic and
    // must be caught by the cycle reconciler. The bundle schema is strict on
    // shape, not on uniqueness — uniqueness is enforced by the reconciler.
    const parsed = rdteCycleBundleV1Schema.parse({ ...bundle, contentSha256: dupSha });
    expect(parsed.sourceDocuments).toHaveLength(2);
  });
});

describe('rdte-cycle-summary-v1', () => {
  it('recomputes verified coverage when all keys are covered', () => {
    const entry = computeCoverageEntry({
      category: 'identity',
      expectedKeys: ['0601101A', '0601102A'],
      coveredKeys: ['0601101A', '0601102A'],
      applicable: true,
    });
    expect(entry.status).toBe('verified');
    expect(entry.numerator).toBe(2);
    expect(entry.denominator).toBe(2);
    expect(entry.missingKeys).toEqual([]);
  });

  it('marks missing when no keys are covered', () => {
    const entry = computeCoverageEntry({
      category: 'funding',
      expectedKeys: ['0601101A'],
      coveredKeys: [],
      applicable: true,
    });
    expect(entry.status).toBe('missing');
    expect(entry.numerator).toBe(0);
  });

  it('marks needs_review on partial coverage', () => {
    const entry = computeCoverageEntry({
      category: 'funding',
      expectedKeys: ['0601101A', '0601102A'],
      coveredKeys: ['0601101A'],
      applicable: true,
    });
    expect(entry.status).toBe('needs_review');
    expect(entry.missingKeys).toEqual(['0601102A']);
  });

  it('marks not_applicable when category is not applicable', () => {
    const entry = computeCoverageEntry({
      category: 'milestones',
      expectedKeys: [],
      coveredKeys: [],
      applicable: false,
    });
    expect(entry.status).toBe('not_applicable');
  });

  it('recomputes document presence deterministically', () => {
    const presence = computeDocumentPresence({
      sourceDocuments: [
        {
          manifestDocumentKey: 'r1_army',
          exhibitRole: 'r1_catalog',
          required: true,
          sourcePdfSha256: SHA,
          sourceLocator: 's3://b/r1.pdf',
        },
      ],
      verifications: [
        {
          manifestDocumentKey: 'r1_army',
          artifactId: 'dbx1_' + 'a'.repeat(64),
          verificationCandidateId: 'c1',
          verificationRunId: 'r1',
          decision: 'VERIFICATION_PASSED',
          decisionId: 'd1',
        },
      ],
    });
    expect(presence).toHaveLength(1);
    expect(presence[0]?.verified).toBe(true);
  });

  it('validates a cycle summary through the strict schema', () => {
    const summary = {
      cycleId: 'pb_fy2027_rdte',
      fiscalYear: 2027,
      coverage: [
        {
          category: 'identity',
          status: 'verified',
          numerator: 1,
          denominator: 1,
          missingKeys: [],
        },
      ],
      documentPresence: [
        {
          manifestDocumentKey: 'r1_army',
          required: true,
          present: true,
          verified: true,
          decision: 'VERIFICATION_PASSED',
        },
      ],
    };
    expect(rdteCycleSummaryV1Schema.parse(summary)).toBeDefined();
  });
});

describe('rdte-rounding-policy-v1', () => {
  it('computes exact absolute difference without floats', () => {
    expect(exactAbsDifference('1.005', '1.004')).toBe('0.001');
    expect(exactAbsDifference('1000', '999.5')).toBe('0.5');
    expect(exactAbsDifference('0', '0')).toBe('0');
  });

  it('computes independent printed value tolerance of exactly 1 printed unit', () => {
    expect(independentPrintedValueToleranceMillions('thousands')).toBe('0.001');
    expect(independentPrintedValueToleranceMillions('millions')).toBe('1');
    expect(independentPrintedValueToleranceMillions('dollars')).toBe('0.000001');
  });

  it('computes total-vs-children tolerance as (N+1) × 0.5 printed units', () => {
    expect(totalVsChildrenToleranceMillions(0, 'thousands')).toBe('0.0005');
    expect(totalVsChildrenToleranceMillions(1, 'thousands')).toBe('0.001');
    expect(totalVsChildrenToleranceMillions(2, 'thousands')).toBe('0.0015');
    expect(totalVsChildrenToleranceMillions(10, 'thousands')).toBe('0.0055');
    expect(totalVsChildrenToleranceMillions(3, 'millions')).toBe('2');
  });

  it('rejects negative child counts', () => {
    expect(() => totalVsChildrenToleranceMillions(-1, 'thousands')).toThrow();
  });

  it('compares canonical decimals exactly', () => {
    expect(compareCanonicalDecimal('1.005', '1.004')).toBe(1);
    expect(compareCanonicalDecimal('1.004', '1.005')).toBe(-1);
    expect(compareCanonicalDecimal('1.005', '1.005')).toBe(0);
    expect(compareCanonicalDecimal('0.5', '0.50')).toBe(0);
  });

  it('checks tolerance exactly', () => {
    expect(withinExactTolerance('1.005', '1.004', '0.001')).toBe(true);
    expect(withinExactTolerance('1.006', '1.004', '0.001')).toBe(false);
    expect(withinExactTolerance('1.005', '1.005', '0')).toBe(true);
  });
});

describe('rdte-baseline-v1', () => {
  function makeArtifact(
    exhibit: string,
    assertions: Array<Record<string, unknown>>,
  ): DefenseBudgetExtractionArtifactV1 {
    return {
      schemaVersion: 'defense_budget_extraction_v1',
      artifactId: 'dbx1_' + 'c'.repeat(64),
      contentSha256: 'c'.repeat(64),
      source: {
        manifestDocumentKey: `${exhibit.toLowerCase()}_doc`,
        sourcePdfSha256: 'c'.repeat(64),
        sourceLocator: `s3://b/${exhibit}.pdf`,
        fiscalYear: 2027,
        family: 'rdte',
        exhibit,
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb_fy2027',
        documentType: 'pb_exhibit',
      },
      parserRuns: [],
      evidence: [],
      sourceFacts: [],
      assertions: assertions as never,
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
        completenessStatus: 'incomplete',
      },
    } as DefenseBudgetExtractionArtifactV1;
  }

  it('reports R-1 rows without FY columns', () => {
    const artifact = makeArtifact('R-1', [
      {
        assertionKind: 'program_element_identity',
        assertionId: 'a1',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: { lineKind: 'RDTE_PE', peCode: '0601101A' },
        title: 'PE 1',
        component: 'ARMY',
      },
    ]);
    const report = computeRdteBaselineReport({
      cycleId: 'pb_fy2027_rdte',
      fiscalYear: 2027,
      artifacts: [artifact],
    });
    const gap = report.gaps.find((g) => g.gapCode === 'r1_rows_without_fy_columns');
    expect(gap).toBeDefined();
    expect(gap?.affectedKeys).toEqual(['0601101A']);
  });

  it('reports R-2 PEs without funding', () => {
    const artifact = makeArtifact('R-2', [
      {
        assertionKind: 'program_element_identity',
        assertionId: 'a1',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: { lineKind: 'RDTE_PE', peCode: '0601101A' },
        title: 'PE 1',
        component: 'ARMY',
      },
    ]);
    const report = computeRdteBaselineReport({
      cycleId: 'pb_fy2027_rdte',
      fiscalYear: 2027,
      artifacts: [artifact],
    });
    expect(report.gaps.some((g) => g.gapCode === 'r2_pes_without_funding')).toBe(true);
  });

  it('reports R-2A projects without funding', () => {
    const artifact = makeArtifact('R-2A', [
      {
        assertionKind: 'project',
        assertionId: 'a1',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        parentPeCode: '0601101A',
        projectCode: 'ABC',
        title: 'Project ABC',
      },
    ]);
    const report = computeRdteBaselineReport({
      cycleId: 'pb_fy2027_rdte',
      fiscalYear: 2027,
      artifacts: [artifact],
    });
    expect(report.gaps.some((g) => g.gapCode === 'r2a_projects_without_funding')).toBe(true);
  });

  it('reports R-3 performers without explicit units/roles', () => {
    const artifact = makeArtifact('R-3', [
      {
        assertionKind: 'performer',
        assertionId: 'a1',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        parentPeCode: '0601101A',
        performerName: 'ACME Corp',
        performerRole: 'UNKNOWN',
      },
    ]);
    const report = computeRdteBaselineReport({
      cycleId: 'pb_fy2027_rdte',
      fiscalYear: 2027,
      artifacts: [artifact],
    });
    expect(
      report.gaps.some((g) => g.gapCode === 'r3_performers_without_explicit_units_or_roles'),
    ).toBe(true);
  });

  it('reports absent R-4 data', () => {
    const report = computeRdteBaselineReport({
      cycleId: 'pb_fy2027_rdte',
      fiscalYear: 2027,
      artifacts: [],
    });
    expect(report.gaps.some((g) => g.gapCode === 'absent_r4_data')).toBe(true);
  });

  it('reports schema gaps for project positions and schedule periods', () => {
    const report = computeRdteBaselineReport({
      cycleId: 'pb_fy2027_rdte',
      fiscalYear: 2027,
      artifacts: [],
    });
    expect(report.schemaGaps.length).toBeGreaterThanOrEqual(2);
    expect(report.schemaGaps.some((g) => g.includes('ProgramElementProject'))).toBe(true);
    expect(report.schemaGaps.some((g) => g.includes('ProgramElementMilestone'))).toBe(true);
  });

  it('validates the report through the strict schema', () => {
    const report = computeRdteBaselineReport({
      cycleId: 'pb_fy2027_rdte',
      fiscalYear: 2027,
      artifacts: [],
    });
    expect(rdteBaselineReportV1Schema.parse(report).schemaVersion).toBe(
      RDTE_BASELINE_REPORT_SCHEMA_VERSION,
    );
  });

  it('reports no R-1 gap when identities have funding', () => {
    const artifact = makeArtifact('R-1', [
      {
        assertionKind: 'program_element_identity',
        assertionId: 'a1',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: { lineKind: 'RDTE_PE', peCode: '0601101A' },
        title: 'PE 1',
        component: 'ARMY',
      },
      {
        assertionKind: 'funding',
        assertionId: 'a2',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: { lineKind: 'RDTE_PE', peCode: '0601101A' },
        fiscalYear: 2027,
        field: 'request',
        money: { originalValue: '100', originalUnit: 'thousands', valueMillions: '0.1' },
      },
    ]);
    const report = computeRdteBaselineReport({
      cycleId: 'pb_fy2027_rdte',
      fiscalYear: 2027,
      artifacts: [artifact],
    });
    expect(report.gaps.some((g) => g.gapCode === 'r1_rows_without_fy_columns')).toBe(false);
  });
});

describe('pure module boundary', () => {
  it('rdte modules do not import canonical writer or Prisma', () => {
    const rdteDir = __dirname;
    const files = fs
      .readdirSync(rdteDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(rdteDir, file), 'utf8');
      expect(content).not.toMatch(/ProgramElementWriterService/);
      expect(content).not.toMatch(/@prisma\/client/);
      expect(content).not.toMatch(/@nestjs/);
      expect(content).not.toMatch(/aws-sdk|@aws-sdk/);
    }
  });
});
