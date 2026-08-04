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
 *
 * R3: Deterministic candidate and run IDs derived from the canonical
 * identity material. Inspect and persist modes produce the same IDs.
 * R3: persist_audit fails loudly when no repository is configured.
 * R3: Unsupported policy decisions are also persisted.
 */
import type {
  VerificationRequestV1,
  DefenseBudgetVerificationResultV1,
  VerificationCheckV1,
  VerificationDiscrepancyV1,
} from '../verification-contract-v1.js';
import type {
  TrustedVerificationProofResolverV1,
  TrustedProofResolutionV1,
} from '../trusted-proof/trusted-proof-types.js';
import type {
  ArtifactVerificationInputV1,
  VerificationContextV1,
} from '../verification-input-v1.js';
import type { BudgetVerificationRepositoryV1 } from '../persistence/verification-repository.js';
import type { CandidateIdentityV1 } from '../persistence/verification-repository.js';
import { computePolicySha256, mergeManifestWithPolicy } from '../verification-policy-v1.js';
import { lookupPolicyForManifestDocument } from '../authority-policy-resolution.js';
import { ALL_VERIFICATION_RULES, validatePolicyRuleCodes } from '../rules/index.js';
import {
  CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
  COMMITTEE_REQUEST_REFERENCE_RULE,
  HISTORICAL_CONSISTENCY_RULE,
} from '../rules/comparison/index.js';
import type { RuleResultV1 } from '../rules/rule-types.js';
import { computeDecisionV1 } from '../decision/decision-engine-v1.js';
import type { DecisionEngineInputV1 } from '../decision/decision-engine-v1.js';
import { reconcilePageOnlyEvidence } from '../rules/page-only-reconciliation.js';
import {
  computeCandidateId,
  computeRunId,
} from '../persistence/verification-persistence-mappers.js';
import { defenseBudgetVerificationResultV1Schema } from '../verification-contract-v1.js';

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
      referenceArtifacts: request.referenceArtifacts ?? [],
      expectedSourcePdfSha256: request.expectedSourcePdfSha256,
      expectedExtractionArtifactSha256: request.expectedExtractionArtifactSha256,
    });

    // L6.3 / R8.3: Resolve the exact authority-aware policy. Committee and
    // conference documents share family/exhibit values, so family+exhibit
    // alone is not a safe discriminator.
    const manifestDoc = resolution.manifestDocument;
    const basePolicy = lookupPolicyForManifestDocument(manifestDoc);
    if (!basePolicy) {
      // Unsupported family — honest NEEDS_REVIEW
      return this.buildUnsupportedPolicyResult(request, resolution);
    }
    const policy = mergeManifestWithPolicy(basePolicy, {
      requiredDataCategories: manifestDoc.requiredDataCategories,
      requiredFundingFields: manifestDoc.requiredFundingFields,
      requiredLineKinds: manifestDoc.expectedLineKinds,
    });

    // R8.1 §3.4: reject invalid policy rule-code configuration before running.
    const invalidRuleCodes = validatePolicyRuleCodes(policy);
    if (invalidRuleCodes.length > 0) {
      throw new Error(
        `invalid verification policy rule code(s): ${invalidRuleCodes.join(', ')} ` +
          `(family=${manifestDoc.family} exhibit=${manifestDoc.exhibit} authority=${manifestDoc.authority})`,
      );
    }

    const policySha256 = computePolicySha256(policy);

    // R8-E: Compute candidate and run identity BEFORE rule execution.
    // R8.3: exact immutable identity has exactly one deterministic run; the
    // nonfunctional public attempt feature was removed.
    const startedAt = this.clock.now();
    const candidateIdentity: CandidateIdentityV1 = {
      cycleId: resolution.manifest.cycleId ?? '',
      manifestContentSha256: resolution.manifestContentSha256,
      manifestDocumentKey: request.manifestDocumentKey,
      extractionArtifactId: resolution.artifact.artifactId,
      extractionArtifactSha256: resolution.extractionArtifactContentSha256,
      extractionArtifactLocator: request.extractionArtifactLocator,
      sourceDocumentId: request.sourceDocumentId,
      sourceSha256: resolution.proofBundle.sourceDocument.sourceSha256,
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256,
    };
    const candidateId = computeCandidateId(candidateIdentity);
    const verificationRunId = computeRunId(candidateIdentity, '0');

    // R8.1 §5.1: exact terminal replay — return the persisted snapshot before
    // running any rules. Only when a repository is available (persist mode).
    if (this.repository) {
      const existing = await this.repository.findTerminalRunByIdentity(candidateIdentity);
      if (existing && existing.run.resultSnapshot) {
        return defenseBudgetVerificationResultV1Schema.parse(existing.run.resultSnapshot);
      }
    }

    // L6.4: Run deterministic verification
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
    const ctx: VerificationContextV1 = {
      input,
      policy,
      policySha256,
      verificationRunId,
      candidateId,
    };

    // Run all E-H rules + I comparison rules
    const allRules = [
      ...ALL_VERIFICATION_RULES,
      CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
      COMMITTEE_REQUEST_REFERENCE_RULE,
      HISTORICAL_CONSISTENCY_RULE,
    ];
    const ruleResults: RuleResultV1[] = allRules.map((rule) => rule.execute(ctx));
    const checks: VerificationCheckV1[] = ruleResults
      .map((result) => result.check)
      .filter((check): check is VerificationCheckV1 => check !== null);
    const discrepancies: VerificationDiscrepancyV1[] = ruleResults.flatMap(
      (result) => result.discrepancies,
    );

    // R8.3: page-only evidence reconciliation is an executable final check.
    // When every pending page-only assertion is reconciled, convert the
    // provisional money-evidence NOT_RUN to PASS so it cannot force a false
    // human-review decision after successful independent corroboration.
    const reconciliation = reconcilePageOnlyEvidence(
      input,
      policy,
      checks,
      verificationRunId,
    );
    if (
      reconciliation.check.outcome === 'PASS' &&
      reconciliation.pageOnlyAssertionIds.length > 0
    ) {
      const pageOnlyIds = new Set(reconciliation.pageOnlyAssertionIds);
      const moneyEvidenceIndex = checks.findIndex(
        (check) =>
          check.code === 'money_evidence_policy' &&
          check.outcome === 'NOT_RUN' &&
          check.assertionIds.length > 0 &&
          check.assertionIds.every((assertionId) => pageOnlyIds.has(assertionId)),
      );
      if (moneyEvidenceIndex >= 0) {
        const provisional = checks[moneyEvidenceIndex]!;
        checks[moneyEvidenceIndex] = {
          ...provisional,
          outcome: 'PASS',
          required: true,
          blocking: true,
          riskPoints: 0,
          message:
            'page-only monetary evidence satisfies policy through complete independent reconciliation',
          details: {
            ...(provisional.details ?? {}),
            finalizedBy: 'page_only_reconciliation',
            reconciledAssertionIds: reconciliation.reconciledAssertionIds,
          },
        };
      }
    }
    checks.push(reconciliation.check);
    discrepancies.push(...reconciliation.discrepancies);

    // L6.5: Produce final result via decision engine
    const hasManualParser = resolution.artifact.parserRuns.some((run) => run.method === 'manual');
    const hasOcrParser = resolution.artifact.parserRuns.some((run) => run.method === 'paddleocr');
    const hasUncorroboratedCongressionalMoney = resolution.artifact.assertions.some(
      (assertion) =>
        assertion.assertionKind === 'funding' &&
        (assertion.field === 'hascMark' ||
          assertion.field === 'sascMark' ||
          assertion.field === 'hacDMark' ||
          assertion.field === 'sacDMark' ||
          assertion.field === 'ndaaConference' ||
          assertion.field === 'conference'),
    );
    const hasUncorroboratedEnacted = resolution.artifact.assertions.some(
      (assertion) => assertion.assertionKind === 'funding' && assertion.field === 'enacted',
    );

    const decisionInput: DecisionEngineInputV1 = {
      checks,
      discrepancies,
      // R8.1 §3.6: reference proof failures are part of the final decision —
      // a blocking reference proof failure must prevent PASS.
      proofFindings: [...resolution.proofFindings, ...resolution.referenceArtifactsFindings],
      policy,
      hasManualParser,
      hasOcrParser,
      hasUncorroboratedCongressionalMoney,
      hasUncorroboratedEnacted,
    };
    const decisionResult = computeDecisionV1(decisionInput);

    const completedAt = this.clock.now();

    const result: DefenseBudgetVerificationResultV1 = {
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256,
      verificationRunId,
      candidateId,
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
      referenceArtifactIds: resolution.referenceArtifacts.map((artifact) => artifact.artifactId).sort(),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    };

    // R3: persist_audit fails loudly when no repository is configured
    if (request.mode === 'persist_audit') {
      if (!this.repository) {
        throw new Error(
          'persist_audit mode requires a repository, but no repository was configured',
        );
      }
      const persisted = await this.repository.persistCompletedVerification({
        candidateIdentity,
        result,
        proofBundle: resolution.proofBundle,
        proofFindings: resolution.proofFindings,
        proofSnapshots: this.buildProofSnapshots(resolution),
        checks: result.checks,
        discrepancies: result.discrepancies,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
      });
      return {
        ...result,
        candidateId: persisted.candidate.id,
        verificationRunId: persisted.run.id,
      };
    }

    return result;
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  private sortChecks(checks: VerificationCheckV1[]): VerificationCheckV1[] {
    return [...checks].sort(
      (left, right) =>
        left.code.localeCompare(right.code) || left.checkId.localeCompare(right.checkId),
    );
  }

  private sortDiscrepancies(
    discrepancies: VerificationDiscrepancyV1[],
  ): VerificationDiscrepancyV1[] {
    return [...discrepancies].sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        left.discrepancyId.localeCompare(right.discrepancyId),
    );
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

    for (const reference of resolution.proofBundle.resolvedReferenceArtifacts) {
      snapshots.push({
        proofKind: 'reference_artifact',
        status: 'verified',
        referenceArtifactId: reference.artifactId,
        sourceDocumentId: reference.sourceDocumentId,
        evidenceJson: {
          artifactId: reference.artifactId,
          contentSha256: reference.contentSha256,
          sourcePdfSha256: reference.sourcePdfSha256,
        },
      });
    }

    return snapshots;
  }

  private async buildUnsupportedPolicyResult(
    request: VerificationRequestV1,
    resolution: TrustedProofResolutionV1,
  ): Promise<DefenseBudgetVerificationResultV1> {
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

    const candidateIdentity: CandidateIdentityV1 = {
      cycleId: resolution.manifest.cycleId ?? '',
      manifestContentSha256: resolution.manifestContentSha256,
      manifestDocumentKey: request.manifestDocumentKey,
      extractionArtifactId: resolution.artifact.artifactId,
      extractionArtifactSha256: resolution.extractionArtifactContentSha256,
      extractionArtifactLocator: request.extractionArtifactLocator,
      sourceDocumentId: request.sourceDocumentId,
      sourceSha256: resolution.proofBundle.sourceDocument.sourceSha256,
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256,
    };

    const candidateId = computeCandidateId(candidateIdentity);
    const verificationRunId = computeRunId(candidateIdentity, '0');

    const result: DefenseBudgetVerificationResultV1 = {
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256,
      verificationRunId,
      candidateId,
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
      checks: [
        {
          checkId: `vc1_unsupported_policy_${resolution.manifestDocument.exhibit}`,
          code: 'verification_policy_not_implemented',
          ruleVersion: 'defense_budget_verification_rule_v1',
          outcome: 'NOT_RUN',
          required: true,
          blocking: false,
          riskPoints: 100,
          message:
            `no verification policy implemented for family=${resolution.manifestDocument.family} ` +
            `exhibit=${resolution.manifestDocument.exhibit} ` +
            `authority=${resolution.manifestDocument.authority}`,
          assertionIds: [],
          evidenceIds: [],
          referenceArtifactIds: [],
          details: {
            family: resolution.manifestDocument.family,
            exhibit: resolution.manifestDocument.exhibit,
            authority: resolution.manifestDocument.authority,
          },
        },
      ],
      discrepancies: [],
      acceptedAssertionIds: [],
      rejectedAssertionIds: [],
      referenceArtifactIds: [],
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    };

    if (request.mode === 'persist_audit') {
      if (!this.repository) {
        throw new Error(
          'persist_audit mode requires a repository, but no repository was configured',
        );
      }
      await this.repository.persistCompletedVerification({
        candidateIdentity,
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

    return result;
  }
}

/* ------------------------------------------------------------------ */
/* Review service — moved to budget-review-v1.service.ts (Workstream M) */
/* ------------------------------------------------------------------ */
