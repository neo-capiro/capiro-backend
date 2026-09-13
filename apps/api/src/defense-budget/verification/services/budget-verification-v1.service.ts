/**
 * Workstream L6/L7 — Budget verification V1 service.
 *
 * Resolves trusted proof, selects an authority-aware policy, executes
 * deterministic checks, produces the final decision, and optionally persists
 * audit evidence. This service never imports or calls a canonical writer.
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
import type { BudgetVerificationRepositoryV1, PersistedCandidateV1, PersistedRunV1 } from '../persistence/verification-repository.js';
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
    const resolution = await this.proofResolver.resolve({
      manifestLocator: request.manifestLocator,
      manifestDocumentKey: request.manifestDocumentKey,
      extractionArtifactLocator: request.extractionArtifactLocator,
      sourceDocumentId: request.sourceDocumentId,
      referenceArtifacts: request.referenceArtifacts ?? [],
      expectedSourcePdfSha256: request.expectedSourcePdfSha256,
      expectedExtractionArtifactSha256: request.expectedExtractionArtifactSha256,
    });

    const manifestDocument = resolution.manifestDocument;
    const basePolicy = lookupPolicyForManifestDocument(manifestDocument);
    if (!basePolicy) {
      return this.buildUnsupportedPolicyResult(request, resolution);
    }
    const policy = mergeManifestWithPolicy(basePolicy, {
      requiredDataCategories: manifestDocument.requiredDataCategories,
      requiredFundingFields: manifestDocument.requiredFundingFields,
      requiredLineKinds: manifestDocument.expectedLineKinds,
    });

    const invalidRuleCodes = validatePolicyRuleCodes(policy);
    if (invalidRuleCodes.length > 0) {
      throw new Error(
        `invalid verification policy rule code(s): ${invalidRuleCodes.join(', ')} ` +
          `(family=${manifestDocument.family} exhibit=${manifestDocument.exhibit} ` +
          `authority=${manifestDocument.authority})`,
      );
    }

    const policySha256 = computePolicySha256(policy);
    const startedAt = this.clock.now();
    const candidateCycleId = this.resolveCandidateCycleId(request, resolution);
    const candidateIdentity: CandidateIdentityV1 = {
      cycleId: candidateCycleId,
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

    if (this.repository) {
      const existing = await this.repository.findTerminalRunByIdentity(candidateIdentity);
      if (existing && existing.run.resultSnapshot) {
        return {
          ...defenseBudgetVerificationResultV1Schema.parse(existing.run.resultSnapshot),
          candidateId: existing.candidate.id,
          verificationRunId: existing.run.id,
        };
      }
    }

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
    const context: VerificationContextV1 = {
      input,
      policy,
      policySha256,
      verificationRunId,
      candidateId,
    };

    const rules = [
      ...ALL_VERIFICATION_RULES,
      CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
      COMMITTEE_REQUEST_REFERENCE_RULE,
      HISTORICAL_CONSISTENCY_RULE,
    ];
    const ruleResults: RuleResultV1[] = rules.map((rule) => rule.execute(context));
    const checks: VerificationCheckV1[] = ruleResults
      .map((result) => result.check)
      .filter((check): check is VerificationCheckV1 => check !== null);
    const discrepancies: VerificationDiscrepancyV1[] = ruleResults.flatMap(
      (result) => result.discrepancies,
    );

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

    // Congressional and enacted values trigger review only when no passing
    // independent-reference check explicitly corroborates the assertion.
    const independentlyCorroboratedAssertionIds = new Set(
      checks
        .filter(
          (check) =>
            check.outcome === 'PASS' && check.referenceArtifactIds.length > 0,
        )
        .flatMap((check) => check.assertionIds),
    );
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
          assertion.field === 'conference') &&
        !independentlyCorroboratedAssertionIds.has(assertion.assertionId),
    );
    const hasUncorroboratedEnacted = resolution.artifact.assertions.some(
      (assertion) =>
        assertion.assertionKind === 'funding' &&
        assertion.field === 'enacted' &&
        !independentlyCorroboratedAssertionIds.has(assertion.assertionId),
    );

    const decisionInput: DecisionEngineInputV1 = {
      checks,
      discrepancies,
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
      cycleId: candidateCycleId,
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
        // Phase 10B-31: the complete finding list -- candidate AND reference
        // -artifact findings, not just the candidate's own -- so the one row
        // the repository persists from this covers everything that could
        // have driven the decision, not a partial view of it.
        proofFindings: [...resolution.proofFindings, ...resolution.referenceArtifactsFindings],
        proofSnapshots: this.buildProofSnapshots(resolution, candidateCycleId),
        checks: result.checks,
        discrepancies: result.discrepancies,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        // Phase 7 Gap 5 decision 1: the candidate row records the family and
        // extraction method off this already-resolved, already-hash-verified
        // artifact. Passing it here is what stops promotion eligibility from
        // having to re-fetch an artifact to rediscover metadata that was known
        // at verification time.
        artifact: resolution.artifact,
      });
      return this.persistedResult(result, persisted);
    }

    return result;
  }

  private persistedResult(
    computed: DefenseBudgetVerificationResultV1,
    persisted: { candidate: PersistedCandidateV1; run: PersistedRunV1 },
  ): DefenseBudgetVerificationResultV1 {
    // A concurrent verifier may have committed a different decision/evidence
    // set for this identity. Return its immutable result, with the actual row
    // IDs, rather than attaching the winner's IDs to the losing evaluation.
    const snapshot = persisted.run.resultSnapshot == null
      ? computed
      : defenseBudgetVerificationResultV1Schema.parse(persisted.run.resultSnapshot);
    return defenseBudgetVerificationResultV1Schema.parse({
      ...snapshot,
      candidateId: persisted.candidate.id,
      verificationRunId: persisted.run.id,
      decision: persisted.run.decision,
      status: persisted.run.status,
      route: persisted.run.route,
      riskScore: persisted.run.riskScore,
    });
  }

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

  /**
   * Phase 10B-28R: the cycle identity a candidate is persisted under. The
   * request's governed cycle id wins when present (the lifecycle
   * `DefenseBudgetCycle.id` on the ingestion-bridge path; the manifest's own
   * cycleId on curated CLI paths, where the two coincide); otherwise the proof
   * manifest's cycleId, exactly as before this phase. Never a trust input:
   * proof resolution has already completed before this is consulted, and the
   * manifest's own label stays hash-bound on the manifest proof snapshot.
   */
  private resolveCandidateCycleId(
    request: VerificationRequestV1,
    resolution: TrustedProofResolutionV1,
  ): string {
    const requested = request.cycleId?.trim();
    if (requested) return requested;
    return resolution.manifest.cycleId ?? '';
  }

  private buildProofSnapshots(resolution: TrustedProofResolutionV1, candidateCycleId: string) {
    const snapshots: Array<{
      proofKind: string;
      status: string;
      sourceDocumentId?: string;
      artifactId?: string;
      referenceArtifactId?: string;
      evidenceJson: Record<string, unknown>;
    }> = [];

    // Phase 10B-31: `status` per kind below is no longer unconditionally
    // 'verified' -- each reflects whether any CANDIDATE proof finding
    // actually concerning that kind fired, using the schema's own documented
    // vocabulary ("verified | not_applicable | missing | mismatch",
    // BudgetVerificationProofV1.status in schema.prisma). Before this, a
    // blocking source_metadata_mismatch could REJECT the whole run while the
    // persisted source_document snapshot still read 'verified' -- correct
    // for every OTHER field it also covers, but misleading for the one that
    // actually disagreed, and with no way to tell which from this row alone.
    const candidateFindings = resolution.proofFindings;
    const findingsForCodes = (codes: readonly string[]) =>
      candidateFindings.filter((f) => (codes as readonly string[]).includes(f.code));
    const statusFor = (relevant: typeof candidateFindings, verifiedFallback: string) =>
      relevant.some((f) => f.severity === 'blocking') ? 'mismatch' : verifiedFallback;

    const manifestFindings = findingsForCodes(['manifest_sha_mismatch']);
    snapshots.push({
      proofKind: 'manifest',
      status: statusFor(manifestFindings, 'verified'),
      evidenceJson: {
        locator: resolution.proofBundle.manifest.locator,
        contentSha256: resolution.proofBundle.manifest.contentSha256,
        cycleId: resolution.proofBundle.manifest.cycleId,
        // Phase 10B-28R: when the candidate is persisted under a governed
        // cycle id that differs from the manifest's own label (the
        // lifecycle-bridge `fy{year}:{uuid}` case), record the relationship
        // on the immutable proof row so both identities stay recoverable.
        ...(candidateCycleId !== resolution.proofBundle.manifest.cycleId
          ? { candidateCycleId }
          : {}),
        ...(manifestFindings.length > 0 ? { findings: manifestFindings } : {}),
      },
    });
    const artifactFindings = findingsForCodes([
      'artifact_byte_sha_mismatch',
      'artifact_content_sha_mismatch',
      'artifact_source_sha_mismatch',
    ]);
    snapshots.push({
      proofKind: 'extraction_artifact',
      status: statusFor(artifactFindings, 'verified'),
      artifactId: resolution.proofBundle.extractionArtifact.artifactId,
      evidenceJson: {
        locator: resolution.proofBundle.extractionArtifact.locator,
        contentSha256: resolution.proofBundle.extractionArtifact.contentSha256,
        byteSha256: resolution.proofBundle.extractionArtifact.byteSha256,
        ...(artifactFindings.length > 0 ? { findings: artifactFindings } : {}),
      },
    });
    const sourceDocumentFindings = findingsForCodes([
      'source_metadata_mismatch',
      'source_document_not_found',
      'source_sha_mismatch',
      'source_bytes_unresolved',
    ]);
    snapshots.push({
      proofKind: 'source_document',
      status: statusFor(sourceDocumentFindings, 'verified'),
      sourceDocumentId: resolution.proofBundle.sourceDocument.id,
      evidenceJson: {
        sourceKey: resolution.proofBundle.sourceDocument.sourceKey,
        sourceSha256: resolution.proofBundle.sourceDocument.sourceSha256,
        ...(sourceDocumentFindings.length > 0 ? { findings: sourceDocumentFindings } : {}),
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

    // Note: the complete raw finding list (candidate + reference) is
    // persisted as its own snapshot row too, from `proofFindings` below,
    // once this reaches `PrismaBudgetVerificationRepositoryV1` --
    // deliberately built there, not here, from the exact
    // `PersistCompletedVerificationInputV1.proofFindings` field the caller
    // already declares for it (see `verify()` below and the repository).
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
    const candidateCycleId = this.resolveCandidateCycleId(request, resolution);
    const candidateIdentity: CandidateIdentityV1 = {
      cycleId: candidateCycleId,
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
      cycleId: candidateCycleId,
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
      const persisted = await this.repository.persistCompletedVerification({
        candidateIdentity,
        result,
        proofBundle: resolution.proofBundle,
        proofFindings: [...resolution.proofFindings, ...resolution.referenceArtifactsFindings],
        proofSnapshots: this.buildProofSnapshots(resolution, candidateCycleId),
        checks: result.checks,
        discrepancies: result.discrepancies,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        // Recorded on the unsupported-policy path too. This candidate is not
        // promotable, but its family and method are still facts about it, and
        // leaving them NULL here would make an unsupported-policy refusal
        // indistinguishable from an un-backfilled row.
        artifact: resolution.artifact,
      });
      return this.persistedResult(result, persisted);
    }
    return result;
  }
}
