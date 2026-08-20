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

    // 9. Resolve reference artifacts — R1.6 + R8.2-D: independently proved.
    // Each reference artifact gets its own proof bundle with independent
    // manifest resolution, source document lookup, archive proof, and parser
    // run proof. They never reuse the candidate's proof bundle, never
    // initialize their source SHA from the artifact itself, and never
    // continue on the candidate's manifest entry when their own document
    // key names a different entry.
    const referenceArtifacts: DefenseBudgetExtractionArtifactV1[] = [];
    const referenceArtifactsProofBundles: TrustedVerificationProofBundleV1[] = [];
    const referenceArtifactsFindings: ProofFindingV1[] = [];
    for (const refDesc of input.referenceArtifacts ?? []) {
      const refLocator = refDesc.artifactLocator;
      // R8.2-D: findings pushed while proving THIS reference are tagged with
      // its identity so comparison exclusion and audit review can attribute
      // them exactly.
      const findingsStart = referenceArtifactsFindings.length;
      const tagNewFindings = (artifactId?: string) => {
        for (let i = findingsStart; i < referenceArtifactsFindings.length; i++) {
          const f = referenceArtifactsFindings[i]!;
          if (!f.artifactId && artifactId) f.artifactId = artifactId;
          if (!f.sourceDocumentId) f.sourceDocumentId = refDesc.sourceDocumentId;
          if (!f.locator) f.locator = refLocator;
        }
      };
      try {
        const refBytes = await this.readBytes(refLocator);
        const refArtifact = parseDefenseBudgetExtractionArtifactV1(
          JSON.parse(refBytes.toString('utf8')),
        );

        // R8.2-D: resolve the reference's OWN manifest and document entry.
        // The manifest locator defaults only to the candidate manifest
        // locator; the document key is mandatory and governs the reference.
        const refManifestLocator = refDesc.manifestLocator ?? input.manifestLocator;
        const refManifestBytes = await this.readBytes(refManifestLocator);
        const refManifest = parseBudgetCycleManifestV1(
          JSON.parse(refManifestBytes.toString('utf8')),
        );
        const refManifestDocument = refManifest.documents.find(
          (d) => d.documentKey === refDesc.manifestDocumentKey,
        );
        if (!refManifestDocument) {
          referenceArtifactsFindings.push(
            blockingFinding(
              'reference_artifact_proof_failed',
              `reference ${refArtifact.artifactId}: document key "${refDesc.manifestDocumentKey}" not found in manifest ${refManifestLocator}`,
            ),
          );
          tagNewFindings(refArtifact.artifactId);
          continue;
        }

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

        // R8.2-D: the reference source SHA is NEVER initialized from the
        // reference artifact's own claims. Read the reference's own source
        // bytes through its own manifest document entry.
        let refSourcePdfAvailable = false;
        let refSourcePdfSha: string | undefined;
        try {
          const refSourcePath = refManifestDocument.sourceLocator;
          const refSourceBytes = await this.readBytes(refSourcePath);
          refSourcePdfSha = sha256Bytes(refSourceBytes);
          refSourcePdfAvailable = true;
        } catch {
          // R8.2-D: fail closed — an unavailable authoritative source means
          // the reference cannot satisfy a production-grade comparison.
          referenceArtifactsFindings.push(
            blockingFinding(
              'reference_artifact_proof_failed',
              `reference ${refArtifact.artifactId}: source bytes unavailable at ${refManifestDocument.sourceLocator}`,
            ),
          );
        }

        if (refSourcePdfAvailable && refSourcePdfSha) {
          if (refArtifact.source.sourcePdfSha256 !== refSourcePdfSha) {
            referenceArtifactsFindings.push(
              blockingFinding(
                'source_sha_mismatch',
                `reference artifact ${refArtifact.artifactId} source SHA ${refArtifact.source.sourcePdfSha256} does not match actual source SHA ${refSourcePdfSha}`,
              ),
            );
          }
        }

        const refSourceDocumentProof: TrustedSourceDocumentProofV1 = {
          id: refDesc.sourceDocumentId,
          sourceKey: refManifestDocument.sourceLocator,
          // Never fall back to the artifact-asserted SHA: unresolved stays
          // unresolved so comparison cannot pass on an unproved reference.
          sourceSha256: refSourcePdfSha ?? 'UNRESOLVED_SOURCE_SHA',
          fiscalYear: refManifest.fiscalYear,
          budgetCycle: refManifestDocument.budgetCycle,
          component: refManifestDocument.component,
          documentType: refManifestDocument.documentType,
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

        const refManifestProof: TrustedManifestProofV1 = {
          locator: refManifestLocator,
          contentSha256: sha256Hex(refManifestBytes.toString('utf8')),
          cycleId: refManifest.cycleId,
          fiscalYear: refManifest.fiscalYear,
          documentKey: refDesc.manifestDocumentKey,
        };

        const refBundle: TrustedVerificationProofBundleV1 = {
          manifest: refManifestProof,
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

        // Tag findings accumulated for this reference with its identity.
        tagNewFindings(refArtifact.artifactId);

        referenceArtifacts.push(refArtifact);
        referenceArtifactsProofBundles.push(refBundle);
      } catch (err) {
        referenceArtifactsFindings.push(
          blockingFinding(
            'reference_artifact_proof_failed',
            `failed to load reference artifact ${refLocator}: ${(err as Error).message}`,
            { sourceDocumentId: refDesc.sourceDocumentId, locator: refLocator },
          ),
        );
        tagNewFindings();
      }
    }

    const proofBundle: TrustedVerificationProofBundleV1 = {
      manifest: manifestProof,
      extractionArtifact: extractionArtifactProof,
      sourceDocument: sourceDocumentProof,
      archive: archiveProof,
      parserRuns: parserRunProofs,
      resolvedReferenceArtifacts: referenceArtifactsProofBundles.map((bundle) => ({
        artifactId: bundle.extractionArtifact.artifactId,
        contentSha256: bundle.extractionArtifact.contentSha256,
        sourceDocumentId: bundle.sourceDocument.id,
        sourcePdfSha256: bundle.sourceDocument.sourceSha256,
        locator: bundle.extractionArtifact.locator,
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
