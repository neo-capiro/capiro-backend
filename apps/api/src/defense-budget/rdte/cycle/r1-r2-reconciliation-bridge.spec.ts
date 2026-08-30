/**
 * Phase 10B-17 Part D critical invariant -- the R-1<->R-2 reconciliation
 * bridge in `rdte-summary-detail.rules.ts` must NEVER make an R-2
 * `document_fact` (`r2_total_component`) promotable as a canonical
 * `ProgramElementYear.request` value. Verification evidence (this rule
 * passing) and canonical projection eligibility (`disposition ===
 * 'canonical_request_candidate'` on a `funding` assertion) are, and must
 * remain, fully separate concerns.
 *
 * This test runs the REAL production functions end to end against the
 * exact real R-1 and R-2 artifacts (see `r1-r2-real-artifacts-fixture.ts`):
 * the real verifier rule, then the real canonical projection planner --
 * not a hand-rolled assertion about the rule's internals.
 */
import { sha256Bytes } from '../../contracts/canonical-json.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
} from '../../contracts/extraction-artifact-v1.js';
import {
  computeRdteCycleBundleContentSha256,
  rdteCycleBundleV1Schema,
  type RdteCycleBundleV1,
  type RdteCycleVerificationRefV1,
} from '../rdte-cycle-bundle-v1.js';
import { planRdteCanonicalProjection } from '../projection/rdte-projection-planner-v1.js';
import { BudgetVerificationV1Service } from '../../verification/services/budget-verification-v1.service.js';
import type {
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from '../../verification/trusted-proof/trusted-proof-types.js';
import type { BudgetVerificationRepositoryV1 } from '../../verification/persistence/verification-repository.js';
import {
  R2_SOURCE_SHA,
  R2_SOURCE_DOCUMENT_ID,
  R2_SOURCE_URL,
  TARGET_PE,
  CYCLE_FISCAL_YEAR,
  buildRealR1Artifact,
  buildRealR2Artifact,
} from './r1-r2-real-artifacts-fixture.js';

const MANIFEST_SHA = 'b'.repeat(64);
const POLICY_SHA = 'c'.repeat(64);
const PROJECTION_SHA = 'd'.repeat(64);

function artifactByteSha(artifact: DefenseBudgetExtractionArtifactV1): string {
  return sha256Bytes(Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8'));
}

/** Mirrors `rdte-projection-planner-v1.spec.ts`'s helper, extended to
 * handle R-2 (that file never builds a plain R-2 artifact, only R-2A). */
function exhibitRole(exhibit: ExtractionSourceV1['exhibit']) {
  if (exhibit === 'R-1') return 'r1_catalog' as const;
  if (exhibit === 'R-2') return 'r2_pe_summary' as const;
  if (exhibit === 'R-2A') return 'r2a_project_detail' as const;
  if (exhibit === 'R-3') return 'r3_cost_analysis' as const;
  return 'r4_schedule' as const;
}

function passedVerification(artifact: DefenseBudgetExtractionArtifactV1): RdteCycleVerificationRefV1 {
  const candidateId = `candidate-${artifact.source.manifestDocumentKey}`;
  const runId = `run-${artifact.source.manifestDocumentKey}`;
  return {
    manifestDocumentKey: artifact.source.manifestDocumentKey,
    manifestContentSha256: MANIFEST_SHA,
    artifactId: artifact.artifactId,
    artifactContentSha256: artifact.contentSha256,
    artifactByteSha256: artifactByteSha(artifact),
    candidateId,
    verificationRunId: runId,
    policySha256: POLICY_SHA,
    sourceDocumentId: artifact.source.sourceDocumentId!,
    sourcePdfSha256: artifact.source.sourcePdfSha256,
    phase2Decision: 'PASS',
    status: 'VERIFICATION_PASSED',
    acceptedAssertionIds: artifact.assertions.map((assertion) => assertion.assertionId),
    rejectedAssertionIds: [],
    verificationCandidateId: candidateId,
    decision: 'VERIFICATION_PASSED',
    decisionId: runId,
  };
}

function certifiedBundle(artifacts: readonly DefenseBudgetExtractionArtifactV1[]): RdteCycleBundleV1 {
  const sourceDocuments = artifacts.map((artifact) => ({
    manifestDocumentKey: artifact.source.manifestDocumentKey,
    sourceDocumentId: artifact.source.sourceDocumentId!,
    exhibitRole: exhibitRole(artifact.source.exhibit),
    required: true,
    sourcePdfSha256: artifact.source.sourcePdfSha256,
    sourceLocator: artifact.source.sourceLocator,
    pageCount: 170,
    parserRunIds: artifact.parserRuns.map((run) => run.parserRunId),
    unresolvedPages: [],
  }));
  const artifactRefs = artifacts.map((artifact) => ({
    manifestDocumentKey: artifact.source.manifestDocumentKey,
    artifactId: artifact.artifactId,
    artifactContentSha256: artifact.contentSha256,
    artifactByteSha256: artifactByteSha(artifact),
  }));
  const verifications = artifacts.map((artifact) => passedVerification(artifact));
  const withoutHash = {
    schemaVersion: 'rdte_cycle_bundle_v1' as const,
    cycleId: 'phase10b17-reconciliation-bridge-invariant',
    bundleId: 'phase10b17-reconciliation-bridge-invariant-bundle',
    fiscalYear: CYCLE_FISCAL_YEAR,
    manifestContentSha256: MANIFEST_SHA,
    sourceDocuments,
    artifacts: artifactRefs,
    verifications,
    comparisons: [],
    coverage: [],
    projectionPlanContentSha256: PROJECTION_SHA,
    certification: 'CERTIFIED_RDTE_READY_FOR_PROJECTION' as const,
    blockingFindings: [],
    nonBlockingFindings: [],
  };
  return rdteCycleBundleV1Schema.parse({
    ...withoutHash,
    contentSha256: computeRdteCycleBundleContentSha256(withoutHash),
  });
}

class DualArtifactVerificationResolver implements TrustedVerificationProofResolverV1 {
  constructor(
    private readonly candidate: DefenseBudgetExtractionArtifactV1,
    private readonly reference: DefenseBudgetExtractionArtifactV1,
  ) {}
  async resolve(): Promise<TrustedProofResolutionV1> {
    const manifestDocument = {
      documentKey: R2_SOURCE_DOCUMENT_ID,
      required: true,
      title: 'r2',
      sourceLocator: R2_SOURCE_URL,
      expectedSourceSha256: R2_SOURCE_SHA,
      family: 'rdte',
      exhibit: 'R-2',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r2',
      parserPolicy: 'deterministic_table',
      requiredDataCategories: ['identity'],
      requiredFundingFields: [],
      expectedLineKinds: ['RDTE_PE'],
      allowEmpty: false,
    };
    return {
      manifest: {
        schemaVersion: 'defense_budget_cycle_manifest_v1',
        cycleId: 'phase10b17-reconciliation-bridge-invariant',
        fiscalYear: CYCLE_FISCAL_YEAR,
        domain: 'defense',
        documents: [manifestDocument],
      } as never,
      manifestDocument: manifestDocument as never,
      manifestContentSha256: 'e'.repeat(64),
      artifact: this.candidate,
      extractionArtifactByteSha256: this.candidate.contentSha256,
      extractionArtifactContentSha256: this.candidate.contentSha256,
      proofBundle: {
        manifest: {
          locator: 'synthetic://manifest',
          contentSha256: 'e'.repeat(64),
          cycleId: 'phase10b17-reconciliation-bridge-invariant',
          fiscalYear: CYCLE_FISCAL_YEAR,
          documentKey: R2_SOURCE_DOCUMENT_ID,
        },
        extractionArtifact: {
          artifactId: this.candidate.artifactId,
          locator: 'synthetic://artifact',
          contentSha256: this.candidate.contentSha256,
          byteSha256: this.candidate.contentSha256,
        },
        sourceDocument: {
          id: R2_SOURCE_DOCUMENT_ID,
          sourceKey: R2_SOURCE_DOCUMENT_ID,
          sourceSha256: R2_SOURCE_SHA,
        },
        archive: { status: 'not_applicable' },
        parserRuns: this.candidate.parserRuns.map((run) => ({
          parserRunId: run.parserRunId,
          method: run.method,
          proofStatus: 'verified' as const,
        })),
        resolvedReferenceArtifacts: [
          { artifactId: this.reference.artifactId, exhibit: 'R-1', proofStatus: 'verified' as const },
        ],
      } as never,
      proofFindings: [],
      referenceArtifacts: [this.reference],
      referenceArtifactsProofBundles: [],
      referenceArtifactsFindings: [],
    };
  }
}

describe('Phase 10B-17 Part D critical invariant -- reconciliation PASS never grants canonical eligibility', () => {
  it('rdte_summary_detail PASSes for PE 0601102A via the bridge, but the real projection planner still excludes the R-2 value as contextual_only, never as a ProgramElementYear candidate', async () => {
    const r1Artifact = buildRealR1Artifact();
    const r2Artifact = buildRealR2Artifact();

    // Step 1: prove the bridge really does produce PASS (the behavior this
    // invariant is guarding), using the real verifier -- not asserting the
    // rule's internals directly.
    const verificationService = new BudgetVerificationV1Service(
      new DualArtifactVerificationResolver(r2Artifact, r1Artifact),
      null as unknown as BudgetVerificationRepositoryV1,
    );
    const verification = await verificationService.verify({
      manifestLocator: 'synthetic://manifest',
      manifestDocumentKey: R2_SOURCE_DOCUMENT_ID,
      extractionArtifactLocator: 'synthetic://artifact',
      sourceDocumentId: R2_SOURCE_DOCUMENT_ID,
      mode: 'inspect',
    });
    const summaryDetail = verification.checks.find((c) => c.code === 'rdte_summary_detail');
    expect(summaryDetail?.outcome).toBe('PASS');

    // Step 2: run the REAL canonical projection planner against the exact
    // same two real artifacts (both marked VERIFICATION_PASSED, exactly as
    // production would present them after an accepted verification run).
    const bundle = certifiedBundle([r1Artifact, r2Artifact]);
    const { plan } = planRdteCanonicalProjection({ bundle, artifacts: [r1Artifact, r2Artifact] });

    const r2TotalComponentAssertion = r2Artifact.assertions.find(
      (a) =>
        a.assertionKind === 'document_fact' &&
        (a as { fieldName?: string }).fieldName === 'r2_total_component' &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value
          ?.peCode === TARGET_PE &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value
          ?.fiscalYear === CYCLE_FISCAL_YEAR &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value
          ?.rowKind === 'pe_total',
    );
    expect(r2TotalComponentAssertion).toBeDefined();

    // The critical invariant: no ProgramElementYear candidate in the real
    // plan traces back to the R-2 document_fact assertion, for ANY source
    // artifact -- reconciliation evidence never becomes a canonical
    // candidate merely because it passed verification.
    const peYearCandidatesFromR2 = plan.candidates.filter(
      (candidate) =>
        candidate.target === 'ProgramElementYear' &&
        candidate.assertionIds.includes(r2TotalComponentAssertion!.assertionId),
    );
    expect(peYearCandidatesFromR2).toHaveLength(0);

    // And it must be explicitly, verifiably excluded (not silently
    // dropped) with the same real reason the planner has always used for
    // R-2 Base/OCO/Total-derived document facts, proving this phase did
    // not touch that exclusion logic at all.
    const r2Exclusion = plan.exclusions.find(
      (excluded) => excluded.assertionId === r2TotalComponentAssertion!.assertionId,
    );
    expect(r2Exclusion).toBeDefined();
    expect(r2Exclusion?.reason).toBe('contextual_only_value');

    // eslint-disable-next-line no-console
    console.log(
      'Phase 10B-17 Part D invariant -- projection plan summary:',
      JSON.stringify(
        {
          rdteSummaryDetailOutcome: summaryDetail?.outcome,
          totalProgramElementYearCandidates: plan.candidates.filter(
            (c) => c.target === 'ProgramElementYear',
          ).length,
          peYearCandidatesFromR2Count: peYearCandidatesFromR2.length,
          r2TotalComponentExclusionReason: r2Exclusion?.reason,
        },
        null,
        2,
      ),
    );
  });
});
