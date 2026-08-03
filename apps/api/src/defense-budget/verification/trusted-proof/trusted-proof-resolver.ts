/**
 * Trusted proof resolver boundary.
 *
 * This module re-exports the resolver interface and types. The concrete
 * resolvers (filesystem, source-document, archive, parser-run, extraction-
 * artifact, composite) are in sibling files. The composite resolver is the
 * single production-capable composition point.
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
export { blockingFinding, reviewFinding, PROOF_FINDING_V1_VALUES } from './trusted-proof-types.js';
export type { TrustedVerificationProofResolverV1 as default } from './trusted-proof-types.js';
