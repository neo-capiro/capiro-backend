import { describe, expect, it } from '@jest/globals';
import type { CategoryCoverageInput } from '../rdte-cycle-summary-v1.js';
import type {
  RdteCycleArtifactRefV1,
  RdteCycleSourceDocumentV1,
  RdteCycleVerificationRefV1,
} from '../rdte-cycle-bundle-v1.js';
import { certifyRdteCycle } from './rdte-cycle-certifier-v1.js';
import { reconcileRdteCycle } from './rdte-cycle-reconciler-v1.js';

const SHA = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);
const POLICY_SHA = 'c'.repeat(64);
const PROJECTION_SHA = 'd'.repeat(64);
const PE1 = '0601234A';
const PE2 = '0601235A';

function coverageAllVerified(): CategoryCoverageInput[] {
  return [
    ['identity', [PE1, PE2]],
    ['funding', [`${PE1}|2027|request`, `${PE2}|2027|request`]],
    ['narrative', [`${PE1}|mission`, `${PE2}|mission`]],
    ['projects', [`${PE1}|A1`]],
    ['project_funding', [`${PE1}|A1|2027|request`]],
    ['performers', [`${PE1}|LOCKHEED`]],
    ['relationships', [`${PE1}|A1|project_of`]],
  ].map(([category, keys]) => ({
    category: category as CategoryCoverageInput['category'],
    expectedKeys: keys as string[],
    coveredKeys: keys as string[],
    applicable: true,
  })).concat([
    {
      category: 'milestones',
      expectedKeys: [],
      coveredKeys: [],
      applicable: false,
    },
  ]);
}

function reconciliation(overrides: Parameters<typeof reconcileRdteCycle>[0] = {
  identity: { r1PeCodes: [PE1, PE2], otherExhibitPeCodes: [PE1, PE2] },
  fundingComparisons: [
    {
      peCode: PE1,
      fiscalYear: 2027,
      columnRole: 'budget_year_request',
      result: 'pass',
      evidenceIds: ['evidence-r1', 'evidence-r2'],
    },
  ],
  projectSumReconciliations: [],
  projectRelationships: {
    projects: [{ peCode: PE1, projectCode: 'A1' }],
    projectFundingKeys: [{ peCode: PE1, projectCode: 'A1' }],
    referencedProjectKeys: [{ peCode: PE1, projectCode: 'A1' }],
  },
  coverageInputs: coverageAllVerified(),
}) {
  return reconcileRdteCycle(overrides);
}

function sourceDocs(): RdteCycleSourceDocumentV1[] {
  return ['r1', 'r2'].map((key) => ({
    manifestDocumentKey: key,
    sourceDocumentId: `source-${key}`,
    exhibitRole: key === 'r1' ? 'r1_catalog' : 'r2_pe_summary',
    required: true,
    sourcePdfSha256: SHA,
    sourceLocator: `/sources/${key}.pdf`,
    pageCount: 2,
    parserRunIds: [`parser-${key}`],
    unresolvedPages: [],
  }));
}

function artifactRefs(): RdteCycleArtifactRefV1[] {
  return ['r1', 'r2'].map((key) => ({
    manifestDocumentKey: key,
    artifactId: `artifact-${key}`,
    artifactContentSha256: key === 'r1' ? '1'.repeat(64) : '2'.repeat(64),
    artifactByteSha256: key === 'r1' ? '3'.repeat(64) : '4'.repeat(64),
  }));
}

function verificationRefs(
  state: 'pass' | 'review' | 'accepted' | 'reject' = 'pass',
): RdteCycleVerificationRefV1[] {
  const artifacts = artifactRefs();
  return artifacts.map((artifact) => {
    const decision = state === 'reject' ? 'REJECT' : state === 'pass' ? 'PASS' : 'REVIEW';
    const status =
      state === 'reject'
        ? 'REJECTED'
        : state === 'pass'
          ? 'VERIFICATION_PASSED'
          : state === 'accepted'
            ? 'REVIEW_ACCEPTED'
            : 'NEEDS_REVIEW';
    const candidateId = `candidate-${artifact.manifestDocumentKey}`;
    const runId = `run-${artifact.manifestDocumentKey}`;
    return {
      manifestDocumentKey: artifact.manifestDocumentKey,
      manifestContentSha256: MANIFEST_SHA,
      artifactId: artifact.artifactId,
      artifactContentSha256: artifact.artifactContentSha256,
      artifactByteSha256: artifact.artifactByteSha256,
      candidateId,
      verificationRunId: runId,
      policySha256: POLICY_SHA,
      sourceDocumentId: `source-${artifact.manifestDocumentKey}`,
      sourcePdfSha256: SHA,
      phase2Decision: decision,
      status,
      acceptedAssertionIds: state === 'pass' || state === 'accepted' ? ['assertion-1'] : [],
      rejectedAssertionIds: state === 'reject' ? ['assertion-1'] : [],
      verificationCandidateId: candidateId,
      decision: status,
      decisionId: runId,
    };
  });
}

function certify(overrides: Partial<Parameters<typeof certifyRdteCycle>[0]> = {}) {
  return certifyRdteCycle({
    cycleIdIdentity: { fiscalYear: 2027, cycle: 'pb' },
    fiscalYear: 2027,
    manifestContentSha256: MANIFEST_SHA,
    requiredManifestDocumentKeys: ['r1', 'r2'],
    sourceDocuments: sourceDocs(),
    artifacts: artifactRefs(),
    verifications: verificationRefs(),
    comparisons: [],
    reconciliation: reconciliation(),
    projectionPlanningSucceeded: true,
    projectionPlanContentSha256: PROJECTION_SHA,
    ...overrides,
  });
}

describe('rdte-cycle-reconciler-v1', () => {
  it('reconciles exact identity, funding, relationships, and coverage', () => {
    const result = reconciliation();
    expect(result.blocking).toBe(false);
    expect(result.identity.complete).toBe(true);
    expect(result.funding.complete).toBe(true);
    expect(result.relationships.complete).toBe(true);
    expect(result.coverage.every((entry) => entry.status !== 'missing')).toBe(true);
  });

  it('blocks orphan PEs and duplicate natural keys', () => {
    const result = reconciliation({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1, PE2] },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [],
      duplicateNaturalKeys: ['duplicate-key'],
    });
    expect(result.blocking).toBe(true);
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['orphan_pe_outside_r1', 'duplicate_natural_key']),
    );
  });

  it('retains evidence on a funding mismatch', () => {
    const result = reconciliation({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [
        {
          peCode: PE1,
          fiscalYear: 2027,
          columnRole: 'budget_year_request',
          result: 'fail',
          evidenceIds: ['left-evidence', 'right-evidence'],
        },
      ],
      projectSumReconciliations: [],
      projectRelationships: { projects: [], projectFundingKeys: [] },
      coverageInputs: [],
    });
    const finding = result.findings.find(
      (entry) => entry.code === 'r1_r2_funding_mismatch',
    );
    expect(finding?.evidenceIds).toEqual(['left-evidence', 'right-evidence']);
  });

  it('blocks partial required coverage and unresolved R-3/R-4 project references', () => {
    const result = reconciliation({
      identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
      fundingComparisons: [],
      projectSumReconciliations: [],
      projectRelationships: {
        projects: [{ peCode: PE1, projectCode: 'A1' }],
        projectFundingKeys: [],
        referencedProjectKeys: [{ peCode: PE1, projectCode: 'MISSING' }],
      },
      coverageInputs: [
        {
          category: 'performers',
          expectedKeys: ['one', 'two'],
          coveredKeys: ['one'],
          applicable: true,
        },
      ],
    });
    expect(result.blocking).toBe(true);
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['category_coverage_partial', 'unresolved_project_reference']),
    );
  });
});

describe('rdte-cycle-certifier-v1', () => {
  it('certifies only after exact projection planning and proof binding', () => {
    const result = certify();
    expect(result.certification).toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(result.bundle.projectionPlanContentSha256).toBe(PROJECTION_SHA);
    expect(result.bundle.blockingFindings).toEqual([]);
  });

  it('blocks certification until projection planning produces an exact SHA', () => {
    const result = certify({
      projectionPlanningSucceeded: false,
      projectionPlanContentSha256: undefined,
    });
    expect(result.certification).toBe('INCOMPLETE');
    expect(
      result.bundle.blockingFindings.some(
        (finding) => finding.code === 'projection_planning_not_complete',
      ),
    ).toBe(true);
  });

  it('blocks a verification bound to the wrong artifact bytes or manifest', () => {
    const verifications = verificationRefs();
    verifications[0] = {
      ...verifications[0]!,
      artifactByteSha256: '9'.repeat(64),
      manifestContentSha256: '8'.repeat(64),
    };
    const result = certify({ verifications });
    expect(result.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(
      result.bundle.blockingFindings.some(
        (finding) => finding.code === 'verification_identity_mismatch',
      ),
    ).toBe(true);
  });

  it('accepts an immutable REVIEW_ACCEPTED result but blocks pending review', () => {
    expect(certify({ verifications: verificationRefs('accepted') }).certification).toBe(
      'CERTIFIED_RDTE_READY_FOR_PROJECTION',
    );
    const pending = certify({ verifications: verificationRefs('review') });
    expect(pending.certification).toBe('NEEDS_REVIEW');
    expect(
      pending.bundle.blockingFindings.some(
        (finding) => finding.code === 'required_document_needs_review',
      ),
    ).toBe(true);
  });

  it('rejects a required rejected document and marks missing inventory incomplete', () => {
    expect(certify({ verifications: verificationRefs('reject') }).certification).toBe(
      'REJECTED',
    );
    const incomplete = certify({ requiredManifestDocumentKeys: ['r1', 'r2', 'r3'] });
    expect(incomplete.certification).toBe('INCOMPLETE');
    expect(
      incomplete.bundle.blockingFindings.some(
        (finding) => finding.code === 'required_document_missing',
      ),
    ).toBe(true);
  });

  it('is deterministic across input permutations', () => {
    const first = certify();
    const second = certify({
      sourceDocuments: [...sourceDocs()].reverse(),
      artifacts: [...artifactRefs()].reverse(),
      verifications: [...verificationRefs()].reverse(),
    });
    expect(first.bundle.contentSha256).toBe(second.bundle.contentSha256);
  });
});
