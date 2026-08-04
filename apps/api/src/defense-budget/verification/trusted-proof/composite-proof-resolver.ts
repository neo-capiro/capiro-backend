/**
 * Composite proof resolver — production-capable composition point.
 *
 * Accepts injected:
 *   - TrustedByteLocatorReader (filesystem + S3)
 *   - SourceDocument client (for SourceDocument row loading)
 *   - ParseJobClient (for parser-run proof)
 *   - S3ObjectReader (for archive-head verification)
 *   - clock for audit timestamps only (not IDs/hashes)
 *
 * Unit tests use fakes. Do not make real AWS calls in unit tests.
 */
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
import { sha256Hex } from '../../contracts/canonical-json.js';
import type { SourceDocumentClient } from '../../../program-element/source-document/source-document-registry.js';
import type {
  TrustedProofResolveInputV1,
  TrustedProofResolutionV1,
  ProofFindingV1,
  ProofResolverMode,
  TrustedVerificationProofBundleV1,
  TrustedManifestProofV1,
  TrustedExtractionArtifactProofV1,
  TrustedSourceDocumentProofV1,
  TrustedArchiveProofV1,
  TrustedParserRunProofV1,
  TrustedReferenceArtifactProofV1,
} from './trusted-proof-types.js';
import { blockingFinding, reviewFinding } from './trusted-proof-types.js';
import { SourceDocumentProofResolver } from './source-document-proof-resolver.js';
import { ArchiveProofResolver, type S3ObjectReader } from './archive-proof-resolver.js';
import { ParserRunProofResolver, type ParseJobClient } from './parser-run-proof-resolver.js';
import type {
  TrustedByteLocatorReader,
  TrustedLocatedBytes,
} from './trusted-byte-locator-reader.js';
import { sha256Bytes } from './trusted-byte-locator-reader.js';
import { TrustedProofResolutionError } from './trusted-proof-types.js';
import { lookupPolicy } from '../verification-policy-registry.js';

export interface CompositeProofResolverOptions {
  sourceDocumentClient?: SourceDocumentClient;
  parseJobClient?: ParseJobClient;
  s3Reader?: S3ObjectReader;
  /** Trusted byte locator reader. Required in production_proof mode. */
  byteLocatorReader?: TrustedByteLocatorReader;
  /** Operation mode: local_inspect (default) or production_proof. */
  mode?: ProofResolverMode;
}

/**
 * The production-capable composite proof resolver.
 * Composes source-document, archive, and parser-run resolvers
 * with a trusted byte locator reader.
 */
export class CompositeProofResolver {
  private readonly sourceDocResolver?: SourceDocumentProofResolver;
  private readonly archiveResolver?: ArchiveProofResolver;
  private readonly parserRunResolver?: ParserRunProofResolver;
  private readonly mode: ProofResolverMode;

  constructor(private readonly options: CompositeProofResolverOptions = {}) {
    this.mode = options.mode ?? 'local_inspect';
    if (options.sourceDocumentClient) {
      this.sourceDocResolver = new SourceDocumentProofResolver(options.sourceDocumentClient);
    }
    if (options.s3Reader) {
      this.archiveResolver = new ArchiveProofResolver(options.s3Reader);
    }
    this.parserRunResolver = new ParserRunProofResolver(options.parseJobClient);
  }

  async resolve(input: TrustedProofResolveInputV1): Promise<TrustedProofResolutionV1> {
    // R8.1 §2.2: production_proof requires all mandatory dependencies before
    // any proof bundle is produced.
    if (this.mode === 'production_proof') {
      if (!this.options.sourceDocumentClient) {
        throw new TrustedProofResolutionError(
          'production_proof mode requires sourceDocumentClient',
        );
      }
      if (!this.options.byteLocatorReader) {
        throw new TrustedProofResolutionError('production_proof mode requires byteLocatorReader');
      }
    }

    const findings: ProofFindingV1[] = [];

    // 1. Read and hash manifest bytes through locator reader
    const manifestLocated = await this.readBytesWithReader(input.manifestLocator);
    const manifestContentSha256 = sha256Bytes(manifestLocated.bytes);
    const manifest: BudgetCycleManifestV1 = parseBudgetCycleManifestV1(
      JSON.parse(manifestLocated.bytes.toString('utf8')),
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

    // R8.1 §2.2/§2.5: resolve the policy so archive/parser dependency
    // requirements are known before proof resolution completes.
    const resolvedPolicy = lookupPolicy(manifestDocument.family, manifestDocument.exhibit);
    const requireImmutableArchive = resolvedPolicy?.requireImmutableArchive ?? false;
    const requireParserRunProof = resolvedPolicy?.requireParserRunProof ?? false;

    // R8.1 §2.2: policy-required dependencies must exist in production mode.
    if (this.mode === 'production_proof') {
      if (requireParserRunProof && !this.options.parseJobClient) {
        throw new TrustedProofResolutionError(
          `production_proof mode requires parseJobClient (policy ${manifestDocument.family}/${manifestDocument.exhibit} requires parser-run proof)`,
        );
      }
      if (requireImmutableArchive && !this.options.s3Reader) {
        throw new TrustedProofResolutionError(
          `production_proof mode requires s3Reader (policy ${manifestDocument.family}/${manifestDocument.exhibit} requires immutable archive)`,
        );
      }
    }

    // 2. Read and hash artifact bytes
    const artifactLocated = await this.readBytesWithReader(input.extractionArtifactLocator);
    const extractionArtifactByteSha256 = sha256Bytes(artifactLocated.bytes);
    const artifact: DefenseBudgetExtractionArtifactV1 = parseDefenseBudgetExtractionArtifactV1(
      JSON.parse(artifactLocated.bytes.toString('utf8')),
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

    // 3. Load SourceDocument in production mode
    let sourceDocumentProof: TrustedSourceDocumentProofV1;
    let sourceDocRow: Awaited<ReturnType<SourceDocumentClient['sourceDocument']['findFirst']>> =
      null;
    let sourcePdfLocated: TrustedLocatedBytes | null = null;

    if (this.sourceDocResolver) {
      // Load SourceDocument row by ID
      const sdResult = await this.sourceDocResolver.resolveWithRow({
        sourceDocumentId: input.sourceDocumentId,
        actualSourcePdfSha256: '', // Will be filled in after reading bytes
        artifactSourcePdfSha256: artifact.source.sourcePdfSha256,
        fiscalYear: manifest.fiscalYear,
        sourceKey: manifestDocument.sourceLocator,
      });
      sourceDocumentProof = sdResult.sourceDocument;
      sourceDocRow = sdResult.row;
      findings.push(...sdResult.findings);

      // If SourceDocument has an authoritative locator (S3 or filesystem), read through it
      if (sourceDocRow) {
        const authLocator = this.resolveAuthoritativeLocator(sourceDocRow);
        if (authLocator) {
          try {
            sourcePdfLocated = await this.readBytesWithReader(authLocator);
          } catch (err) {
            findings.push(
              blockingFinding(
                'source_document_not_found',
                `failed to read authoritative source locator "${authLocator}": ${(err as Error).message}`,
              ),
            );
          }
        }
      }

      // Fall back to manifest sourceLocator for local_inspect
      if (!sourcePdfLocated && this.mode === 'local_inspect') {
        try {
          sourcePdfLocated = await this.readBytesWithReader(manifestDocument.sourceLocator);
        } catch {
          findings.push(
            reviewFinding(
              'source_sha_mismatch',
              `source PDF not found at: ${manifestDocument.sourceLocator}`,
            ),
          );
        }
      }
    } else {
      // No source document client — build proof from manifest/artifact metadata
      sourceDocumentProof = {
        id: input.sourceDocumentId,
        sourceKey: manifestDocument.sourceLocator,
        sourceSha256: artifact.source.sourcePdfSha256,
        fiscalYear: manifest.fiscalYear,
        budgetCycle: manifestDocument.budgetCycle,
        component: manifestDocument.component,
        documentType: manifestDocument.documentType,
      };

      // Local inspect: try filesystem
      try {
        sourcePdfLocated = await this.readBytesWithReader(manifestDocument.sourceLocator);
      } catch {
        findings.push(
          reviewFinding(
            'source_sha_mismatch',
            `source PDF not found at: ${manifestDocument.sourceLocator}`,
          ),
        );
      }
    }

    // R8.1 §2.1: production_proof must never fall back to the artifact-asserted
    // source SHA. If authoritative source bytes could not be resolved, fail.
    if (this.mode === 'production_proof' && !sourcePdfLocated) {
      throw new TrustedProofResolutionError(
        'authoritative source bytes could not be resolved for production proof ' +
          `(sourceDocumentId=${input.sourceDocumentId})`,
      );
    }

    const actualSourceSha256 = sourcePdfLocated
      ? sha256Bytes(sourcePdfLocated.bytes)
      : artifact.source.sourcePdfSha256;

    // R8.1 §2.4: SourceDocument metadata must agree with manifest + artifact.
    if (this.mode === 'production_proof' && sourceDocRow) {
      const row = sourceDocRow as Record<string, unknown>;
      if (row.sourceKey != null && row.sourceKey !== manifestDocument.sourceLocator) {
        findings.push(
          blockingFinding(
            'source_metadata_mismatch',
            `SourceDocument sourceKey "${String(row.sourceKey)}" does not match manifest sourceLocator "${manifestDocument.sourceLocator}"`,
          ),
        );
      }
      if (row.fiscalYear != null && row.fiscalYear !== manifest.fiscalYear) {
        findings.push(
          blockingFinding(
            'source_metadata_mismatch',
            `SourceDocument fiscalYear ${String(row.fiscalYear)} does not match manifest fiscalYear ${manifest.fiscalYear}`,
          ),
        );
      }
      if (row.component != null && row.component !== manifestDocument.component) {
        findings.push(
          blockingFinding(
            'source_metadata_mismatch',
            `SourceDocument component "${String(row.component)}" does not match manifest component "${manifestDocument.component}"`,
          ),
        );
      }
      if (row.budgetCycle != null && row.budgetCycle !== manifestDocument.budgetCycle) {
        findings.push(
          blockingFinding(
            'source_metadata_mismatch',
            `SourceDocument budgetCycle "${String(row.budgetCycle)}" does not match manifest budgetCycle "${manifestDocument.budgetCycle}"`,
          ),
        );
      }
      if (row.documentType != null && row.documentType !== manifestDocument.documentType) {
        findings.push(
          blockingFinding(
            'source_metadata_mismatch',
            `SourceDocument documentType "${String(row.documentType)}" does not match manifest documentType "${manifestDocument.documentType}"`,
          ),
        );
      }
      if (row.sha256 != null && sourcePdfLocated && row.sha256 !== actualSourceSha256) {
        findings.push(
          blockingFinding(
            'source_metadata_mismatch',
            `SourceDocument stored SHA ${String(row.sha256)} does not match resolved source bytes SHA ${actualSourceSha256}`,
          ),
        );
      }
      if (row.id !== input.sourceDocumentId) {
        findings.push(
          blockingFinding(
            'source_metadata_mismatch',
            `SourceDocument row id "${String(row.id)}" does not match requested sourceDocumentId "${input.sourceDocumentId}"`,
          ),
        );
      }
    }

    // Re-resolve source document with actual SHA if we have bytes
    if (this.sourceDocResolver && sourceDocRow && sourcePdfLocated) {
      const sdResult2 = await this.sourceDocResolver.resolve({
        sourceDocumentId: input.sourceDocumentId,
        actualSourcePdfSha256: actualSourceSha256,
        artifactSourcePdfSha256: artifact.source.sourcePdfSha256,
        fiscalYear: manifest.fiscalYear,
        sourceKey: manifestDocument.sourceLocator,
      });
      sourceDocumentProof = sdResult2.sourceDocument;
      findings.push(...sdResult2.findings);
    }

    // 4. Verify artifact source SHA matches actual
    if (actualSourceSha256 !== artifact.source.sourcePdfSha256) {
      findings.push(
        blockingFinding(
          'artifact_source_sha_mismatch',
          `artifact source SHA ${artifact.source.sourcePdfSha256} does not match actual ${actualSourceSha256}`,
        ),
      );
    }

    // 5. Resolve archive proof from SourceDocument archive fields
    let archiveProof: TrustedArchiveProofV1 = { status: 'not_applicable' };
    if (this.archiveResolver && sourceDocRow) {
      const archiveInput = {
        archiveBucket: (sourceDocRow as Record<string, unknown>).archiveBucket as
          | string
          | null
          | undefined,
        archiveS3Key: (sourceDocRow as Record<string, unknown>).archiveS3Key as
          | string
          | null
          | undefined,
        archiveVersionId: (sourceDocRow as Record<string, unknown>).archiveVersionId as
          | string
          | null
          | undefined,
        archiveKmsKeyArn: (sourceDocRow as Record<string, unknown>).archiveKmsKeyArn as
          | string
          | null
          | undefined,
        retainUntil: (sourceDocRow as Record<string, unknown>).retainUntil as
          | Date
          | null
          | undefined,
        archivedAt: (sourceDocRow as Record<string, unknown>).archivedAt as Date | null | undefined,
        expectedSourceSha256: actualSourceSha256,
        requireImmutableArchive,
      };
      const archiveResult = await this.archiveResolver.resolve(archiveInput);
      archiveProof = archiveResult.archive;
      for (const f of archiveResult.findings) {
        findings.push({
          ...f,
          artifactId: artifact.artifactId,
          sourceDocumentId: input.sourceDocumentId,
        });
      }
    } else if (this.archiveResolver) {
      // No source document row but archive resolver exists — check if source is in S3
      if (sourcePdfLocated?.kind === 's3' && sourcePdfLocated.bucket && sourcePdfLocated.key) {
        const archiveInput = {
          archiveBucket: sourcePdfLocated.bucket,
          archiveS3Key: sourcePdfLocated.key,
          archiveVersionId: sourcePdfLocated.versionId,
          archiveKmsKeyArn: sourcePdfLocated.kmsKeyArn,
          expectedSourceSha256: actualSourceSha256,
          requireImmutableArchive,
        };
        const archiveResult = await this.archiveResolver.resolve(archiveInput);
        archiveProof = archiveResult.archive;
        for (const f of archiveResult.findings) {
          findings.push({
            ...f,
            artifactId: artifact.artifactId,
            sourceDocumentId: input.sourceDocumentId,
          });
        }
      }
    }

    // 6. Resolve parser-run proof
    let parserRuns: TrustedParserRunProofV1[] = [];
    if (this.parserRunResolver && actualSourceSha256) {
      const prResult = await this.parserRunResolver.resolve({
        artifact,
        actualSourcePdfSha256: actualSourceSha256,
      });
      parserRuns = prResult.parserRuns;
      findings.push(...prResult.findings);
    } else {
      // No parser-run resolver — proof not independently established.
      parserRuns = artifact.parserRuns.map((run) => ({
        parserRunId: run.parserRunId,
        method: run.method,
        parserVersion: run.parserVersion,
        parserConfigSha256: run.parserConfigSha256,
        inputSourceSha256: run.inputSourceSha256,
        outputArtifactSha256: run.outputArtifactSha256,
        proofStatus: 'not_applicable' as const,
      }));
      // R8.1 §2.2/§2.6: when policy requires parser-run proof, a resolver is
      // mandatory — never silently mark not_applicable.
      if (requireParserRunProof) {
        if (this.mode === 'production_proof') {
          throw new TrustedProofResolutionError(
            'policy requires parser-run proof but no parser-run resolver could run',
          );
        }
        findings.push(
          blockingFinding(
            'parse_job_missing',
            'policy requires parser-run proof but no parser-run resolver is configured',
          ),
        );
      }
    }

    // 7. Expected hash TOCTOU guards
    if (input.expectedSourcePdfSha256 && input.expectedSourcePdfSha256 !== actualSourceSha256) {
      findings.push(
        blockingFinding(
          'source_sha_mismatch',
          `expected source SHA ${input.expectedSourcePdfSha256} does not match actual ${actualSourceSha256}`,
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

    // 8. Build manifest and artifact proof
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

    // 9. Resolve reference artifacts independently
    const referenceArtifacts: DefenseBudgetExtractionArtifactV1[] = [];
    const referenceArtifactsProofBundles: TrustedVerificationProofBundleV1[] = [];
    const referenceArtifactsFindings: ProofFindingV1[] = [];

    // References must use the structured descriptor form; every reference
    // carries its own explicit SourceDocument identity.
    const refDescriptors = input.referenceArtifacts ?? [];

    for (const refDesc of refDescriptors) {
      try {
        // Read reference artifact bytes through locator reader
        const refLocated = await this.readBytesWithReader(refDesc.artifactLocator);
        const refArtifact = parseDefenseBudgetExtractionArtifactV1(
          JSON.parse(refLocated.bytes.toString('utf8')),
        );
        const refByteSha = sha256Bytes(refLocated.bytes);

        // Recompute reference content SHA
        const refContentSha = computeArtifactContentSha256(refArtifact);
        if (refArtifact.contentSha256 !== refContentSha) {
          referenceArtifactsFindings.push(
            blockingFinding(
              'artifact_content_sha_mismatch',
              `reference artifact ${refArtifact.artifactId} content SHA mismatch`,
              undefined,
            ),
          );
        }

        // Resolve reference's own source proof
        let refSourceProof: TrustedSourceDocumentProofV1;
        let refArchiveProof: TrustedArchiveProofV1 = { status: 'not_applicable' };
        let refParserRuns: TrustedParserRunProofV1[] = [];

        if (this.sourceDocResolver) {
          // Independently resolve the reference's own source document. A
          // reference may identify the same official document as the
          // candidate, but it still executes the proof process against that
          // document independently — never reusing the candidate's proof.
          const refSdResult = await this.sourceDocResolver.resolveWithRow({
            sourceDocumentId: refDesc.sourceDocumentId,
            actualSourcePdfSha256: '', // Will be filled
            artifactSourcePdfSha256: refArtifact.source.sourcePdfSha256,
          });
          refSourceProof = refSdResult.sourceDocument;
          const refSdRow = refSdResult.row;

          // Tag findings with reference artifact ID
          for (const f of refSdResult.findings) {
            referenceArtifactsFindings.push({
              ...f,
              artifactId: refArtifact.artifactId,
              sourceDocumentId: refDesc.sourceDocumentId,
            });
          }

          // Resolve reference source bytes
          let refSourceSha = refArtifact.source.sourcePdfSha256;
          if (refSdRow) {
            const refAuthLocator = this.resolveAuthoritativeLocator(refSdRow);
            if (refAuthLocator) {
              try {
                const refSourceLocated = await this.readBytesWithReader(refAuthLocator);
                refSourceSha = sha256Bytes(refSourceLocated.bytes);

                // Archive proof for reference
                if (this.archiveResolver) {
                  const refArchiveResult = await this.archiveResolver.resolve({
                    archiveBucket: (refSdRow as Record<string, unknown>).archiveBucket as
                      | string
                      | null
                      | undefined,
                    archiveS3Key: (refSdRow as Record<string, unknown>).archiveS3Key as
                      | string
                      | null
                      | undefined,
                    archiveVersionId: (refSdRow as Record<string, unknown>).archiveVersionId as
                      | string
                      | null
                      | undefined,
                    expectedSourceSha256: refSourceSha,
                  });
                  refArchiveProof = refArchiveResult.archive;
                  for (const f of refArchiveResult.findings) {
                    referenceArtifactsFindings.push({
                      ...f,
                      artifactId: refArtifact.artifactId,
                      sourceDocumentId: refDesc.sourceDocumentId,
                    });
                  }
                }
              } catch (err) {
                referenceArtifactsFindings.push(
                  blockingFinding(
                    'source_document_not_found',
                    `reference source not found for ${refArtifact.artifactId}: ${(err as Error).message}`,
                  ),
                );
              }
            }
          }

          // Parser-run proof for reference
          if (this.parserRunResolver && refSourceSha) {
            const refPrResult = await this.parserRunResolver.resolve({
              artifact: refArtifact,
              actualSourcePdfSha256: refSourceSha,
            });
            refParserRuns = refPrResult.parserRuns;
            for (const f of refPrResult.findings) {
              referenceArtifactsFindings.push({
                ...f,
                artifactId: refArtifact.artifactId,
                sourceDocumentId: refDesc.sourceDocumentId,
              });
            }
          }
        } else {
          // No SourceDocument client (local_inspect): build an independent
          // reference proof from the reference artifact's own claims. Never
          // reuse the candidate's source/archive/parser proof.
          refSourceProof = {
            id: refDesc.sourceDocumentId,
            sourceKey: manifestDocument.sourceLocator,
            sourceSha256: refArtifact.source.sourcePdfSha256,
            fiscalYear: manifest.fiscalYear,
            budgetCycle: manifestDocument.budgetCycle,
            component: manifestDocument.component,
            documentType: manifestDocument.documentType,
          };
          refArchiveProof = { status: 'not_applicable' };
          refParserRuns = refArtifact.parserRuns.map((run) => ({
            parserRunId: run.parserRunId,
            method: run.method,
            parserVersion: run.parserVersion,
            parserConfigSha256: run.parserConfigSha256,
            inputSourceSha256: run.inputSourceSha256,
            outputArtifactSha256: run.outputArtifactSha256,
            proofStatus: 'not_applicable' as const,
          }));
        }

        referenceArtifacts.push(refArtifact);

        const refBundle: TrustedVerificationProofBundleV1 = {
          manifest: manifestProof,
          extractionArtifact: {
            locator: refDesc.artifactLocator,
            artifactId: refArtifact.artifactId,
            contentSha256: refContentSha,
            byteSha256: refByteSha,
            schemaVersion: 'defense_budget_extraction_v1',
          },
          sourceDocument: refSourceProof,
          archive: refArchiveProof,
          parserRuns: refParserRuns,
          resolvedReferenceArtifacts: [],
        };
        referenceArtifactsProofBundles.push(refBundle);
      } catch (err) {
        referenceArtifactsFindings.push(
          reviewFinding(
            'reference_artifact_proof_failed',
            `failed to load reference artifact ${refDesc.artifactLocator}: ${(err as Error).message}`,
          ),
        );
      }
    }

    // Build resolved reference artifact list with correct locators
    const resolvedRefs: TrustedReferenceArtifactProofV1[] = referenceArtifactsProofBundles.map(
      (bundle, i) => ({
        artifactId: bundle.extractionArtifact.artifactId,
        contentSha256: bundle.extractionArtifact.contentSha256,
        sourceDocumentId: bundle.sourceDocument.id,
        sourcePdfSha256: bundle.sourceDocument.sourceSha256,
        locator: bundle.extractionArtifact.locator, // Uses reference's own locator, not candidate's
      }),
    );

    const proofBundle: TrustedVerificationProofBundleV1 = {
      manifest: manifestProof,
      extractionArtifact: extractionArtifactProof,
      sourceDocument: sourceDocumentProof,
      archive: archiveProof,
      parserRuns,
      resolvedReferenceArtifacts: resolvedRefs,
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

  /**
   * Read bytes through the trusted byte locator reader.
   * Falls back to fs.readFile for backward compat when no reader is configured.
   */
  private async readBytesWithReader(locator: string): Promise<TrustedLocatedBytes> {
    if (this.options.byteLocatorReader) {
      return this.options.byteLocatorReader.read(locator);
    }
    // Backward compat: direct filesystem read
    const fs = await import('node:fs/promises');
    const bytes = await fs.readFile(locator);
    return {
      locator,
      bytes,
      kind: 'filesystem',
      contentLength: bytes.length,
      checksumSha256: sha256Bytes(bytes),
    };
  }

  /**
   * R8.1 §2.3 — Resolve the authoritative locator from a SourceDocument row
   * using an explicit priority, with no silent fallback:
   *   1. versioned S3 archive locator;
   *   2. approved immutable artifact path;
   *   3. approved source URL handled by a dedicated trusted reader.
   * Returns a discriminated result so the caller can fail closed when the
   * selected source is unavailable rather than dropping to a weaker source.
   */
  private resolveAuthoritativeLocator(row: Record<string, unknown>): string | null {
    const bucket = row.archiveBucket as string | null | undefined;
    const key = row.archiveS3Key as string | null | undefined;
    const versionId = row.archiveVersionId as string | null | undefined;

    // Priority 1: versioned S3 archive locator
    if (bucket && key && versionId) {
      return `s3://${bucket}/${key}?versionId=${encodeURIComponent(versionId)}`;
    }

    // Priority 2: approved immutable artifact path
    const artifactPath = row.artifactPath as string | null | undefined;
    if (artifactPath) return artifactPath;

    // Priority 3: approved source URL — only when the configured byte reader
    // can handle it (the reader fails closed on unsupported schemes).
    const sourceUrl = row.sourceUrl as string | null | undefined;
    if (sourceUrl && this.options.byteLocatorReader) return sourceUrl;

    return null;
  }
}
