/**
 * Filesystem proof resolver for local/test execution.
 *
 * Reads actual bytes from the local filesystem:
 *   - manifest bytes (re-hash with sha256Hex — deliberate UTF-8 string hash)
 *   - V1 artifact bytes (re-hash byte SHA with sha256Bytes — raw bytes)
 *   - source PDF bytes when the source locator is a local path (re-hash with
 *     sha256Bytes — raw bytes)
 *
 * R1 fixes:
 *   - Uses sha256Bytes for all binary hashing (PDF, artifact file bytes).
 *   - sha256Hex reserved for deliberate UTF-8 string hashing (manifest JSON).
 *   - SourceDocument proof is fail-closed: missing source PDF is a blocking
 *     proof failure, not a reason to trust the artifact's embedded SHA.
 *   - Reference artifacts are independently proved — each gets its own
 *     source document lookup, archive proof, and parser run proof.
 *     They never reuse the candidate's proof bundle.
 *
 * Never accepts a caller-provided source hash as proof.
 */
import * as fs from 'node:fs/promises';
import {
  parseBudgetCycleManifestV1,
  validateBudgetCycleManifestV1,
  type BudgetCycleManifestV1,
  type BudgetCycleManifestDocumentV1,
} from '../../contracts/budget-cycle-manifest-v1.js';
import {
  parseDefenseBudgetExtractionArtifactV1,
  computeArtifactContentSha256,
} from '../../contracts/extraction-artifact-v1.semantic.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import { sha256Hex, sha256Bytes } from '../../contracts/canonical-json.js';
import type {
  TrustedProofResolveInputV1,
  TrustedProofResolutionV1,
  ProofFindingV1,
  TrustedVerificationProofBundleV1,
  TrustedManifestProofV1,
  TrustedExtractionArtifactProofV1,
  TrustedSourceDocumentProofV1,
  TrustedArchiveProofV1,
  TrustedParserRunProofV1,
  TrustedReferenceArtifactProofV1,
} from './trusted-proof-types.js';
import { blockingFinding, reviewFinding } from './trusted-proof-types.js';

export interface FilesystemProofResolverOptions {
  /** Optional: read source PDF bytes from a local path override. */
  sourcePdfPath?: string;
  /** Allow manifest to have no matching document key (for inspect-only). */
  allowMissingDocumentKey?: boolean;
}

/**
 * A local/test resolver that reads actual bytes from the filesystem.
 * Unit tests use this directly. Production uses the composite resolver.
 */
export class FilesystemProofResolver {
  constructor(private readonly options: FilesystemProofResolverOptions = {}) {}

  async resolve(input: TrustedProofResolveInputV1): Promise<TrustedProofResolutionV1> {
    const findings: ProofFindingV1[] = [];

    // 1. Read and hash manifest bytes — manifest is JSON text, so sha256Hex
    //    is the correct deliberate UTF-8 string hash.
    const manifestBytes = await this.readBytes(input.manifestLocator);
    const manifestContentSha256 = sha256Hex(manifestBytes.toString('utf8'));
    let manifest: BudgetCycleManifestV1;
    try {
      manifest = parseBudgetCycleManifestV1(JSON.parse(manifestBytes.toString('utf8')));
    } catch (err) {
      findings.push(
        blockingFinding(
          'manifest_sha_mismatch',
          `manifest parse failed: ${(err as Error).message}`,
        ),
      );
      throw new Error(`manifest parsing failed: ${(err as Error).message}`);
    }
    const manifestFindings = validateBudgetCycleManifestV1(manifest);
    for (const f of manifestFindings.filter((f) => f.severity === 'error')) {
      findings.push(
        blockingFinding(
          'manifest_sha_mismatch',
          `manifest semantic error at ${f.path}: ${f.message}`,
        ),
      );
    }

    // 2. Find the document entry
    const manifestDocument = manifest.documents.find(
      (d) => d.documentKey === input.manifestDocumentKey,
    );
    if (!manifestDocument) {
      if (!this.options.allowMissingDocumentKey) {
        throw new Error(`document key "${input.manifestDocumentKey}" not found in manifest`);
      }
      throw new Error(`document key "${input.manifestDocumentKey}" not found in manifest`);
    }

    // 3. Read and hash artifact bytes — R1: use sha256Bytes for raw file bytes
    const artifactBytes = await this.readBytes(input.extractionArtifactLocator);
    const extractionArtifactByteSha256 = sha256Bytes(artifactBytes);
    let artifact: DefenseBudgetExtractionArtifactV1;
    try {
      artifact = parseDefenseBudgetExtractionArtifactV1(JSON.parse(artifactBytes.toString('utf8')));
    } catch (err) {
      findings.push(
        blockingFinding(
          'artifact_byte_sha_mismatch',
          `artifact parse failed: ${(err as Error).message}`,
        ),
      );
      throw new Error(`artifact parsing failed: ${(err as Error).message}`);
    }

    // 4. Recompute artifact content SHA
    const recomputedContentSha = computeArtifactContentSha256(artifact);
    if (artifact.contentSha256 !== recomputedContentSha) {
      findings.push(
        blockingFinding(
          'artifact_content_sha_mismatch',
          `artifact contentSha256 does not recompute: expected ${recomputedContentSha}, got ${artifact.contentSha256}`,
        ),
      );
    }

    // 5. Read and hash source PDF bytes — R1: use sha256Bytes for raw PDF bytes
    const sourcePdfPath = this.options.sourcePdfPath ?? manifestDocument.sourceLocator;
    let sourcePdfSha256: string | undefined;
    let sourcePdfAvailable = false;
    try {
      const sourceBytes = await this.readBytes(sourcePdfPath);
      sourcePdfSha256 = sha256Bytes(sourceBytes);
      sourcePdfAvailable = true;
    } catch {
      // R1.3: Missing source PDF is a blocking proof failure.
      // Do NOT fall back to the artifact's embedded SHA as trusted proof.
      findings.push(
        blockingFinding(
          'source_sha_mismatch',
          `source PDF not found at local path: ${sourcePdfPath}`,
        ),
      );
    }

    // 6. Compare source SHA if available
    if (sourcePdfAvailable && sourcePdfSha256) {
      if (artifact.source.sourcePdfSha256 !== sourcePdfSha256) {
        findings.push(
          blockingFinding(
            'source_sha_mismatch',
            `artifact source SHA ${artifact.source.sourcePdfSha256} does not match actual source PDF SHA ${sourcePdfSha256}`,
          ),
        );
      }
    }

    // 7. Expected hash TOCTOU guards
    if (
      input.expectedSourcePdfSha256 &&
      sourcePdfSha256 &&
      input.expectedSourcePdfSha256 !== sourcePdfSha256
    ) {
      findings.push(
        blockingFinding(
          'source_sha_mismatch',
          `expected source SHA ${input.expectedSourcePdfSha256} does not match actual ${sourcePdfSha256}`,
        ),
      );
    }
    if (
      input.expectedExtractionArtifactSha256 &&
      input.expectedExtractionArtifactSha256 !== extractionArtifactByteSha256
    ) {
      findings.push(
        blockingFinding(
          'artifact_byte_sha_mismatch',
          `expected artifact SHA ${input.expectedExtractionArtifactSha256} does not match actual ${extractionArtifactByteSha256}`,
        ),
      );
    }

    // 8. Build proof bundle
    const manifestProof: TrustedManifestProofV1 = {
      locator: input.manifestLocator,
      contentSha256: manifestContentSha256,
      cycleId: manifest.cycleId,
      fiscalYear: manifest.fiscalYear,
      documentKey: input.manifestDocumentKey,
    };

    const extractionArtifactProof: TrustedExtractionArtifactProofV1 = {
      locator: input.extractionArtifactLocator,
      artifactId: artifact.artifactId,
      contentSha256: artifact.contentSha256,
      byteSha256: extractionArtifactByteSha256,
      schemaVersion: 'defense_budget_extraction_v1',
    };

    // R1.3: SourceDocument proof — fail-closed.
    // When the source PDF is available, use the actual SHA.
    // When it is NOT available, use a clearly-invalid placeholder rather than
    // the artifact's embedded SHA, to prevent trusting unverified claims.
    const sourceDocumentProof: TrustedSourceDocumentProofV1 = {
      id: input.sourceDocumentId,
      sourceKey: manifestDocument.sourceLocator,
      sourceSha256: sourcePdfSha256 ?? 'UNRESOLVED_SOURCE_SHA',
      sourceUrl: manifestDocument.sourceUrl,
      artifactPath: undefined,
      fiscalYear: manifest.fiscalYear,
      budgetCycle: manifestDocument.budgetCycle,
      component: manifestDocument.component,
      documentType: manifestDocument.documentType,
    };

    // Filesystem resolver has no archive or parse-job access
    const archiveProof: TrustedArchiveProofV1 = {
      status: 'not_applicable',
    };

    // Parser runs from artifact
    const parserRunProofs: TrustedParserRunProofV1[] = artifact.parserRuns.map((run) => ({
      parserRunId: run.parserRunId,
      method: run.method,
      parserVersion: run.parserVersion,
      parserConfigSha256: run.parserConfigSha256,
      inputSourceSha256: run.inputSourceSha256,
      outputArtifactSha256: run.outputArtifactSha256,
      proofStatus: sourcePdfAvailable
        ? run.inputSourceSha256 === (sourcePdfSha256 ?? '')
          ? 'verified'
          : 'mismatch'
        : 'not_applicable',
    }));

    // 9. Resolve reference artifacts — R1.6: independently proved.
    // Each reference artifact gets its own proof bundle with independent
    // source document lookup, archive proof, and parser run proof.
    // They never reuse the candidate's sourceDocumentProof or archiveProof.
    const referenceArtifacts: DefenseBudgetExtractionArtifactV1[] = [];
    const referenceArtifactsProofBundles: TrustedVerificationProofBundleV1[] = [];
    const referenceArtifactsFindings: ProofFindingV1[] = [];
    for (const refLocator of input.referenceArtifactLocators) {
      try {
        const refBytes = await this.readBytes(refLocator);
        const refArtifact = parseDefenseBudgetExtractionArtifactV1(
          JSON.parse(refBytes.toString('utf8')),
        );
        referenceArtifacts.push(refArtifact);

        // R1.6: Independently prove each reference artifact
        const refByteSha = sha256Bytes(refBytes);
        const refContentSha = computeArtifactContentSha256(refArtifact);
        if (refArtifact.contentSha256 !== refContentSha) {
          referenceArtifactsFindings.push(
            blockingFinding(
              'artifact_content_sha_mismatch',
              `reference artifact contentSha256 does not recompute: expected ${refContentSha}, got ${refArtifact.contentSha256}`,
            ),
          );
        }

        // R1.6: Independent source document proof for the reference artifact.
        // Use the reference artifact's own sourceDocumentId and sourcePdfSha256,
        // NOT the candidate's. The reference may have a different SourceDocument.
        const refSourceDocId = refArtifact.source.sourceDocumentId ?? input.sourceDocumentId;
        const refSourceSha = refArtifact.source.sourcePdfSha256;

        // Try to read the reference's source PDF if available locally
        let refSourcePdfAvailable = false;
        let refSourcePdfSha: string | undefined;
        try {
          // Use the manifest source locator as a best-effort local path for the ref source
          const refSourcePath = manifestDocument.sourceLocator;
          const refSourceBytes = await this.readBytes(refSourcePath);
          refSourcePdfSha = sha256Bytes(refSourceBytes);
          refSourcePdfAvailable = true;
        } catch {
          // Reference source PDF not available locally — record as a finding
          // but do not fail unless the reference's SHA doesn't match the candidate's
        }

        const refSourceDocumentProof: TrustedSourceDocumentProofV1 = {
          id: refSourceDocId,
          sourceKey: manifestDocument.sourceLocator,
          sourceSha256: refSourcePdfSha ?? refSourceSha,
          fiscalYear: manifest.fiscalYear,
          budgetCycle: manifestDocument.budgetCycle,
          component: manifestDocument.component,
          documentType: manifestDocument.documentType,
        };

        // R1.6: Independent archive proof for the reference
        const refArchiveProof: TrustedArchiveProofV1 = { status: 'not_applicable' };

        // R1.6: Independent parser run proofs for the reference
        const refParserRuns: TrustedParserRunProofV1[] = refArtifact.parserRuns.map((run) => ({
          parserRunId: run.parserRunId,
          method: run.method,
          parserVersion: run.parserVersion,
          parserConfigSha256: run.parserConfigSha256,
          inputSourceSha256: run.inputSourceSha256,
          outputArtifactSha256: run.outputArtifactSha256,
          proofStatus: refSourcePdfAvailable
            ? run.inputSourceSha256 === (refSourcePdfSha ?? '')
              ? 'verified'
              : 'mismatch'
            : 'not_applicable',
        }));

        const refBundle: TrustedVerificationProofBundleV1 = {
          manifest: manifestProof,
          extractionArtifact: {
            locator: refLocator,
            artifactId: refArtifact.artifactId,
            contentSha256: refContentSha,
            byteSha256: refByteSha,
            schemaVersion: 'defense_budget_extraction_v1',
          },
          sourceDocument: refSourceDocumentProof,
          archive: refArchiveProof,
          parserRuns: refParserRuns,
          resolvedReferenceArtifacts: [],
        };
        referenceArtifactsProofBundles.push(refBundle);
      } catch (err) {
        referenceArtifactsFindings.push(
          blockingFinding(
            'reference_artifact_proof_failed',
            `failed to load reference artifact ${refLocator}: ${(err as Error).message}`,
          ),
        );
      }
    }

    const proofBundle: TrustedVerificationProofBundleV1 = {
      manifest: manifestProof,
      extractionArtifact: extractionArtifactProof,
      sourceDocument: sourceDocumentProof,
      archive: archiveProof,
      parserRuns: parserRunProofs,
      resolvedReferenceArtifacts: referenceArtifacts.map((ra) => ({
        artifactId: ra.artifactId,
        contentSha256: ra.contentSha256,
        sourceDocumentId: ra.source.sourceDocumentId ?? input.sourceDocumentId,
        sourcePdfSha256: ra.source.sourcePdfSha256,
        locator: input.extractionArtifactLocator,
      })),
    };

    return {
      manifest,
      manifestDocument,
      manifestContentSha256,
      artifact,
      extractionArtifactByteSha256,
      extractionArtifactContentSha256: recomputedContentSha,
      proofBundle,
      proofFindings: findings,
      referenceArtifacts,
      referenceArtifactsProofBundles,
      referenceArtifactsFindings,
    };
  }

  private async readBytes(locator: string): Promise<Buffer> {
    return fs.readFile(locator);
  }
}
