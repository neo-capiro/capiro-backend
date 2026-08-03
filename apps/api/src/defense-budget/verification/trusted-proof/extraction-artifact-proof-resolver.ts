/**
 * Extraction-artifact proof resolver.
 *
 * Handles re-hashing and semantic validation of the extraction artifact
 * itself, plus reference artifact proof. This is a thin wrapper around the
 * Phase 1 semantic validator, producing proof findings for the trusted proof
 * bundle.
 */
import { createHash } from 'node:crypto';
import {
  parseDefenseBudgetExtractionArtifactV1,
  validateDefenseBudgetExtractionArtifactV1,
  computeArtifactContentSha256,
} from '../../contracts/extraction-artifact-v1.semantic.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import { sha256Bytes } from '../../contracts/canonical-json.js';
import type { TrustedExtractionArtifactProofV1, ProofFindingV1 } from './trusted-proof-types.js';
import { blockingFinding } from './trusted-proof-types.js';

export interface ExtractionArtifactProofResolverInput {
  artifactLocator: string;
  /** Raw artifact bytes (already read). */
  artifactBytes: Buffer;
}

export interface ExtractionArtifactProofResolverResult {
  artifact: DefenseBudgetExtractionArtifactV1;
  byteSha256: string;
  contentSha256: string;
  extractionArtifactProof: TrustedExtractionArtifactProofV1;
  findings: ProofFindingV1[];
}

/**
 * Resolve extraction-artifact proof from actual bytes.
 * This is used by both the filesystem and composite resolvers.
 */
export class ExtractionArtifactProofResolver {
  async resolve(
    input: ExtractionArtifactProofResolverInput,
  ): Promise<ExtractionArtifactProofResolverResult> {
    const findings: ProofFindingV1[] = [];

    // Hash the raw bytes — R1: use sha256Bytes for raw file bytes
    const byteSha256 = sha256Bytes(input.artifactBytes);

    // Parse with Zod
    let artifact: DefenseBudgetExtractionArtifactV1;
    try {
      artifact = parseDefenseBudgetExtractionArtifactV1(
        JSON.parse(input.artifactBytes.toString('utf8')),
      );
    } catch (err) {
      findings.push(
        blockingFinding(
          'artifact_byte_sha_mismatch',
          `artifact parse failed: ${(err as Error).message}`,
        ),
      );
      throw new Error(`artifact parsing failed: ${(err as Error).message}`);
    }

    // Recompute content SHA
    const contentSha256 = computeArtifactContentSha256(artifact);
    if (artifact.contentSha256 !== contentSha256) {
      findings.push(
        blockingFinding(
          'artifact_content_sha_mismatch',
          `artifact contentSha256 does not recompute: expected ${contentSha256}, got ${artifact.contentSha256}`,
        ),
      );
    }

    // Run semantic validation
    const semanticFindings = validateDefenseBudgetExtractionArtifactV1(artifact);
    for (const f of semanticFindings.filter((f) => f.severity === 'error')) {
      findings.push(
        blockingFinding(
          'artifact_content_sha_mismatch',
          `semantic validation error: ${f.code} at ${f.path}: ${f.message}`,
        ),
      );
    }

    const extractionArtifactProof: TrustedExtractionArtifactProofV1 = {
      locator: input.artifactLocator,
      artifactId: artifact.artifactId,
      contentSha256: contentSha256,
      byteSha256,
      schemaVersion: 'defense_budget_extraction_v1',
    };

    return {
      artifact,
      byteSha256,
      contentSha256,
      extractionArtifactProof,
      findings,
    };
  }
}
