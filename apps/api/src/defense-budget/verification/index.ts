export {
  applyReviewDecision,
  buildVerificationRun,
  DEFAULT_VERIFICATION_POLICY,
  verifyBudgetDocument,
} from './budget-verification.js';
export { persistVerificationAuditDraft } from './budget-verification-repository.js';
export { structurallyValidateAndPersistAuditDraft } from './budget-verification-service.js';
export {
  buildBudgetDocumentFromExtraction,
  buildBudgetDocumentFromMappedExtraction,
  buildExtractionDiagnostics,
  evidenceForAssertion,
  sourceLineKindFromClassification,
} from './budget-document-adapter.js';
export type {
  ArchiveProof,
  BoundingBox,
  BudgetCell,
  BudgetColumn,
  BudgetComparison,
  BudgetDocument,
  BudgetEvidence,
  BudgetRow,
  BudgetRowKind,
  BudgetSourceAuthority,
  BudgetVerificationResult,
  BudgetVerificationRun,
  EvidenceGranularity,
  ExtractionDiagnostics,
  NormalizedBudgetRecord,
  ParseProof,
  ReviewDecision,
  VerificationCheck,
  VerificationCheckCode,
  VerificationField,
  VerificationOptions,
  VerificationPolicy,
  VerificationRoute,
  VerificationStatus,
} from './budget-verification.js';
export type {
  BudgetExtractionCandidateRecord,
  BudgetExtractionCellRecord,
  BudgetVerificationCheckRecord,
  BudgetVerificationRepository,
  BudgetVerificationRunRecord,
} from './budget-verification-repository.js';
export type { VerificationClock } from './budget-verification-service.js';

// ── Phase 2 V1 trusted verification gate ─────────────────────────── //
// V1 exports take precedence over the Phase 0 scaffold. The scaffold
// (verifyBudgetDocument) remains internal/deprecated and explicitly
// non-trusted.

// V1 verification contract (Workstream A)
export {
  DEFENSE_BUDGET_VERIFIER_VERSION,
  DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
  verificationCandidateStatusV1Schema,
  checkOutcomeV1Schema,
  verificationDecisionV1Schema,
  verificationRouteV1Schema,
  verificationCheckV1Schema,
  verificationDiscrepancyV1Schema,
  defenseBudgetVerificationResultV1Schema,
  verificationRequestV1Schema,
  computeVerificationCheckId,
  computeVerificationDiscrepancyId,
  type VerificationCandidateStatusV1,
  type CheckOutcomeV1,
  type VerificationDecisionV1,
  type VerificationRouteV1,
  type VerificationCheckV1,
  type VerificationDiscrepancyV1,
  type DefenseBudgetVerificationResultV1,
  type VerificationRequestV1,
} from './verification-contract-v1.js';
export type {
  ArtifactVerificationInputV1,
  VerificationContextV1,
} from './verification-input-v1.js';

// V1 trusted proof (Workstreams B + C)
export type {
  TrustedVerificationProofBundleV1,
  ProofFindingV1,
  ProofFindingCodeV1,
  TrustedProofResolveInputV1,
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from './trusted-proof/index.js';
export {
  blockingFinding,
  reviewFinding,
  PROOF_FINDING_V1_VALUES,
} from './trusted-proof/index.js';
export { FilesystemProofResolver } from './trusted-proof/filesystem-proof-resolver.js';
export { SourceDocumentProofResolver } from './trusted-proof/source-document-proof-resolver.js';
export { ArchiveProofResolver } from './trusted-proof/archive-proof-resolver.js';
export { ParserRunProofResolver } from './trusted-proof/parser-run-proof-resolver.js';
export { ExtractionArtifactProofResolver } from './trusted-proof/extraction-artifact-proof-resolver.js';
export { CompositeProofResolver } from './trusted-proof/composite-proof-resolver.js';

// V1 verification policy (Workstream D)
export {
  verificationPolicyV1Schema,
  computePolicySha256,
  mergeManifestWithPolicy,
  checkManifestDoesNotWeakenPolicy,
  type VerificationPolicyV1,
  type PolicyWeakeningFinding,
} from './verification-policy-v1.js';
export {
  lookupPolicyByExhibit,
  lookupPolicy,
  isPolicySupported,
  getAllPolicies,
  getSupportedPolicies,
  type PolicyRegistryEntry,
} from './verification-policy-registry.js';
