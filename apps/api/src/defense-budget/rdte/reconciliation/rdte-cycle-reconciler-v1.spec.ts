/**
 * rdte-cycle-reconciler-v1.spec — Workstream L tests.
 *
 * Synthetic fixtures for:
 * - complete passing cycle;
 * - missing R-1;
 * - missing R-2 volume;
 * - R-2-only PE;
 * - reviewed new-PE exception;
 * - R-1/R-2 mismatch;
 * - project-sum mismatch;
 * - missing performer category when required;
 * - R-4 not applicable;
 * - rejected source artifact;
 * - duplicate natural key;
 * - input permutation.
 */
import { reconcileRdteCycle } from './rdte-cycle-reconciler-v1.js';
import { certifyRdteCycle } from './rdte-cycle-certifier-v1.js';
import type { R2aColumnReconciliation } from '../r2a/r2a-project-reconciler.js';
import type { CategoryCoverageInput } from '../rdte-cycle-summary-v1.js';
import type {
  RdteCycleSourceDocumentV1,
  RdteCycleVerificationRefV1,
} from '../rdte-cycle-bundle-v1.js';

const SHA = 'a'.repeat(64);
const PE1 = '0601234A';
const PE2 = '0601235A';

function coverageAllVerified(): CategoryCoverageInput[] {
  return [
    {
      category: 'identity',
      expectedKeys: [PE1, PE2],
      coveredKeys: [PE1, PE2],
      applicable: true,
    },
    {
      category: 'funding',
      expectedKeys: [PE1, PE2],
      coveredKeys: [PE1, PE2],
      applicable: true,
    },
    {
      category: 'narrative',
      expectedKeys: [PE1, PE2],
      coveredKeys: [PE1, PE2],
      applicable: true,
    },
    {
      category: 'projects',
      expectedKeys: [`${PE1}|A1`],
      coveredKeys: [`${PE1}|A1`],
      applicable: true,
    },
    {
      category: 'project_funding',
      expectedKeys: [`${PE1}|A1`],
      coveredKeys: [`${PE1}|A1`],
      applicable: true,
    },
    {
      category: 'performers',
      expectedKeys: [PE1],
      coveredKeys: [PE1],
      applicable: true,
    },
    {
      category: 'milestones',
      expectedKeys: [],
      coveredKeys: [],
      applicable: false,
    },
    {
      category: 'relationships',
      expectedKeys: [`${PE1}|A1`],
      coveredKeys: [`${PE1}|A1`],
      applicable: true,
    },
  ];
}

function makeReconciledColumn(
  overrides: Partial<R2aColumnReconciliation> = {},
): R2aColumnReconciliation {
  return {
    peCode: PE1,
    fiscalYear: 2027,
    columnRole: 'budget_year_request',
    status: 'reconciled',
    blocking: false,
    childSum: '12',
    printedTotal: '12',
    difference: '0',
    tolerance: '1.5',
    childCount: 2,
    includedProjectCodes: ['A1', 'B2'],
    missingProjectCodes: [],
    excludedRowKinds: [],
    message: 'exact',
    ...overrides,
  };
}

function makeSourceDocs(): RdteCycleSourceDocumentV1[] {
  return [
    {
      manifestDocumentKey: 'r1',
      exhibitRole: 'r1_catalog',
      required: true,
      sourcePdfSha256: SHA,
      sourceLocator: 's3://bucket/r1.pdf',
    },
    {
      manifestDocumentKey: 'r2',
      exhibitRole: 'r2_pe_summary',
      required: true,
      sourcePdfSha256: SHA,
      sourceLocator: 's3://bucket/r2.pdf',
    },
  ];
}

function makeVerifications(
  decision: 'VERIFICATION_PASSED' | 'NEEDS_REVIEW' | 'REJECTED' = 'VERIFICATION_PASSED',
): RdteCycleVerificationRefV1[] {
  return [
    {
      manifestDocumentKey: 'r1',
      artifactId: 'art_r1',
      verificationCandidateId: 'cand_r1',
      verificationRunId: 'run_r1',
      decision,
      decisionId: 'dec_r1',
    },
    {
      manifestDocumentKey: 'r2',
      artifactId: 'art_r2',
      verificationCandidateId: 'cand_r2',
      verificationRunId: 'run_r2',
      decision,
      decisionId: 'dec_r2',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Reconciler                                                          */
/* ------------------------------------------------------------------ */

describe('rdte-cycle-reconciler-v1', () => {
  it('reconciles a complete passing cycle', () => {
    const result = reconcileRdteCycle({
      identity: {
        r1PeCodes: [PE1, PE2],
        otherExhibitPeCodes: [PE1, PE2],
      },
      fundingComparisons: [
        { peCode: PE1, fiscalYear: 2027, columnRole: 'budget_year_request', result: 'pass' },
      ],
      projectSumReconciliations: [makeReconciledColumn()],
      projectRelationships: {
        projects: [{ peCode: PE1, projectCode: 'A1' }],
        projectFundingKeys: [{ peCode: PE1, projectCode: 'A1' }],
      },
      coverageInputs: coverageAllVerified(),
    });

    expect(result.blocking).toBe(false);
    expect(result.identity.complete).toBe(true);
    expect(result.funding.complete).toBe(true);
    expect(result.projectSums.complete).toBe(true);
    expect(result.relationships.complete).toBe(true);
  });

  it('flags R-2-only PE as orphan outside R-1', () => {
    const result = reconcileRdteCycle({
      identity: {
        r1PeCodes: [PE1],
        otherExhibitPeCodes: [PE1, PE2],
      },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [],
    });

    expect(result.identity.orphanPeCodes).toEqual([PE2]);
    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'orphan_pe_outside_r1')).toBe(true);
  });

  it('allows reviewed new-PE exception', () => {
    const result = reconcileRdteCycle({
      identity: {
        r1PeCodes: [PE1],
        otherExhibitPeCodes: [PE1, PE2],
        reviewedNewPeExceptions: [PE2],
      },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [],
    });

    expect(result.identity.orphanPeCodes).toEqual([]);
    expect(result.identity.reviewedExceptions).toEqual([PE2]);
    expect(result.findings.some((f) => f.code === 'reviewed_new_pe_exception')).toBe(true);
    expect(result.blocking).toBe(false);
  });

  it('blocks R-1/R-2 funding mismatch', () => {
    const result = reconcileRdteCycle({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [
        {
          peCode: PE1,
          fiscalYear: 2027,
          columnRole: 'budget_year_request',
          result: 'fail',
          message: 'values differ',
        },
      ],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [],
    });

    expect(result.funding.complete).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'r1_r2_funding_mismatch')).toBe(true);
  });

  it('blocks project-sum mismatch', () => {
    const result = reconcileRdteCycle({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [],
      projectSumReconciliations: [
        makeReconciledColumn({
          status: 'outside_tolerance',
          blocking: true,
          message: 'sum outside tolerance',
        }),
      ],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [],
    });

    expect(result.projectSums.complete).toBe(false);
    expect(result.blocking).toBe(true);
  });

  it('blocks missing performer category when required', () => {
    const result = reconcileRdteCycle({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [
        {
          category: 'performers',
          expectedKeys: [PE1],
          coveredKeys: [],
          applicable: true,
        },
      ],
    });

    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'category_coverage_missing')).toBe(true);
  });

  it('treats R-4 milestones as not_applicable when marked so', () => {
    const result = reconcileRdteCycle({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [
        {
          category: 'milestones',
          expectedKeys: [],
          coveredKeys: [],
          applicable: false,
        },
      ],
    });

    const milestones = result.coverage.find((c) => c.category === 'milestones');
    expect(milestones?.status).toBe('not_applicable');
    expect(result.blocking).toBe(false);
  });

  it('blocks duplicate natural keys', () => {
    const result = reconcileRdteCycle({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [],
      duplicateNaturalKeys: ['pe|proj|ACME|loc|method|cat|2027|src'],
    });

    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.code === 'duplicate_natural_key')).toBe(true);
  });

  it('is deterministic under input permutation', () => {
    const base = {
      identity: {
        r1PeCodes: [PE2, PE1],
        otherExhibitPeCodes: [PE1, PE2],
      },
      fundingComparisons: [
        {
          peCode: PE2,
          fiscalYear: 2027,
          columnRole: 'budget_year_request',
          result: 'pass' as const,
        },
        {
          peCode: PE1,
          fiscalYear: 2027,
          columnRole: 'budget_year_request',
          result: 'pass' as const,
        },
      ],
      projectSumReconciliations: [] as R2aColumnReconciliation[],
      projectRelationships: {
        projects: [
          { peCode: PE1, projectCode: 'B2' },
          { peCode: PE1, projectCode: 'A1' },
        ],
        projectFundingKeys: [
          { peCode: PE1, projectCode: 'A1' },
          { peCode: PE1, projectCode: 'B2' },
        ],
      },
      coverageInputs: coverageAllVerified(),
    };

    const r1 = reconcileRdteCycle(base);
    const r2 = reconcileRdteCycle({
      ...base,
      identity: {
        r1PeCodes: [PE1, PE2],
        otherExhibitPeCodes: [PE2, PE1],
      },
      fundingComparisons: [...base.fundingComparisons].reverse(),
      projectRelationships: {
        projects: [...base.projectRelationships.projects].reverse(),
        projectFundingKeys: [...base.projectRelationships.projectFundingKeys].reverse(),
      },
    });

    expect(r1.findings.map((f) => f.code)).toEqual(r2.findings.map((f) => f.code));
    expect(r1.coverage.map((c) => c.category)).toEqual(r2.coverage.map((c) => c.category));
    expect(r1.blocking).toBe(r2.blocking);
  });

  it('flags project funding without project assertion', () => {
    const result = reconcileRdteCycle({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: {
        projects: [],
        projectFundingKeys: [{ peCode: PE1, projectCode: 'A1' }],
      },
      coverageInputs: [],
    });

    expect(result.relationships.complete).toBe(false);
    expect(result.blocking).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Certifier                                                           */
/* ------------------------------------------------------------------ */

describe('rdte-cycle-certifier-v1', () => {
  it('certifies a complete passing cycle', () => {
    const reconciliation = reconcileRdteCycle({
      identity: {
        r1PeCodes: [PE1, PE2],
        otherExhibitPeCodes: [PE1, PE2],
      },
      fundingComparisons: [
        { peCode: PE1, fiscalYear: 2027, columnRole: 'budget_year_request', result: 'pass' },
      ],
      projectSumReconciliations: [makeReconciledColumn()],
      projectRelationships: {
        projects: [{ peCode: PE1, projectCode: 'A1' }],
        projectFundingKeys: [{ peCode: PE1, projectCode: 'A1' }],
      },
      coverageInputs: coverageAllVerified(),
    });

    const result = certifyRdteCycle({
      cycleIdIdentity: { fy: 2027, cycle: 'pb' },
      fiscalYear: 2027,
      manifestContentSha256: SHA,
      sourceDocuments: makeSourceDocs(),
      artifacts: [
        { manifestDocumentKey: 'r1', artifactId: 'art_r1', artifactContentSha256: SHA },
        { manifestDocumentKey: 'r2', artifactId: 'art_r2', artifactContentSha256: SHA },
      ],
      verifications: makeVerifications('VERIFICATION_PASSED'),
      comparisons: [],
      reconciliation,
      projectionPlanningSucceeded: true,
    });

    expect(result.certification).toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(result.bundle.contentSha256).toHaveLength(64);
    expect(result.bundle.blockingFindings).toHaveLength(0);
  });

  it('marks incomplete when required R-1 is missing verification', () => {
    const reconciliation = reconcileRdteCycle({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [],
    });

    const result = certifyRdteCycle({
      cycleIdIdentity: { fy: 2027 },
      fiscalYear: 2027,
      manifestContentSha256: SHA,
      sourceDocuments: makeSourceDocs(),
      artifacts: [],
      verifications: [
        {
          manifestDocumentKey: 'r2',
          artifactId: 'art_r2',
          verificationCandidateId: 'cand_r2',
          verificationRunId: 'run_r2',
          decision: 'VERIFICATION_PASSED',
          decisionId: 'dec_r2',
        },
      ],
      comparisons: [],
      reconciliation,
    });

    expect(result.certification).toBe('INCOMPLETE');
  });

  it('marks incomplete when required R-2 volume is missing verification', () => {
    const reconciliation = reconcileRdteCycle({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [],
    });

    const result = certifyRdteCycle({
      cycleIdIdentity: { fy: 2027 },
      fiscalYear: 2027,
      manifestContentSha256: SHA,
      sourceDocuments: makeSourceDocs(),
      artifacts: [],
      verifications: [
        {
          manifestDocumentKey: 'r1',
          artifactId: 'art_r1',
          verificationCandidateId: 'cand_r1',
          verificationRunId: 'run_r1',
          decision: 'VERIFICATION_PASSED',
          decisionId: 'dec_r1',
        },
      ],
      comparisons: [],
      reconciliation,
    });

    expect(result.certification).toBe('INCOMPLETE');
  });

  it('rejects when source artifact is REJECTED', () => {
    const reconciliation = reconcileRdteCycle({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [],
    });

    const result = certifyRdteCycle({
      cycleIdIdentity: { fy: 2027 },
      fiscalYear: 2027,
      manifestContentSha256: SHA,
      sourceDocuments: makeSourceDocs(),
      artifacts: [],
      verifications: makeVerifications('REJECTED'),
      comparisons: [],
      reconciliation,
    });

    expect(result.certification).toBe('REJECTED');
  });

  it('needs review for NEEDS_REVIEW without allowed acceptance', () => {
    const reconciliation = reconcileRdteCycle({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [],
    });

    const result = certifyRdteCycle({
      cycleIdIdentity: { fy: 2027 },
      fiscalYear: 2027,
      manifestContentSha256: SHA,
      sourceDocuments: makeSourceDocs(),
      artifacts: [],
      verifications: makeVerifications('NEEDS_REVIEW'),
      comparisons: [],
      reconciliation,
    });

    expect(['NEEDS_REVIEW', 'INCOMPLETE', 'REJECTED']).toContain(result.certification);
    expect(result.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
  });

  it('allows NEEDS_REVIEW with allowed reviewed acceptance', () => {
    const reconciliation = reconcileRdteCycle({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: coverageAllVerified().map((c) =>
        c.category === 'performers' || c.category === 'milestones'
          ? { ...c, applicable: false, expectedKeys: [], coveredKeys: [] }
          : c,
      ),
    });

    const result = certifyRdteCycle({
      cycleIdIdentity: { fy: 2027 },
      fiscalYear: 2027,
      manifestContentSha256: SHA,
      sourceDocuments: makeSourceDocs(),
      artifacts: [
        { manifestDocumentKey: 'r1', artifactId: 'art_r1', artifactContentSha256: SHA },
        { manifestDocumentKey: 'r2', artifactId: 'art_r2', artifactContentSha256: SHA },
      ],
      verifications: makeVerifications('NEEDS_REVIEW'),
      comparisons: [],
      reconciliation,
      allowedReviewedAcceptances: new Set(['dec_r1', 'dec_r2']),
      projectionPlanningSucceeded: true,
    });

    expect(result.certification).toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
  });

  it('is deterministic under input permutation', () => {
    const reconciliation = reconcileRdteCycle({
      identity: {
        r1PeCodes: [PE1, PE2],
        otherExhibitPeCodes: [PE1, PE2],
      },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: {
        projects: [{ peCode: PE1, projectCode: 'A1' }],
        projectFundingKeys: [{ peCode: PE1, projectCode: 'A1' }],
      },
      coverageInputs: coverageAllVerified(),
    });

    const base = {
      cycleIdIdentity: { fy: 2027, cycle: 'pb' },
      fiscalYear: 2027,
      manifestContentSha256: SHA,
      sourceDocuments: makeSourceDocs(),
      artifacts: [
        { manifestDocumentKey: 'r1', artifactId: 'art_r1', artifactContentSha256: SHA },
        { manifestDocumentKey: 'r2', artifactId: 'art_r2', artifactContentSha256: SHA },
      ],
      verifications: makeVerifications('VERIFICATION_PASSED'),
      comparisons: [],
      reconciliation,
      projectionPlanningSucceeded: true as const,
    };

    const r1 = certifyRdteCycle(base);
    const r2 = certifyRdteCycle({
      ...base,
      sourceDocuments: [...base.sourceDocuments].reverse(),
      artifacts: [...base.artifacts].reverse(),
      verifications: [...base.verifications].reverse(),
    });

    expect(r1.certification).toBe(r2.certification);
    expect(r1.bundle.contentSha256).toBe(r2.bundle.contentSha256);
    expect(r1.bundle.cycleId).toBe(r2.bundle.cycleId);
  });

  it('never certifies on coverage percentage alone', () => {
    /* High coverage but orphan PE → not certified. */
    const reconciliation = reconcileRdteCycle({
      identity: {
        r1PeCodes: [PE1],
        otherExhibitPeCodes: [PE1, PE2],
      },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: coverageAllVerified(),
    });

    const result = certifyRdteCycle({
      cycleIdIdentity: { fy: 2027 },
      fiscalYear: 2027,
      manifestContentSha256: SHA,
      sourceDocuments: makeSourceDocs(),
      artifacts: [],
      verifications: makeVerifications('VERIFICATION_PASSED'),
      comparisons: [],
      reconciliation,
    });

    expect(result.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(result.bundle.blockingFindings.length).toBeGreaterThan(0);
  });
});
