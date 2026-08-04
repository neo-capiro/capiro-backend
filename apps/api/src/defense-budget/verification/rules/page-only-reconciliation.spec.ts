/**
 * R8.1 WS4 — page-only evidence reconciliation tests.
 *
 * Cases:
 *  - page-only with no reference;
 *  - page-only with zero match;
 *  - page-only with partial match (one of two assertions matched);
 *  - page-only with complete exact match;
 *  - page-only with reference proof failure;
 *  - page-only covered by a failed comparison.
 */
import { describe, it, expect } from '@jest/globals';
import { reconcilePageOnlyEvidence } from './page-only-reconciliation.js';
import type { ArtifactVerificationInputV1 } from '../verification-input-v1.js';
import type { VerificationPolicyV1 } from '../verification-policy-v1.js';
import type { VerificationCheckV1 } from '../verification-contract-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

function pageOnlyEvidence(id: string) {
  return { evidenceId: id, granularity: 'page_only' as const, page: 1 };
}

function moneyAssertion(id: string, evidenceIds: string[]) {
  return {
    assertionId: id,
    assertionKind: 'funding' as const,
    sourceFactIds: [],
    evidenceIds,
    confidence: 1,
    identity: { lineKind: 'RDTE_PE' as const, peCode: '0602123A' },
    fiscalYear: 2027,
    field: 'request' as const,
    money: { originalValue: '100', originalUnit: 'millions' as const, valueMillions: '100' },
  };
}

function makeArtifact(
  assertions: unknown[],
  evidence: unknown[],
): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: 'cand-1',
    contentSha256: 'a'.repeat(64),
    source: {
      manifestDocumentKey: 'doc',
      sourcePdfSha256: 'b'.repeat(64),
      sourceLocator: '/c.pdf',
      fiscalYear: 2027,
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r1',
    },
    parserRuns: [],
    evidence: evidence as never,
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
      assertionCount: 0,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
  } as unknown as DefenseBudgetExtractionArtifactV1;
}

const POLICY: VerificationPolicyV1 = {
  policyVersion: 'defense_budget_verification_policy_v1',
  family: 'rdte',
  exhibit: 'R-1',
  requiredDataCategories: [],
  requiredFundingFields: [],
  requiredLineKinds: [],
  allowedParserMethods: [],
  minimumMoneyEvidenceGranularity: 'cell_bbox',
  pageOnlyMayPassWithIndependentReconciliation: true,
  requireImmutableArchive: false,
  requireParserRunProof: false,
  requiredComparisonRules: ['cross_document_summary_detail'],
  reviewComparisonRules: [],
  arithmeticRules: [],
  manualAlwaysReview: false,
  ocrMoneyAlwaysReview: false,
  congressionalMoneyAlwaysReviewWhenUncorroborated: false,
  enactedAlwaysReviewWhenUncorroborated: false,
  highMaterialityThresholdMillions: '1000',
  riskThresholds: { automaticPassMax: 10, targetedReextractionMax: 30, paidVerifierMax: 60 },
};

function makeInput(opts: {
  artifact: DefenseBudgetExtractionArtifactV1;
  referenceArtifacts?: DefenseBudgetExtractionArtifactV1[];
  referenceArtifactsFindings?: { severity: 'blocking' | 'review' }[];
}): ArtifactVerificationInputV1 {
  const referenceArtifacts = opts.referenceArtifacts ?? [];
  return {
    request: {
      manifestLocator: '/m.json',
      manifestDocumentKey: 'doc',
      extractionArtifactLocator: '/a.json',
      sourceDocumentId: 'sd-1',
      mode: 'inspect',
    },
    manifest: { cycleId: 'c', fiscalYear: 2027, documents: [] } as never,
    manifestContentSha256: 'c'.repeat(64),
    manifestDocumentKey: 'doc',
    artifact: opts.artifact,
    extractionArtifactSha256: 'd'.repeat(64),
    proofBundle: {} as never,
    proofFindings: [],
    referenceArtifacts,
    referenceArtifactsProofBundles: referenceArtifacts.map(() => ({}) as never),
    referenceArtifactsFindings: (opts.referenceArtifactsFindings ?? []).map((f) => ({
      code: 'reference_artifact_proof_failed',
      severity: f.severity,
      message: 'ref proof',
    })),
    startedAt: '2026-01-01T00:00:00Z',
  };
}

function passComparisonCheck(matchedIds: string[]): VerificationCheckV1 {
  return {
    checkId: 'vc1_x',
    code: 'cross_document_summary_detail',
    ruleVersion: 'v1',
    outcome: 'PASS',
    required: true,
    blocking: true,
    riskPoints: 0,
    message: 'matched',
    assertionIds: matchedIds,
    evidenceIds: [],
    referenceArtifactIds: ['ref-1'],
  };
}

function failComparisonCheck(coveredIds: string[]): VerificationCheckV1 {
  return { ...passComparisonCheck(coveredIds), outcome: 'FAIL' };
}

describe('R8.1 WS4 — page-only reconciliation', () => {
  it('page-only with no reference -> unmatched review discrepancy', () => {
    const artifact = makeArtifact([moneyAssertion('a1', ['ev-1'])], [pageOnlyEvidence('ev-1')]);
    const result = reconcilePageOnlyEvidence(makeInput({ artifact }), POLICY, []);
    expect(result.reconciledAssertionIds).toEqual([]);
    expect(result.unreconciledAssertionIds).toContain('a1');
    expect(result.discrepancies.some((d) => d.severity === 'review')).toBe(true);
  });

  it('page-only with zero match -> unmatched review discrepancy', () => {
    const artifact = makeArtifact([moneyAssertion('a1', ['ev-1'])], [pageOnlyEvidence('ev-1')]);
    const checks = [passComparisonCheck(['some-other-assertion'])];
    const result = reconcilePageOnlyEvidence(makeInput({ artifact }), POLICY, checks);
    expect(result.reconciledAssertionIds).toEqual([]);
    expect(result.discrepancies.some((d) => d.code === 'page_only_assertion_unmatched')).toBe(true);
  });

  it('two page-only assertions with only one matched -> one reconciled, one review', () => {
    const artifact = makeArtifact(
      [moneyAssertion('a1', ['ev-1']), moneyAssertion('a2', ['ev-2'])],
      [pageOnlyEvidence('ev-1'), pageOnlyEvidence('ev-2')],
    );
    const checks = [passComparisonCheck(['a1'])];
    const result = reconcilePageOnlyEvidence(makeInput({ artifact }), POLICY, checks);
    expect(result.reconciledAssertionIds).toContain('a1');
    expect(result.unreconciledAssertionIds).toContain('a2');
    expect(result.discrepancies).toHaveLength(1);
  });

  it('page-only with complete exact match -> reconciled, no discrepancy', () => {
    const artifact = makeArtifact([moneyAssertion('a1', ['ev-1'])], [pageOnlyEvidence('ev-1')]);
    const checks = [passComparisonCheck(['a1'])];
    const result = reconcilePageOnlyEvidence(makeInput({ artifact }), POLICY, checks);
    expect(result.reconciledAssertionIds).toContain('a1');
    expect(result.discrepancies).toEqual([]);
  });

  it('page-only with reference proof failure -> review, not reconciled', () => {
    const artifact = makeArtifact([moneyAssertion('a1', ['ev-1'])], [pageOnlyEvidence('ev-1')]);
    const checks = [passComparisonCheck(['a1'])];
    const result = reconcilePageOnlyEvidence(
      makeInput({ artifact, referenceArtifactsFindings: [{ severity: 'blocking' }] }),
      POLICY,
      checks,
    );
    expect(result.reconciledAssertionIds).toEqual([]);
    expect(result.discrepancies.some((d) => d.code === 'page_only_reference_proof_failed')).toBe(
      true,
    );
  });

  it('page-only covered by a failed comparison -> blocking discrepancy', () => {
    const artifact = makeArtifact([moneyAssertion('a1', ['ev-1'])], [pageOnlyEvidence('ev-1')]);
    const checks = [failComparisonCheck(['a1'])];
    const result = reconcilePageOnlyEvidence(makeInput({ artifact }), POLICY, checks);
    expect(result.reconciledAssertionIds).toEqual([]);
    expect(
      result.discrepancies.some(
        (d) => d.code === 'page_only_comparison_failed' && d.severity === 'blocking',
      ),
    ).toBe(true);
  });
});
