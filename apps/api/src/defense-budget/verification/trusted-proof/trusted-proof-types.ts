/**
 * Trusted proof types for defense_budget_verification_v1.
 *
 * These types define the normalized proof contract owned by the verifier.
 * No rule engine may directly query the database or S3. All external proof
 * access is isolated behind the resolver.
 */
import type { JsonValue } from '../../contracts/canonical-json.js';
import type {
  BudgetCycleManifestV1,
  BudgetCycleManifestDocumentV1,
} from '../../contracts/budget-cycle-manifest-v1.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionMethodV1,
} from '../../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* B1. Trusted proof bundle                                             */
/* ------------------------------------------------------------------ */

export interface TrustedManifestProofV1 {
  locator: string;
  contentSha256: string;
  cycleId: string;
  fiscalYear: number;
  documentKey: string;
}

export interface TrustedExtractionArtifactProofV1 {
  locator: string;
  artifactId: string;
  contentSha256: string;
  byteSha256: string;
  schemaVersion: 'defense_budget_extraction_v1';
}

export interface TrustedSourceDocumentProofV1 {
  id: string;
  sourceKey: string;
  sourceSha256: string;
  sourceUrl?: string;
  artifactPath?: string;
  fiscalYear?: number;
  budgetCycle?: string;
  component?: string;
  documentType?: string;
  extractionMethod?: string;
  extractionToolVersion?: string;
  metadata?: Record<string, JsonValue>;
}

export interface TrustedArchiveProofV1 {
  status: 'verified' | 'not_applicable' | 'missing' | 'mismatch';
  bucket?: string;
  key?: string;
  versionId?: string;
  objectSha256?: string;
  byteSize?: number;
  objectLockMode?: string;
  retainUntil?: string;
  kmsKeyArn?: string;
}

export interface TrustedParserRunProofV1 {
  parserRunId: string;
  method: ExtractionMethodV1;
  parserVersion: string;
  parserConfigSha256: string;
  inputSourceSha256: string;
  outputArtifactSha256: string;
  persistedParseJobId?: string;
  providerJobId?: string;
  outputLocator?: string;
  proofStatus: 'verified' | 'missing' | 'mismatch' | 'not_applicable';
}

export interface TrustedReferenceArtifactProofV1 {
  artifactId: string;
  contentSha256: string;
  sourceDocumentId: string;
  sourcePdfSha256: string;
  locator: string;
}

/**
 * The verifier-owned normalized proof bundle. The shape is owned by the
 * verifier, not by the SourceDocument/DocumentParseJob schema. Implementation
 * uses actual current SourceDocument/DocumentParseJob field names.
 */
export interface TrustedVerificationProofBundleV1 {
  manifest: TrustedManifestProofV1;
  extractionArtifact: TrustedExtractionArtifactProofV1;
  sourceDocument: TrustedSourceDocumentProofV1;
  archive: TrustedArchiveProofV1;
  parserRuns: TrustedParserRunProofV1[];
  resolvedReferenceArtifacts: TrustedReferenceArtifactProofV1[];
}

/* ------------------------------------------------------------------ */
/* B3. Fail-closed proof findings                                       */
/* ------------------------------------------------------------------ */

export const PROOF_FINDING_V1_VALUES = [
  'source_document_not_found',
  'source_sha_mismatch',
  'manifest_sha_mismatch',
  'artifact_byte_sha_mismatch',
  'artifact_content_sha_mismatch',
  'artifact_source_sha_mismatch',
  'archive_version_missing',
  'archive_sha_mismatch',
  'parse_job_missing',
  'parse_input_sha_mismatch',
  'parse_output_sha_mismatch',
  'parser_method_mismatch',
  'reference_artifact_proof_failed',
] as const;
export type ProofFindingCodeV1 = (typeof PROOF_FINDING_V1_VALUES)[number];

export interface ProofFindingV1 {
  code: ProofFindingCodeV1;
  severity: 'blocking' | 'review';
  message: string;
  details?: Record<string, JsonValue>;
}

/**
 * Every proof finding is either blocking or review by policy. None is
 * silently ignored.
 */

/* ------------------------------------------------------------------ */
/* B2. Resolver interface and resolution result                        */
/* ------------------------------------------------------------------ */

/**
 * The input to the trusted proof resolver.
 */
export interface TrustedProofResolveInputV1 {
  manifestLocator: string;
  manifestDocumentKey: string;
  extractionArtifactLocator: string;
  sourceDocumentId: string;
  referenceArtifactLocators: readonly string[];
  expectedSourcePdfSha256?: string;
  expectedExtractionArtifactSha256?: string;
}

/**
 * The resolution result produced by the trusted proof resolver.
 */
export interface TrustedProofResolutionV1 {
  manifest: BudgetCycleManifestV1;
  manifestDocument: BudgetCycleManifestDocumentV1;
  manifestContentSha256: string;
  artifact: DefenseBudgetExtractionArtifactV1;
  extractionArtifactByteSha256: string;
  extractionArtifactContentSha256: string;
  proofBundle: TrustedVerificationProofBundleV1;
  proofFindings: ProofFindingV1[];
  referenceArtifacts: readonly DefenseBudgetExtractionArtifactV1[];
  referenceArtifactsProofBundles: readonly TrustedVerificationProofBundleV1[];
  referenceArtifactsFindings: readonly ProofFindingV1[];
}

/**
 * The resolver interface. No rule engine may directly query the database or
 * S3. All external proof access is isolated behind this resolver.
 */
export interface TrustedVerificationProofResolverV1 {
  resolve(input: TrustedProofResolveInputV1): Promise<TrustedProofResolutionV1>;
}

/* ------------------------------------------------------------------ */
/* Helper: create a proof finding                                       */
/* ------------------------------------------------------------------ */

export function blockingFinding(
  code: ProofFindingCodeV1,
  message: string,
  details?: Record<string, JsonValue>,
): ProofFindingV1 {
  return { code, severity: 'blocking', message, details };
}

export function reviewFinding(
  code: ProofFindingCodeV1,
  message: string,
  details?: Record<string, JsonValue>,
): ProofFindingV1 {
  return { code, severity: 'review', message, details };
}