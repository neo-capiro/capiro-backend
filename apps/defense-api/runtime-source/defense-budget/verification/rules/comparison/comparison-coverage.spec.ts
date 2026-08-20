/**
 * R8.1 WS3 — required comparison and coverage semantics.
 *
 * Proves:
 *  - a policy-required comparison persists required=true;
 *  - zero references prevents pass;
 *  - zero exact matches prevents pass;
 *  - partial coverage prevents pass;
 *  - complete matching coverage passes;
 *  - ambiguous reference match fails;
 *  - no generated check has an empty ID;
 *  - policy rule-code validation accepts implemented codes and rejects
 *    unimplemented codes.
 */
import { describe, it, expect } from '@jest/globals';
import {
  CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
  COMMITTEE_REQUEST_REFERENCE_RULE,
} from './comparison.rules.js';
import { validatePolicyRuleCodes } from '../index.js';
import type { VerificationContextV1 } from '../../verification-input-v1.js';
import type { VerificationPolicyV1 } from '../../verification-policy-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../../contracts/extraction-artifact-v1.js';
import type { ProofFindingV1 } from '../../trusted-proof/trusted-proof-types.js';

const RUN_ID = 'run_ws3';
const CANDIDATE_ID = 'cand_ws3';

function fundingAssertion(id: string, peCode: string, value: string) {
  return {
    assertionId: id,
    assertionKind: 'funding' as const,
    sourceFactIds: [],
    evidenceIds: [`ev-${id}`],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE' as const, peCode },
    fiscalYear: 2027,
    field: 'request' as const,
    money: { originalValue: value, originalUnit: 'millions' as const, valueMillions: value },
  };
}

function makeArtifact(
  artifactId: string,
  exhibit: string,
  assertions: unknown[],
): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId,
    contentSha256: 'a'.repeat(64),
    source: {
      manifestDocumentKey: 'doc',
      sourcePdfSha256: 'b'.repeat(64),
      sourceLocator: '/src.pdf',
      fiscalYear: 2027,
      family: 'rdte',
      exhibit,
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r1',
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
      assertionCount: 0,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
  } as unknown as DefenseBudgetExtractionArtifactV1;
}

function makePolicy(overrides: Partial<VerificationPolicyV1>): VerificationPolicyV1 {
  return {
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
    requiredComparisonRules: [],
    reviewComparisonRules: [],
    arithmeticRules: [],
    manualAlwaysReview: false,
    ocrMoneyAlwaysReview: false,
    congressionalMoneyAlwaysReviewWhenUncorroborated: false,
    enactedAlwaysReviewWhenUncorroborated: false,
    highMaterialityThresholdMillions: '1000',
    riskThresholds: { automaticPassMax: 10, targetedReextractionMax: 30, paidVerifierMax: 60 },
    ...overrides,
  };
}

function makeCtx(opts: {
  artifact: DefenseBudgetExtractionArtifactV1;
  policy: VerificationPolicyV1;
  referenceArtifacts?: DefenseBudgetExtractionArtifactV1[];
  referenceArtifactsFindings?: ProofFindingV1[];
}): VerificationContextV1 {
  const referenceArtifacts = opts.referenceArtifacts ?? [];
  return {
    input: {
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
      referenceArtifactsFindings: opts.referenceArtifactsFindings ?? [],
      startedAt: '2026-01-01T00:00:00Z',
    },
    policy: opts.policy,
    policySha256: 'e'.repeat(64),
    verificationRunId: RUN_ID,
    candidateId: CANDIDATE_ID,
  };
}

const REQUIRED_POLICY = makePolicy({
  requiredComparisonRules: ['cross_document_summary_detail'],
});

describe('R8.1 WS3 — cross_document_summary_detail required semantics', () => {
  it('required comparison persists required=true and never an empty checkId', () => {
    const ctx = makeCtx({
      artifact: makeArtifact('cand-1', 'R-1', [fundingAssertion('a1', '0602123A', '100')]),
      policy: REQUIRED_POLICY,
      referenceArtifacts: [],
    });
    const { check } = CROSS_DOCUMENT_SUMMARY_DETAIL_RULE.execute(ctx);
    expect(check).not.toBeNull();
    expect(check!.checkId.length).toBeGreaterThan(0);
    expect(check!.required).toBe(true);
  });

  it('zero references prevents pass (NOT_RUN, required)', () => {
    const ctx = makeCtx({
      artifact: makeArtifact('cand-1', 'R-1', [fundingAssertion('a1', '0602123A', '100')]),
      policy: REQUIRED_POLICY,
      referenceArtifacts: [],
    });
    const { check } = CROSS_DOCUMENT_SUMMARY_DETAIL_RULE.execute(ctx);
    expect(check!.outcome).toBe('NOT_RUN');
    expect(check!.required).toBe(true);
  });

  it('zero exact matches prevents pass (NOT_RUN, required)', () => {
    const ctx = makeCtx({
      artifact: makeArtifact('cand-1', 'R-1', [fundingAssertion('a1', '0602123A', '100')]),
      policy: REQUIRED_POLICY,
      referenceArtifacts: [
        makeArtifact('ref-1', 'R-2', [fundingAssertion('r1', '9999999X', '100')]),
      ],
    });
    const { check } = CROSS_DOCUMENT_SUMMARY_DETAIL_RULE.execute(ctx);
    expect(check!.outcome).toBe('NOT_RUN');
    expect(check!.required).toBe(true);
    expect(check!.details?.coveragePercent).toBe(0);
  });

  it('partial coverage prevents pass (NOT_RUN, required)', () => {
    const ctx = makeCtx({
      artifact: makeArtifact('cand-1', 'R-1', [
        fundingAssertion('a1', '0602123A', '100'),
        fundingAssertion('a2', '0602124A', '200'),
      ]),
      policy: REQUIRED_POLICY,
      referenceArtifacts: [
        makeArtifact('ref-1', 'R-2', [fundingAssertion('r1', '0602123A', '100')]),
      ],
    });
    const { check } = CROSS_DOCUMENT_SUMMARY_DETAIL_RULE.execute(ctx);
    expect(check!.outcome).toBe('NOT_RUN');
    expect(check!.required).toBe(true);
    expect(check!.details?.matchedAssertionCount).toBe(1);
    expect(check!.details?.candidateAssertionCount).toBe(2);
  });

  it('complete matching coverage passes', () => {
    const ctx = makeCtx({
      artifact: makeArtifact('cand-1', 'R-1', [fundingAssertion('a1', '0602123A', '100')]),
      policy: REQUIRED_POLICY,
      referenceArtifacts: [
        makeArtifact('ref-1', 'R-2', [fundingAssertion('r1', '0602123A', '100')]),
      ],
    });
    const { check } = CROSS_DOCUMENT_SUMMARY_DETAIL_RULE.execute(ctx);
    expect(check!.outcome).toBe('PASS');
    expect(check!.required).toBe(true);
    expect(check!.details?.coveragePercent).toBe(100);
  });

  it('ambiguous reference match fails', () => {
    const ctx = makeCtx({
      artifact: makeArtifact('cand-1', 'R-1', [fundingAssertion('a1', '0602123A', '100')]),
      policy: REQUIRED_POLICY,
      referenceArtifacts: [
        makeArtifact('ref-1', 'R-2', [
          fundingAssertion('r1', '0602123A', '100'),
          fundingAssertion('r2', '0602123A', '100'),
        ]),
      ],
    });
    const { check } = CROSS_DOCUMENT_SUMMARY_DETAIL_RULE.execute(ctx);
    expect(check!.outcome).toBe('FAIL');
  });

  it('optional comparison with zero coverage is NOT_RUN, never PASS', () => {
    const optionalPolicy = makePolicy({ reviewComparisonRules: ['cross_document_summary_detail'] });
    const ctx = makeCtx({
      artifact: makeArtifact('cand-1', 'R-1', [fundingAssertion('a1', '0602123A', '100')]),
      policy: optionalPolicy,
      referenceArtifacts: [
        makeArtifact('ref-1', 'R-2', [fundingAssertion('r1', '9999999X', '100')]),
      ],
    });
    const { check } = CROSS_DOCUMENT_SUMMARY_DETAIL_RULE.execute(ctx);
    expect(check!.outcome).not.toBe('PASS');
  });
});

describe('R8.1 WS3 — committee_request_reference required semantics', () => {
  const COMMITTEE_REQUIRED = makePolicy({
    requiredComparisonRules: ['committee_request_reference'],
  });

  it('required committee comparison persists required=true', () => {
    const ctx = makeCtx({
      artifact: makeArtifact('cand-1', 'R-1', [fundingAssertion('a1', '0602123A', '100')]),
      policy: COMMITTEE_REQUIRED,
      referenceArtifacts: [],
    });
    const { check } = COMMITTEE_REQUEST_REFERENCE_RULE.execute(ctx);
    expect(check!.required).toBe(true);
    expect(check!.checkId.length).toBeGreaterThan(0);
  });

  it('zero references prevents pass', () => {
    const ctx = makeCtx({
      artifact: makeArtifact('cand-1', 'R-1', [fundingAssertion('a1', '0602123A', '100')]),
      policy: COMMITTEE_REQUIRED,
      referenceArtifacts: [],
    });
    const { check } = COMMITTEE_REQUEST_REFERENCE_RULE.execute(ctx);
    expect(check!.outcome).toBe('NOT_RUN');
    expect(check!.required).toBe(true);
  });
});

describe('R8.1 §3.4 — policy rule-code validation', () => {
  it('accepts implemented rule codes', () => {
    expect(
      validatePolicyRuleCodes({
        requiredComparisonRules: ['cross_document_summary_detail', 'rdte_summary_detail'],
        reviewComparisonRules: ['historical_consistency'],
        arithmeticRules: ['rdte_summary_detail', 'project_rollup'],
      }),
    ).toEqual([]);
  });

  it('rejects unimplemented policy rule codes', () => {
    expect(
      validatePolicyRuleCodes({
        requiredComparisonRules: ['project_rollup_reference', 'procurement_summary_detail'],
        reviewComparisonRules: [],
        arithmeticRules: ['not_a_real_rule'],
      }),
    ).toEqual(['project_rollup_reference', 'procurement_summary_detail', 'not_a_real_rule']);
  });
});
