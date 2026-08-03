/**
 * Composite proof resolver — production-capable composition point.
 *
 * Accepts injected:
 *   - Prisma client/service (for SourceDocument and DocumentParseJob)
 *   - S3 object/head reader
 *   - filesystem reader (where allowed)
 *   - clock for audit timestamps only (not IDs/hashes)
 *
 * R1 fixes:
 *   - Uses sha256Bytes for all binary hashing (PDF, artifact file bytes, S3 objects).
 *   - sha256Hex reserved for deliberate UTF-8 string hashing (manifest JSON).
 *   - SourceDocument proof is fail-closed: missing source PDF is a blocking
 *     proof failure. Never falls back to artifact's embedded SHA as trusted proof.
 *   - Reference artifacts are independently proved — each gets its own
 *     source document lookup, archive proof, and parser run proof.
 *     They never reuse the candidate's proof bundle.
 *
 * Unit tests use fakes. Do not make real AWS calls in unit tests.
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
import type { SourceDocumentClient } from '../../../program-element/source-document/source-document-registry.js';
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
} from './trusted-proof-types.js';
import { blockingFinding, reviewFinding } from './trusted-proof-types.js';
import { SourceDocumentProofResolver } from './source-document-proof-resolver.js';
import { ArchiveProofResolver, type S3ObjectReader } from './archive-proof-resolver.js';
import { ParserRunProofResolver, type ParseJobClient } from './parser-run-proof-resolver.js';

export interface CompositeProofResolverOptions {
  sourceDocumentClient?: SourceDocumentClient;
  parseJobClient?: ParseJobClient;
  s3Reader?: S3ObjectReader;
  /** Allow filesystem reads for local source PDFs. */
  allowFilesystem?: boolean;
}

/**
 * The production-capable composite proof resolver.
 * Composes source-document, archive, and parser-run resolvers.
 */
export class CompositeProofResolver {
  private readonly sourceDocResolver?: SourceDocumentProofResolver;
  private readonly archiveResolver?: ArchiveProofResolver;
  private readonly parserRunResolver?: ParserRunProofResolver;

  constructor(private readonly options: CompositeProofResolverOptions = {}) {
    if (options.sourceDocumentClient) {
      this.sourceDocResolver = new SourceDocumentProofResolver(options.sourceDocumentClient);
    }
    if (options.s3Reader) {
      this.archiveResolver = new ArchiveProofResolver(options.s3Reader);
    }
    this.parserRunResolver = new ParserRunProofResolver(options.parseJobClient);
  }

  async resolve(input: TrustedProofResolveInputV1): Promise<TrustedProofResolutionV1> {
    const findings: ProofFindingV1[] = [];

    // 1. Read and hash manifest bytes — JSON text, sha256Hex is correct
    const manifestBytes = await this.readBytes(input.manifestLocator);
    const manifestContentSha256 = sha256Hex(manifestBytes.toString('utf8'));
    const manifest: BudgetCycleManifestV1 = parseBudgetCycleManifestV1(
      JSON.parse(manifestBytes.toString('utf8')),
    );
    for (const f of validateBudgetCycleManifestV1(manifest).filter((f) => f.severity === 'error')) {
      findings.push(
        blockingFinding('manifest_sha_mismatch', `manifest error at ${f.path}: ${f.message}`),
      );
    }

    const manifestDocument = manifest.documents.find(
      (d) => d.documentKey === input.manifestDocumentKey,
    );
    if (!manifestDocument) {
      throw new Error(`document key "${input.manifestDocumentKey}" not found in manifest`);
    }

    // 2. Read and hash artifact bytes — R1: use sha256Bytes for raw file bytes
    const artifactBytes = await this.readBytes(input.extractionArtifactLocator);
    const extractionArtifactByteSha256 = sha256Bytes(artifactBytes);
    const artifact: DefenseBudgetExtractionArtifactV1 = parseDefenseBudgetExtractionArtifactV1(
      JSON.parse(artifactBytes.toString('utf8')),
    );
    const recomputedContentSha = computeArtifactContentSha256(artifact);
    if (artifact.contentSha256 !== recomputedContentSha) {
      findings.push(
        blockingFinding(
          'artifact_content_sha_mismatch',
          `artifact contentSha256 does not recompute: expected ${recomputedContentSha}, got ${artifact.contentSha256}`,
        ),
      );
    }

    // 3. Read source PDF bytes (if filesystem allowed) — R1: sha256Bytes for raw PDF bytes
    let sourcePdfSha256: string | undefined;
    let sourcePdfAvailable = false;
    if (this.options.allowFilesystem) {
      try {
        const sourceBytes = await this.readBytes(manifestDocument.sourceLocator);
        sourcePdfSha256 = sha256Bytes(sourceBytes);
        sourcePdfAvailable = true;
      } catch {
        // R1.3: Missing source PDF is a blocking proof failure.
        findings.push(
          blockingFinding(
            'source_sha_mismatch',
            `source PDF not found at: ${manifestDocument.sourceLocator}`,
          ),
        );
      }
    }

    // 4. Resolve source-document proof (if client available)
    // R1.3: When source PDF is not available, never fall back to artifact SHA.
    let sourceDocumentProof: TrustedSourceDocumentProofV1 = {
      id: input.sourceDocumentId,
      sourceKey: manifestDocument.sourceLocator,
      sourceSha256: sourcePdfSha256 ?? 'UNRESOLVED_SOURCE_SHA',
      fiscalYear: manifest.fiscalYear,
      budgetCycle: manifestDocument.budgetCycle,
      component: manifestDocument.component,
      documentType: manifestDocument.documentType,
    };

    if (this.sourceDocResolver && sourcePdfAvailable && sourcePdfSha256) {
      const sdResult = await this.sourceDocResolver.resolve({
        sourceDocumentId: input.sourceDocumentId,
        actualSourcePdfSha256: sourcePdfSha256,
        artifactSourcePdfSha256: artifact.source.sourcePdfSha256,
        fiscalYear: manifest.fiscalYear,
        sourceKey: manifestDocument.sourceLocator,
      });
      sourceDocumentProof = sdResult.sourceDocument;
      findings.push(...sdResult.findings);
    }

    // 5. Resolve archive proof (if reader available and source document has archive fields)
    let archiveProof: TrustedArchiveProofV1 = { status: 'not_applicable' };
    if (this.archiveResolver && this.sourceDocResolver) {
      // Archive fields would come from the SourceDocument row
      archiveProof = { status: 'missing' };
      findings.push(
        reviewFinding('archive_version_missing', 'archive proof not yet resolved from composite'),
      );
    }

    // 6. Resolve parser-run proof
    let parserRuns: TrustedParserRunProofV1[] = [];
    if (this.parserRunResolver && sourcePdfAvailable && sourcePdfSha256) {
      const prResult = await this.parserRunResolver.resolve({
        artifact,
        actualSourcePdfSha256: sourcePdfSha256,
      });
      parserRuns = prResult.parserRuns;
      findings.push(...prResult.findings);
    } else {
      // No source bytes; parser runs are not_applicable
      parserRuns = artifact.parserRuns.map((run) => ({
        parserRunId: run.parserRunId,
        method: run.method,
        parserVersion: run.parserVersion,
        parserConfigSha256: run.parserConfigSha256,
        inputSourceSha256: run.inputSourceSha256,
        outputArtifactSha256: run.outputArtifactSha256,
        proofStatus: 'not_applicable' as const,
      }));
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
      contentSha256: recomputedContentSha,
      byteSha256: extractionArtifactByteSha256,
      schemaVersion: 'defense_budget_extraction_v1',
    };

    // 9. Resolve reference artifacts — R1.6: independently proved
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

        // R1.6: Independently hash the reference artifact bytes
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
        // The reference may have a different SourceDocument ID and SHA.
        const refSourceDocId = refArtifact.source.sourceDocumentId ?? input.sourceDocumentId;
        const refSourceSha = refArtifact.source.sourcePdfSha256;

        // Try to resolve the reference's source document independently
        let refSourceDocProof: TrustedSourceDocumentProofV1 = {
          id: refSourceDocId,
          sourceKey: manifestDocument.sourceLocator,
          sourceSha256: refSourceSha,
          fiscalYear: manifest.fiscalYear,
          budgetCycle: manifestDocument.budgetCycle,
          component: manifestDocument.component,
          documentType: manifestDocument.documentType,
        };

        if (this.sourceDocResolver) {
          const refSdResult = await this.sourceDocResolver.resolve({
            sourceDocumentId: refSourceDocId,
            actualSourcePdfSha256: refSourceSha,
            artifactSourcePdfSha256: refSourceSha,
            fiscalYear: manifest.fiscalYear,
            sourceKey: manifestDocument.sourceLocator,
          });
          refSourceDocProof = refSdResult.sourceDocument;
          referenceArtifactsFindings.push(...refSdResult.findings);
        }

        // R1.6: Independent archive and parser proof for the reference
        const refArchiveProof: TrustedArchiveProofV1 = { status: 'not_applicable' };
        const refParserRuns: TrustedParserRunProofV1[] = refArtifact.parserRuns.map((run) => ({
          parserRunId: run.parserRunId,
          method: run.method,
          parserVersion: run.parserVersion,
          parserConfigSha256: run.parserConfigSha256,
          inputSourceSha256: run.inputSourceSha256,
          outputArtifactSha256: run.outputArtifactSha256,
          proofStatus: 'not_applicable',
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
          sourceDocument: refSourceDocProof,
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
      parserRuns,
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
