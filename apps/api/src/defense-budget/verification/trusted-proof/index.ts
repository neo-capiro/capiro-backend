/**
 * Barrel exports for the trusted-proof submodule.
 */
export type {
  TrustedManifestProofV1,
  TrustedExtractionArtifactProofV1,
  TrustedSourceDocumentProofV1,
  TrustedArchiveProofV1,
  TrustedParserRunProofV1,
  TrustedReferenceArtifactProofV1,
  TrustedVerificationProofBundleV1,
  ProofFindingV1,
  ProofFindingCodeV1,
  TrustedProofResolveInputV1,
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from './trusted-proof-types.js';
export {
  blockingFinding,
  reviewFinding,
  PROOF_FINDING_V1_VALUES,
} from './trusted-proof-types.js';
export type { FilesystemProofResolver } from './filesystem-proof-resolver.js';
export type { SourceDocumentProofResolver } from './source-document-proof-resolver.js';
export type { ArchiveProofResolver } from './archive-proof-resolver.js';
export type { ParserRunProofResolver } from './parser-run-proof-resolver.js';
export type { ExtractionArtifactProofResolver } from './extraction-artifact-proof-resolver.js';
export type { CompositeProofResolver } from './composite-proof-resolver.js';