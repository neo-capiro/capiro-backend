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

// V1 verification rules (Workstreams E–H)
export type {
  VerificationRuleV1,
  RuleResultV1,
} from './rules/rule-types.js';
export {
  passCheck,
  failCheck,
  notRunCheck,
  skippedCheck,
  makeDiscrepancy,
  registerRule,
  lookupRule,
  getAllRules,
  getRulesByCodes,
  clearRuleRegistry,
} from './rules/index.js';
export {
  CONTRACT_INTEGRITY_RULE,
  MANIFEST_BINDING_RULE,
  COMPLETENESS_RULE,
  EVIDENCE_BINDING_RULE,
  MONEY_EVIDENCE_RULE,
  WARNING_POLICY_RULE,
  IDENTITY_RULE,
  FUNDING_FIELD_OWNERSHIP_RULE,
  NUMERIC_RULE,
  DUPLICATE_RULE,
  RDTE_SUMMARY_DETAIL_RULE,
  PROJECT_ROLLUP_RULE,
  PROCUREMENT_ROLLUP_RULE,
  COMMITTEE_ADJUSTMENT_RULE,
  ALL_VERIFICATION_RULES,
} from './rules/index.js';
export {
  addDecimals,
  subtractDecimals,
  multiplyByInteger,
  absDifference,
  compareWithTolerance,
  printedUnitToleranceMillions,
  sumDecimals,
} from './rules/index.js';

// V1 comparison rules (Workstream I)
export type {
  ComparisonKindV1,
  ComparisonOutcomeV1,
  ComparisonResultV1,
  ComparisonMismatchDetailV1,
  ReferenceMatchResultV1,
  ReferenceArtifactEntryV1,
  ReferenceIndexKeyV1,
} from './rules/comparison/index.js';
export {
  isHistoricalConsistency,
  COMPARISON_KIND_V1_VALUES,
  ReferenceArtifactIndexV1,
  identityNaturalKey,
} from './rules/comparison/index.js';
export type { ComparisonProviderV1 } from './rules/comparison/index.js';
export { createComparisonProvider } from './rules/comparison/index.js';
export {
  CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
  COMMITTEE_REQUEST_REFERENCE_RULE,
  HISTORICAL_CONSISTENCY_RULE,
} from './rules/comparison/index.js';

// V1 decision engine (Workstream J)
export type {
  DecisionEngineInputV1,
  DecisionEngineResultV1,
  RiskEngineInputV1,
  RiskEngineResultV1,
} from './decision/index.js';
export { computeDecisionV1, computeRiskScoreV1 } from './decision/index.js';

// V1 persistence (Workstream L)
export type {
  BudgetVerificationRepositoryV1,
  CandidateIdentityV1,
  PersistCompletedVerificationInputV1,
  PersistReviewDecisionInputV1,
  ProofSnapshotInputV1,
  PersistedCandidateV1,
  PersistedRunV1,
  PersistedReviewDecisionV1,
  ReadCandidateV1,
  ReadRunV1,
} from './persistence/index.js';
export {
  PrismaBudgetVerificationRepositoryV1,
  createPrismaBudgetVerificationRepository,
  isValidTransition,
  assertValidTransition,
  statusFromDecision,
  candidateIdempotencyKey,
} from './persistence/index.js';

// V1 verification services (Workstream L/M)
export { BudgetVerificationV1Service } from './services/index.js';
export { BudgetReviewV1Service } from './services/index.js';
