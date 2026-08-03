/**
 * Workstream L6/L7 — Budget verification V1 service.
 *
 * BudgetVerificationV1Service.verify() must:
 *   1. parse request;
 *   2. resolve trusted proof;
 *   3. resolve policy;
 *   4. run deterministic verification;
 *   5. produce final result;
 *   6. optionally persist audit in one transaction;
 *   7. return result.
 *
 * The service must not import or call any canonical writer.
 *
 * L7: Inspect mode — resolve proof, run all checks, write nothing,
 * return the same deterministic decision content except DB IDs.
 */
import type {
  VerificationRequestV1,
  DefenseBudgetVerificationResultV1,
  VerificationCheckV1,
  VerificationDiscrepancyV1,
} from '../verification-contract-v1.js';
import type { TrustedVerificationProofResolverV1, TrustedProofResolutionV1 } from '../trusted-proof/trusted-proof-types.js';
import type { VerificationPolicyV1 } from '../verification-policy-v1.js';
import type { ArtifactVerificationInputV1, VerificationContextV1 } from '../verification-input-v1.js';
import type { BudgetVerificationRepositoryV1 } from '../persistence/verification-repository.js';
import { computePolicySha256, mergeManifestWithPolicy } from '../verification-policy-v1.js';
import { lookupPolicy } from '../verification-policy-registry.js';
import { ALL_VERIFICATION_RULES } from '../rules/index.js';
import {
  CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
  COMMITTEE_REQUEST_REFERENCE_RULE,
  HISTORICAL_CONSISTENCY_RULE,
} from '../rules/comparison/index.js';
import type { RuleResultV1 } from '../rules/rule-types.js';
import { computeDecisionV1 } from '../decision/decision-engine-v1.js';
import type { DecisionEngineInputV1 } from '../decision/decision-engine-v1.js';
import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export interface VerificationClock {
  now(): Date;
}

export class BudgetVerificationV1Service {
  constructor(
    private readonly proofResolver: TrustedVerificationProofResolverV1,
    private readonly repository: BudgetVerificationRepositoryV1 | null,
    private readonly clock: VerificationClock = { now: () => new Date() },
  ) {}

  async verify(request: VerificationRequestV1): Promise<DefenseBudgetVerificationResultV1> {
    // L6.1: Parse request (already done by Zod at boundary)
    // L6.2: Resolve trusted proof
    const resolution = await this.proofResolver.resolve({
      manifestLocator: request.manifestLocator,
      manifestDocumentKey: request.manifestDocumentKey,
      extractionArtifactLocator: request.extractionArtifactLocator,
      sourceDocumentId: request.sourceDocumentId,
      referenceArtifactLocators: request.referenceArtifactLocators ?? [],
      expectedSourcePdfSha256: request.expectedSourcePdfSha256,
      expectedExtractionArtifactSha256: request.expectedExtractionArtifactSha256,
    });

    // L6.3: Resolve policy
    const manifestDoc = resolution.manifestDocument;
    const basePolicy = lookupPolicy(manifestDoc.family, manifestDoc.exhibit);
    if (!basePolicy) {
      // Unsupported family — honest NEEDS_REVIEW or REJECTED
      return this.buildUnsupportedPolicyResult(request, resolution);
    }
    const policy = mergeManifestWithPolicy(basePolicy, {
      requiredDataCategories: manifestDoc.requiredDataCategories,
      requiredFundingFields: manifestDoc.requiredFundingFields,
      requiredLineKinds: manifestDoc.expectedLineKinds,
    });
    const policySha256 = computePolicySha256(policy);

    // L6.4: Run deterministic verification
    const startedAt = this.clock.now();
    const input: ArtifactVerificationInputV1 = {
      request,
      manifest: resolution.manifest,
      manifestContentSha256: resolution.manifestContentSha256,
      manifestDocumentKey: request.manifestDocumentKey,
      artifact: resolution.artifact,
      extractionArtifactSha256: resolution.extractionArtifactContentSha256,
      proofBundle: resolution.proofBundle,
      proofFindings: resolution.proofFindings,
      referenceArtifacts: resolution.referenceArtifacts,
      referenceArtifactsProofBundles: resolution.referenceArtifactsProofBundles,
      referenceArtifactsFindings: resolution.referenceArtifactsFindings,
      startedAt: startedAt.toISOString(),
    };
    const ctx: VerificationContextV1 = { input, policy, policySha256 };

    // Run all E-H rules + I comparison rules
    const allRules = [...ALL_VERIFICATION_RULES, CROSS_DOCUMENT_SUMMARY_DETAIL_RULE, COMMITTEE_REQUEST_REFERENCE_RULE, HISTORICAL_CONSISTENCY_RULE];
    const ruleResults: RuleResultV1[] = allRules.map((rule) => rule.execute(ctx));
    const checks: VerificationCheckV1[] = ruleResults
      .map((r) => r.check)
      .filter((c): c is VerificationCheckV1 => c !== null);
    const discrepancies: VerificationDiscrepancyV1[] = ruleResults.flatMap((r) => r.discrepancies);

    // L6.5: Produce final result via decision engine
    const hasManualParser = resolution.artifact.parserRuns.some((pr) => pr.method === 'manual');
    const hasOcrParser = resolution.artifact.parserRuns.some((pr) => pr.method === 'paddleocr');
    const hasUncorroboratedCongressionalMoney = resolution.artifact.assertions.some(
      (a) => a.assertionKind === 'funding' &&
        (a.field === 'hascMark' || a.field === 'sascMark' || a.field === 'hacDMark' || a.field === 'sacDMark' || a.field === 'ndaaConference' || a.field === 'conference'),
    );
    const hasUncorroboratedEnacted = resolution.artifact.assertions.some(
      (a) => a.assertionKind === 'funding' && a.field === 'enacted',
    );

    const decisionInput: DecisionEngineInputV1 = {
      checks,
      discrepancies,
      proofFindings: resolution.proofFindings,
      policy,
      hasManualParser,
      hasOcrParser,
      hasUncorroboratedCongressionalMoney,
      hasUncorroboratedEnacted,
    };
    const decisionResult = computeDecisionV1(decisionInput);

    const completedAt = this.clock.now();
    const verificationRunId = this.computeRunId(input, policySha256);

    const result: DefenseBudgetVerificationResultV1 = {
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256,
      verificationRunId,
      candidateId: this.computeCandidateId(input, policySha256),
      cycleId: resolution.manifest.cycleId ?? '',
      manifestContentSha256: resolution.manifestContentSha256,
      manifestDocumentKey: request.manifestDocumentKey,
      extractionArtifactId: resolution.artifact.artifactId,
      extractionArtifactSha256: resolution.extractionArtifactContentSha256,
      sourceDocumentId: request.sourceDocumentId,
      sourcePdfSha256: resolution.proofBundle.sourceDocument.sourceSha256,
      decision: decisionResult.decision,
      status: decisionResult.status,
      route: decisionResult.route,
      riskScore: decisionResult.riskScore,
      checks: this.sortChecks(checks),
      discrepancies: this.sortDiscrepancies(discrepancies),
      acceptedAssertionIds: decisionResult.acceptedAssertionIds,
      rejectedAssertionIds: decisionResult.rejectedAssertionIds,
      referenceArtifactIds: resolution.referenceArtifacts.map((a) => a.artifactId).sort(),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    };

    // L6.6: Optionally persist audit in one transaction
    if (request.mode === 'persist_audit' && this.repository) {
      await this.repository.persistCompletedVerification({
        candidateIdentity: {
          cycleId: result.cycleId,
          manifestContentSha256: result.manifestContentSha256,
          manifestDocumentKey: result.manifestDocumentKey,
          extractionArtifactId: result.extractionArtifactId,
          extractionArtifactSha256: result.extractionArtifactSha256,
          extractionArtifactLocator: request.extractionArtifactLocator,
          sourceDocumentId: result.sourceDocumentId,
          sourceSha256: result.sourcePdfSha256,
          verifierVersion: result.verifierVersion,
          policyVersion: result.policyVersion,
          policySha256: result.policySha256,
        },
        result,
        proofBundle: resolution.proofBundle,
        proofFindings: resolution.proofFindings,
        proofSnapshots: this.buildProofSnapshots(resolution),
        checks: result.checks,
        discrepancies: result.discrepancies,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
      });
    }

    // L6.7: Return result
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* L7: Inspect mode                                                    */
  /* ------------------------------------------------------------------ */

  // Inspect mode is the default (mode='inspect'); verify() already handles
  // it by only persisting when mode='persist_audit'. No separate method needed.

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  private computeRunId(input: ArtifactVerificationInputV1, policySha256: string): string {
    const material = [
      input.manifestContentSha256,
      input.extractionArtifactSha256,
      input.proofBundle.sourceDocument.id,
      input.proofBundle.sourceDocument.sourceSha256,
      policySha256,
    ].join('|');
    return `vrun_${createHash('sha256').update(material, 'utf8').digest('hex')}`;
  }

  private computeCandidateId(input: ArtifactVerificationInputV1, policySha256: string): string {
    const material = [
      input.manifestContentSha256,
      input.manifestDocumentKey,
      input.proofBundle.sourceDocument.id,
      input.proofBundle.sourceDocument.sourceSha256,
      input.extractionArtifactSha256,
      'defense_budget_verifier_v1',
      policySha256,
    ].join('|');
    return `vcan_${createHash('sha256').update(material, 'utf8').digest('hex')}`;
  }

  private sortChecks(checks: VerificationCheckV1[]): VerificationCheckV1[] {
    return [...checks].sort((a, b) => a.code.localeCompare(b.code) || a.checkId.localeCompare(b.checkId));
  }

  private sortDiscrepancies(discrepancies: VerificationDiscrepancyV1[]): VerificationDiscrepancyV1[] {
    return [...discrepancies].sort((a, b) => a.code.localeCompare(b.code) || a.discrepancyId.localeCompare(b.discrepancyId));
  }

  private buildProofSnapshots(resolution: TrustedProofResolutionV1) {
    const snapshots: Array<{
      proofKind: string;
      status: string;
      sourceDocumentId?: string;
      artifactId?: string;
      referenceArtifactId?: string;
      evidenceJson: Record<string, unknown>;
    }> = [];

    snapshots.push({
      proofKind: 'manifest',
      status: 'verified',
      evidenceJson: {
        locator: resolution.proofBundle.manifest.locator,
        contentSha256: resolution.proofBundle.manifest.contentSha256,
        cycleId: resolution.proofBundle.manifest.cycleId,
      },
    });

    snapshots.push({
      proofKind: 'extraction_artifact',
      status: 'verified',
      artifactId: resolution.proofBundle.extractionArtifact.artifactId,
      evidenceJson: {
        locator: resolution.proofBundle.extractionArtifact.locator,
        contentSha256: resolution.proofBundle.extractionArtifact.contentSha256,
        byteSha256: resolution.proofBundle.extractionArtifact.byteSha256,
      },
    });

    snapshots.push({
      proofKind: 'source_document',
      status: 'verified',
      sourceDocumentId: resolution.proofBundle.sourceDocument.id,
      evidenceJson: {
        sourceKey: resolution.proofBundle.sourceDocument.sourceKey,
        sourceSha256: resolution.proofBundle.sourceDocument.sourceSha256,
      },
    });

    snapshots.push({
      proofKind: 'archive',
      status: resolution.proofBundle.archive.status,
      evidenceJson: { ...resolution.proofBundle.archive },
    });

    for (const ref of resolution.proofBundle.resolvedReferenceArtifacts) {
      snapshots.push({
        proofKind: 'reference_artifact',
        status: 'verified',
        referenceArtifactId: ref.artifactId,
        sourceDocumentId: ref.sourceDocumentId,
        evidenceJson: {
          artifactId: ref.artifactId,
          contentSha256: ref.contentSha256,
          sourcePdfSha256: ref.sourcePdfSha256,
        },
      });
    }

    return snapshots;
  }

  private buildUnsupportedPolicyResult(
    request: VerificationRequestV1,
    resolution: TrustedProofResolutionV1,
  ): DefenseBudgetVerificationResultV1 {
    const startedAt = this.clock.now();
    const completedAt = this.clock.now();
    const policySha256 = computePolicySha256({
      policyVersion: 'defense_budget_verification_policy_v1',
      family: resolution.manifestDocument.family,
      exhibit: resolution.manifestDocument.exhibit,
      requiredDataCategories: [],
      requiredFundingFields: [],
      requiredLineKinds: [],
      allowedParserMethods: [],
      minimumMoneyEvidenceGranularity: 'cell_bbox',
      pageOnlyMayPassWithIndependentReconciliation: false,
      requireImmutableArchive: false,
      requireParserRunProof: false,
      requiredComparisonRules: [],
      reviewComparisonRules: [],
      arithmeticRules: [],
      manualAlwaysReview: true,
      ocrMoneyAlwaysReview: true,
      congressionalMoneyAlwaysReviewWhenUncorroborated: true,
      enactedAlwaysReviewWhenUncorroborated: true,
      highMaterialityThresholdMillions: '0',
      riskThresholds: { automaticPassMax: 0, targetedReextractionMax: 0, paidVerifierMax: 0 },
    });

    const verificationRunId = `vrun_unsupported_${createHash('sha256').update(resolution.manifestContentSha256, 'utf8').digest('hex')}`;
    return {
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256,
      verificationRunId,
      candidateId: `vcan_unsupported_${createHash('sha256').update(resolution.manifestContentSha256, 'utf8').digest('hex')}`,
      cycleId: resolution.manifest.cycleId ?? '',
      manifestContentSha256: resolution.manifestContentSha256,
      manifestDocumentKey: request.manifestDocumentKey,
      extractionArtifactId: resolution.artifact.artifactId,
      extractionArtifactSha256: resolution.extractionArtifactContentSha256,
      sourceDocumentId: request.sourceDocumentId,
      sourcePdfSha256: resolution.proofBundle.sourceDocument.sourceSha256,
      decision: 'REVIEW',
      status: 'NEEDS_REVIEW',
      route: 'human_review',
      riskScore: 100,
      checks: [{
        checkId: `vc1_unsupported_policy_${resolution.manifestDocument.exhibit}`,
        code: 'verification_policy_not_implemented',
        ruleVersion: 'defense_budget_verification_rule_v1',
        outcome: 'NOT_RUN',
        required: true,
        blocking: false,
        riskPoints: 100,
        message: `no verification policy implemented for family=${resolution.manifestDocument.family} exhibit=${resolution.manifestDocument.exhibit}`,
        assertionIds: [],
        evidenceIds: [],
        referenceArtifactIds: [],
        details: { family: resolution.manifestDocument.family, exhibit: resolution.manifestDocument.exhibit },
      }],
      discrepancies: [],
      acceptedAssertionIds: [],
      rejectedAssertionIds: [],
      referenceArtifactIds: [],
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Review service (Workstream M — stub for L barrel)                    */
/* ------------------------------------------------------------------ */

export class BudgetReviewV1Service {
  constructor(private readonly repository: BudgetVerificationRepositoryV1) {}

  async review(input: {
    candidateId: string;
    verificationRunId: string;
    reviewerId: string;
    decision: 'accept' | 'reject';
    notes: string;
    evidenceIds: string[];
    expectedSourceSha256: string;
    expectedExtractionArtifactSha256: string;
    expectedManifestContentSha256: string;
  }): Promise<{ id: string; decision: string; createdAt: string }> {
    return this.repository.persistReviewDecision(input);
  }
}
