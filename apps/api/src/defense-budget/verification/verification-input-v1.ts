/**
 * Verification input types for defense_budget_verification_v1.
 *
 * These types connect the verification request to the proof resolver and
 * policy resolver. They are the internal inputs to the verification engine,
 * not the externally serialized request (see verification-contract-v1.ts).
 */
import type {
  BudgetFamilyV1,
  ExhibitV1,
  ExtractionMethodV1,
  FundingFieldV1,
  BudgetLineKindV1,
} from '../contracts/extraction-artifact-v1.js';
import type { RequiredDataCategoryV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type { BudgetCycleManifestV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';
import type {
  VerificationRequestV1,
  VerificationCandidateStatusV1,
  VerificationRouteV1,
  VerificationDecisionV1,
} from './verification-contract-v1.js';
import type {
  TrustedVerificationProofBundleV1,
  ProofFindingV1,
} from './trusted-proof/trusted-proof-types.js';

/* ------------------------------------------------------------------ */
/* Resolved inputs to the verification engine                           */
/* ------------------------------------------------------------------ */

/**
 * The fully resolved input to the artifact verification engine.
 *
 * Everything external (manifest bytes, artifact bytes, source bytes, archive
 * metadata, parse-job rows) has already been resolved into immutable proof
 * by the trusted proof resolver before this struct is constructed. The
 * engine never touches the database or S3.
 */
export interface ArtifactVerificationInputV1 {
  request: VerificationRequestV1;
  manifest: BudgetCycleManifestV1;
  manifestContentSha256: string;
  manifestDocumentKey: string;
  artifact: DefenseBudgetExtractionArtifactV1;
  extractionArtifactSha256: string;
  proofBundle: TrustedVerificationProofBundleV1;
  proofFindings: ProofFindingV1[];
  referenceArtifacts: readonly DefenseBudgetExtractionArtifactV1[];
  referenceArtifactsProofBundles: readonly TrustedVerificationProofBundleV1[];
  referenceArtifactsFindings: readonly ProofFindingV1[];
  startedAt: string;
}

/* ------------------------------------------------------------------ */
/* Policy-resolved verification context                                */
/* ------------------------------------------------------------------ */

/**
 * The policy-resolved verification context, combining the resolved policy
 * with the manifest document entry and proof bundle.
 */
export interface VerificationContextV1 {
  input: ArtifactVerificationInputV1;
  policy: VerificationPolicyV1;
  policySha256: string;
}

/* ------------------------------------------------------------------ */
/* Re-export the policy shape for the engine                           */
/* ------------------------------------------------------------------ */

/**
 * Strict policy shape (mirrors verification-policy-v1.ts).
 * Re-exported here so the engine imports from a single module.
 */
export interface VerificationPolicyV1 {
  policyVersion: 'defense_budget_verification_policy_v1';
  family: BudgetFamilyV1;
  exhibit: ExhibitV1;
  requiredDataCategories: RequiredDataCategoryV1[];
  requiredFundingFields: FundingFieldV1[];
  requiredLineKinds: BudgetLineKindV1[];
  allowedParserMethods: ExtractionMethodV1[];
  minimumMoneyEvidenceGranularity: 'page_only' | 'cell_bbox' | 'text_span';
  pageOnlyMayPassWithIndependentReconciliation: boolean;
  requireImmutableArchive: boolean;
  requireParserRunProof: boolean;
  requiredComparisonRules: string[];
  reviewComparisonRules: string[];
  arithmeticRules: string[];
  manualAlwaysReview: boolean;
  ocrMoneyAlwaysReview: boolean;
  congressionalMoneyAlwaysReviewWhenUncorroborated: boolean;
  enactedAlwaysReviewWhenUncorroborated: boolean;
  highMaterialityThresholdMillions: string;
  riskThresholds: {
    automaticPassMax: number;
    targetedReextractionMax: number;
    paidVerifierMax: number;
  };
}
