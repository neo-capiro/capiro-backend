import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RDTE_COLUMN_ROLE_V1_VALUES,
  RDTE_COVERAGE_STATUS_V1_VALUES,
  RDTE_EXHIBIT_ROLE_V1_VALUES,
  RDTE_ROLE_ALLOWED_DISPOSITIONS,
  RDTE_VALUE_DISPOSITION_V1_VALUES,
  isAnnualFundingRole,
  isContextualRole,
  isDispositionAllowedForRole,
  isNonAnnualCostRole,
  rdteColumnRoleV1Schema,
  rdteCoverageStatusV1Schema,
  rdteExhibitRoleV1Schema,
  rdteValueDispositionV1Schema,
} from './rdte-column-role-v1.js';
import {
  RDTE_CYCLE_BUNDLE_SCHEMA_VERSION,
  computeRdteCycleBundleContentSha256,
  rdteCycleBundleId,
  rdteCycleBundleV1Schema,
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

const SOURCE_SHA = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);
const ARTIFACT_CONTENT_SHA = 'c'.repeat(64);
const ARTIFACT_BYTE_SHA = 'd'.repeat(64);
const POLICY_SHA = 'e'.repeat(64);
const PROJECTION_SHA = 'f'.repeat(64);

function makeBundle(overrides: Partial<Record<string, unknown>> = {}) {
  const candidateId = 'candidate-r1';
  const runId = 'verification-run-r1';
  return {
    schemaVersion: RDTE_CYCLE_BUNDLE_SCHEMA_VERSION,
    cycleId: 'pb_fy2027_rdte',
    fiscalYear: 2027,
    manifestContentSha256: MANIFEST_SHA,
    sourceDocuments: [
      {
        manifestDocumentKey: 'r1_army',
        sourceDocumentId: 'source-r1-army',
        exhibitRole: 'r1_catalog',
        required: true,
        sourcePdfSha256: SOURCE_SHA,
        sourceLocator: '/sources/r1-army.pdf',
        pageCount: 1,
        parserRunIds: ['parser-r1-army'],
        unresolvedPages: [],
      },
    ],
    artifacts: [
      {
        manifestDocumentKey: 'r1_army',
        artifactId: 'artifact-r1-army',
        artifactContentSha256: ARTIFACT_CONTENT_SHA,
        artifactByteSha256: ARTIFACT_BYTE_SHA,
      },
    ],
    verifications: [
      {
        manifestDocumentKey: 'r1_army',
        manifestContentSha256: MANIFEST_SHA,
        artifactId: 'artifact-r1-army',
        artifactContentSha256: ARTIFACT_CONTENT_SHA,
        artifactByteSha256: ARTIFACT_BYTE_SHA,
        candidateId,
        verificationRunId: runId,
        policySha256: POLICY_SHA,
        sourceDocumentId: 'source-r1-army',
        sourcePdfSha256: SOURCE_SHA,
        phase2Decision: 'PASS',
        status: 'VERIFICATION_PASSED',
        acceptedAssertionIds: ['assertion-r1'],
        rejectedAssertionIds: [],
        verificationCandidateId: candidateId,
        decision: 'VERIFICATION_PASSED',
        decisionId: runId,
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
    projectionPlanContentSha256: PROJECTION_SHA,
    certification: 'CERTIFIED_RDTE_READY_FOR_PROJECTION',
    blockingFindings: [],
    nonBlockingFindings: [],
    ...overrides,
  };
}

describe('RDT&E controlled vocabulary', () => {
  it('accepts every registered role, disposition, status, and exhibit value', () => {
    RDTE_COLUMN_ROLE_V1_VALUES.forEach((value) =>
      expect(rdteColumnRoleV1Schema.parse(value)).toBe(value),
    );
    RDTE_VALUE_DISPOSITION_V1_VALUES.forEach((value) =>
      expect(rdteValueDispositionV1Schema.parse(value)).toBe(value),
    );
    RDTE_COVERAGE_STATUS_V1_VALUES.forEach((value) =>
      expect(rdteCoverageStatusV1Schema.parse(value)).toBe(value),
    );
    RDTE_EXHIBIT_ROLE_V1_VALUES.forEach((value) =>
      expect(rdteExhibitRoleV1Schema.parse(value)).toBe(value),
    );
  });

  it('pins the lawful funding disposition doctrine', () => {
    expect(isDispositionAllowedForRole('budget_year_request', 'canonical_request_candidate')).toBe(
      true,
    );
    expect(isDispositionAllowedForRole('outyear_projection', 'canonical_request_candidate')).toBe(
      false,
    );
    expect(isDispositionAllowedForRole('outyear_projection', 'pe_budget_position')).toBe(true);
    expect(isContextualRole('prior_actual_context')).toBe(true);
    expect(isNonAnnualCostRole('cost_to_complete')).toBe(true);
    expect(isAnnualFundingRole('budget_year_request')).toBe(true);
    expect(isAnnualFundingRole('prior_actual_context')).toBe(false);
  });

  it('has an allowed-disposition mapping for every column role', () => {
    RDTE_COLUMN_ROLE_V1_VALUES.forEach((role) =>
      expect(RDTE_ROLE_ALLOWED_DISPOSITIONS[role]).toBeDefined(),
    );
  });
});

describe('final RDT&E cycle bundle contract', () => {
  it('parses an exact source/artifact/verifier/projection binding', () => {
    const withoutHash = makeBundle();
    const parsed = rdteCycleBundleV1Schema.parse({
      ...withoutHash,
      contentSha256: computeRdteCycleBundleContentSha256(withoutHash as never),
    });
    expect(parsed.verifications[0]?.phase2Decision).toBe('PASS');
    expect(parsed.artifacts[0]?.artifactByteSha256).toBe(ARTIFACT_BYTE_SHA);
    expect(parsed.projectionPlanContentSha256).toBe(PROJECTION_SHA);
  });

  it('rejects an incomplete verification tuple and unknown keys', () => {
    const base = makeBundle();
    const verification = { ...(base.verifications as Array<Record<string, unknown>>)[0] };
    delete verification.policySha256;
    expect(() =>
      rdteCycleBundleV1Schema.parse({
        ...base,
        verifications: [verification],
        contentSha256: SOURCE_SHA,
      }),
    ).toThrow();
    expect(() =>
      rdteCycleBundleV1Schema.parse({
        ...base,
        contentSha256: SOURCE_SHA,
        unexpected: true,
      }),
    ).toThrow();
  });

  it('produces deterministic IDs and content hashes under key permutation', () => {
    expect(
      rdteCycleBundleId({ cycleId: 'pb_fy2027', fiscalYear: 2027 }),
    ).toBe(rdteCycleBundleId({ fiscalYear: 2027, cycleId: 'pb_fy2027' }));
    const first = makeBundle();
    const reordered = Object.fromEntries(Object.entries(makeBundle()).reverse());
    expect(computeRdteCycleBundleContentSha256(first as never)).toBe(
      computeRdteCycleBundleContentSha256(reordered as never),
    );
  });
});

describe('coverage and document presence', () => {
  it('distinguishes complete, partial, missing, and not-applicable coverage', () => {
    expect(
      computeCoverageEntry({
        category: 'identity',
        expectedKeys: ['one'],
        coveredKeys: ['one'],
        applicable: true,
      }).status,
    ).toBe('verified');
    expect(
      computeCoverageEntry({
        category: 'funding',
        expectedKeys: ['one', 'two'],
        coveredKeys: ['one'],
        applicable: true,
      }),
    ).toMatchObject({ status: 'needs_review', numerator: 1, denominator: 2 });
    expect(
      computeCoverageEntry({
        category: 'performers',
        expectedKeys: ['one'],
        coveredKeys: [],
        applicable: true,
      }).status,
    ).toBe('missing');
    expect(
      computeCoverageEntry({
        category: 'milestones',
        expectedKeys: [],
        coveredKeys: [],
        applicable: false,
      }).status,
    ).toBe('not_applicable');
  });

  it('marks only PASS/VERIFICATION_PASSED and REVIEW/REVIEW_ACCEPTED as verified', () => {
    const bundle = makeBundle();
    const sourceDocuments = bundle.sourceDocuments as never;
    const passed = computeDocumentPresence({
      sourceDocuments,
      verifications: bundle.verifications as never,
    });
    expect(passed[0]?.verified).toBe(true);

    const pending = computeDocumentPresence({
      sourceDocuments,
      verifications: [
        {
          ...(bundle.verifications as Array<Record<string, unknown>>)[0],
          phase2Decision: 'REVIEW',
          status: 'NEEDS_REVIEW',
          decision: 'NEEDS_REVIEW',
        },
      ] as never,
    });
    expect(pending[0]?.verified).toBe(false);
  });

  it('validates the strict summary report', () => {
    expect(
      rdteCycleSummaryV1Schema.parse({
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
            decision: 'PASS/VERIFICATION_PASSED',
          },
        ],
      }),
    ).toBeDefined();
  });
});

describe('source-unit rounding policy', () => {
  it('uses exact decimal arithmetic', () => {
    expect(exactAbsDifference('1.005', '1.004')).toBe('0.001');
    expect(compareCanonicalDecimal('0.5', '0.50')).toBe(0);
    expect(withinExactTolerance('1.005', '1.004', '0.001')).toBe(true);
    expect(withinExactTolerance('1.006', '1.004', '0.001')).toBe(false);
  });

  it('pins one printed unit for independent values', () => {
    expect(independentPrintedValueToleranceMillions('thousands')).toBe('0.001');
    expect(independentPrintedValueToleranceMillions('millions')).toBe('1');
    expect(independentPrintedValueToleranceMillions('dollars')).toBe('0.000001');
  });

  it('pins total-vs-child tolerance to (N+1) × 0.5 printed units', () => {
    expect(totalVsChildrenToleranceMillions(0, 'thousands')).toBe('0.0005');
    expect(totalVsChildrenToleranceMillions(1, 'thousands')).toBe('0.001');
    expect(totalVsChildrenToleranceMillions(2, 'thousands')).toBe('0.0015');
    expect(totalVsChildrenToleranceMillions(10, 'thousands')).toBe('0.0055');
    expect(totalVsChildrenToleranceMillions(3, 'millions')).toBe('2');
    expect(() => totalVsChildrenToleranceMillions(-1, 'millions')).toThrow();
  });
});

describe('baseline report and pure-module boundary', () => {
  function minimalArtifact(
    exhibit: DefenseBudgetExtractionArtifactV1['source']['exhibit'],
    assertions: Array<Record<string, unknown>>,
  ): DefenseBudgetExtractionArtifactV1 {
    return {
      schemaVersion: 'defense_budget_extraction_v1',
      artifactId: 'artifact-baseline',
      contentSha256: ARTIFACT_CONTENT_SHA,
      source: {
        manifestDocumentKey: `${exhibit.toLowerCase()}_doc`,
        sourcePdfSha256: ARTIFACT_CONTENT_SHA,
        sourceLocator: `/sources/${exhibit}.pdf`,
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

  it('reports absent R-4 and missing semantic detail', () => {
    const report = computeRdteBaselineReport({
      cycleId: 'pb_fy2027_rdte',
      fiscalYear: 2027,
      artifacts: [
        minimalArtifact('R-1', [
          {
            assertionKind: 'program_element_identity',
            assertionId: 'identity-1',
            sourceFactIds: [],
            evidenceIds: [],
            confidence: 1,
            identity: { lineKind: 'RDTE_PE', peCode: '0601101A' },
            title: 'PE 1',
            component: 'ARMY',
          },
        ]),
      ],
    });
    expect(report.gaps.some((gap) => gap.gapCode === 'r1_rows_without_fy_columns')).toBe(true);
    expect(report.gaps.some((gap) => gap.gapCode === 'absent_r4_data')).toBe(true);
    expect(rdteBaselineReportV1Schema.parse(report).schemaVersion).toBe(
      RDTE_BASELINE_REPORT_SCHEMA_VERSION,
    );
  });

  it('keeps pure RDT&E modules free of Prisma, NestJS, AWS, and canonical writers', () => {
    const files = fs
      .readdirSync(__dirname)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(content).not.toMatch(/ProgramElementWriterService/);
      expect(content).not.toMatch(/@prisma\/client|@nestjs|@aws-sdk|aws-sdk/);
    }
  });
});
