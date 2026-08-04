/**
 * Composite proof resolver — production-capable composition point.
 *
 * Accepts injected:
 *   - TrustedByteLocatorReader (filesystem + S3)
 *   - SourceDocument client (for SourceDocument row loading)
 *   - ParseJobClient (for parser-run proof)
 *   - ParserOutputProofSource (R8.2-C: independent parser output bytes)
 *   - S3ObjectReader (for archive-head verification)
 *   - clock for audit timestamps only (not IDs/hashes)
 *
 * R8.2 Workstream D: candidate and reference artifacts are proved by ONE
 * shared method (`resolveSingleArtifactProof`). There is no separate,
 * weaker reference trust path:
 *
 *   - every reference must carry its own SourceDocument ID (never defaulted)
 *     and its own mandatory manifest document key;
 *   - a reference's `manifestLocator` defaults ONLY to the candidate
 *     manifest locator; a separate manifest is resolved independently;
 *   - the reference's own manifest entry governs its policy (archive /
 *     parser-run requirements);
 *   - in production mode, a required reference-proof failure produces an
 *     artifact-specific blocking finding (tagged with the reference's
 *     artifact ID, source document ID, and locator) and the reference is
 *     excluded from comparison — it can never satisfy a required
 *     production-grade comparison;
 *   - in local inspect mode a reference may be inspected without full
 *     production proof, but it likewise cannot satisfy a required
 *     production-grade comparison when its proof is incomplete.
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
import type { ParserOutputProofSource } from './parser-output-proof-source.js';
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
  /**
   * R8.2 Workstream C: source of independently persisted parser output
   * bytes. When absent, parser runs (other than manual) can never reach
   * `proofStatus: 'verified'` — they are reported `missing`.
   */
  parserOutputProofSource?: ParserOutputProofSource;
}

/* ------------------------------------------------------------------ */
/* Unified single-artifact proof resolution (R8.2-D)                   */
/* ------------------------------------------------------------------ */

export interface SingleArtifactProofInput {
  manifestLocator: string;
  manifestDocumentKey: string;
  artifactLocator: string;
  sourceDocumentId: string;
  /**
   * Candidate failures abort the whole resolution in production mode
   * (throw). Reference failures produce artifact-specific blocking
   * findings and exclude the reference from comparison.
   */
  isCandidate: boolean;
}

export interface SingleArtifactProofResult {
  manifest: BudgetCycleManifestV1;
  manifestDocument: BudgetCycleManifestDocumentV1;
  manifestContentSha256: string;
  manifestProof: TrustedManifestProofV1;
  artifact: DefenseBudgetExtractionArtifactV1;
  artifactByteSha256: string;
  artifactContentSha256: string;
  extractionArtifactProof: TrustedExtractionArtifactProofV1;
  sourceDocumentProof: TrustedSourceDocumentProofV1;
  archiveProof: TrustedArchiveProofV1;
  parserRuns: TrustedParserRunProofV1[];
  findings: ProofFindingV1[];
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
    this.parserRunResolver = new ParserRunProofResolver(
      options.parseJobClient,
      options.parserOutputProofSource,
    );
  }

  /**
   * The resolved operation mode. Read-only — exposed so the CLI wiring and
   * its tests can prove that persist mode constructs `production_proof` and
   * never the filesystem-only resolver.
   */
  get resolverMode(): ProofResolverMode {
    return this.mode;
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

    // ------------------------------------------------------------------
    // Candidate proof — the SAME unified method used for references.
    // ------------------------------------------------------------------
    const candidate = await this.resolveSingleArtifactProof({
      manifestLocator: input.manifestLocator,
      manifestDocumentKey: input.manifestDocumentKey,
      artifactLocator: input.extractionArtifactLocator,
      sourceDocumentId: input.sourceDocumentId,
      isCandidate: true,
    });

    const findings: ProofFindingV1[] = [...candidate.findings];

    // Expected hash TOCTOU guards (candidate only — operator confirmation).
    if (input.expectedSourcePdfSha256) {
      const actual = candidate.sourceDocumentProof.sourceSha256;
      if (
        actual &&
        actual !== 'UNRESOLVED_SOURCE_SHA' &&
        input.expectedSourcePdfSha256 !== actual
      ) {
        findings.push(
          blockingFinding(
            'source_sha_mismatch',
            `expected source SHA ${input.expectedSourcePdfSha256} does not match actual ${actual}`,
          ),
        );
      }
    }
    if (
      input.expectedExtractionArtifactSha256 &&
      input.expectedExtractionArtifactSha256 !== candidate.artifactByteSha256
    ) {
      findings.push(
        blockingFinding(
          'artifact_byte_sha_mismatch',
          `expected artifact SHA ${input.expectedExtractionArtifactSha256} does not match actual ${candidate.artifactByteSha256}`,
        ),
      );
    }

    // ------------------------------------------------------------------
    // Reference proofs — independently, through the SAME method.
    // ------------------------------------------------------------------
    const referenceArtifacts: DefenseBudgetExtractionArtifactV1[] = [];
    const referenceArtifactsProofBundles: TrustedVerificationProofBundleV1[] = [];
    const referenceArtifactsFindings: ProofFindingV1[] = [];

    for (const refDesc of input.referenceArtifacts ?? []) {
      const refManifestLocator = refDesc.manifestLocator ?? input.manifestLocator;
      try {
        const ref = await this.resolveSingleArtifactProof({
          manifestLocator: refManifestLocator,
          manifestDocumentKey: refDesc.manifestDocumentKey,
          artifactLocator: refDesc.artifactLocator,
          sourceDocumentId: refDesc.sourceDocumentId,
          isCandidate: false,
        });

        // Tag every finding with the reference's identity so comparison
        // exclusion and audit review can attribute it exactly.
        const taggedFindings = ref.findings.map((f) => ({
          ...f,
          artifactId: ref.artifact.artifactId,
          sourceDocumentId: refDesc.sourceDocumentId,
          locator: refDesc.artifactLocator,
        }));
        referenceArtifactsFindings.push(...taggedFindings);

        // R8.2-D: any required reference-proof failure EXCLUDES the reference
        // from comparison. It is never added to the comparison set, so it
        // can never be indexed for matching or satisfy a required
        // production-grade comparison.
        if (taggedFindings.some((f) => f.severity === 'blocking')) {
          continue;
        }

        referenceArtifacts.push(ref.artifact);
        referenceArtifactsProofBundles.push({
          manifest: ref.manifestProof,
          extractionArtifact: ref.extractionArtifactProof,
          sourceDocument: ref.sourceDocumentProof,
          archive: ref.archiveProof,
          parserRuns: ref.parserRuns,
          resolvedReferenceArtifacts: [],
        });
      } catch (err) {
        // Required reference-proof failure: artifact-specific blocking
        // finding; the reference is excluded from comparison (never indexed).
        // Best-effort: recover the reference artifactId so the finding retains
        // full reference identity even when resolution itself failed.
        let refArtifactId: string | undefined;
        try {
          const refLocated = await this.readBytesWithReader(refDesc.artifactLocator);
          const parsed = JSON.parse(refLocated.bytes.toString('utf8')) as {
            artifactId?: unknown;
          };
          if (typeof parsed.artifactId === 'string') refArtifactId = parsed.artifactId;
        } catch {
          // Artifact unreadable/unparseable — finding is still attributed by
          // locator and sourceDocumentId.
        }
        const finding = blockingFinding(
          'reference_artifact_proof_failed',
          `failed to prove reference artifact at ${refDesc.artifactLocator}: ${(err as Error).message}`,
          {
            manifestLocator: refManifestLocator,
            manifestDocumentKey: refDesc.manifestDocumentKey,
            sourceDocumentId: refDesc.sourceDocumentId,
          },
        );
        finding.artifactId = refArtifactId;
        finding.sourceDocumentId = refDesc.sourceDocumentId;
        finding.locator = refDesc.artifactLocator;
        referenceArtifactsFindings.push(finding);
      }
    }

    // Build resolved reference artifact list with correct locators
    const resolvedRefs: TrustedReferenceArtifactProofV1[] = referenceArtifactsProofBundles.map(
      (bundle) => ({
        artifactId: bundle.extractionArtifact.artifactId,
        contentSha256: bundle.extractionArtifact.contentSha256,
        sourceDocumentId: bundle.sourceDocument.id,
        sourcePdfSha256: bundle.sourceDocument.sourceSha256,
        locator: bundle.extractionArtifact.locator,
      }),
    );

    const proofBundle: TrustedVerificationProofBundleV1 = {
      manifest: candidate.manifestProof,
      extractionArtifact: candidate.extractionArtifactProof,
      sourceDocument: candidate.sourceDocumentProof,
      archive: candidate.archiveProof,
      parserRuns: candidate.parserRuns,
      resolvedReferenceArtifacts: resolvedRefs,
    };

    return {
      manifest: candidate.manifest,
      manifestDocument: candidate.manifestDocument,
      manifestContentSha256: candidate.manifestContentSha256,
      artifact: candidate.artifact,
      extractionArtifactByteSha256: candidate.artifactByteSha256,
      extractionArtifactContentSha256: candidate.artifactContentSha256,
      proofBundle,
      proofFindings: findings,
      referenceArtifacts,
      referenceArtifactsProofBundles,
      referenceArtifactsFindings,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Unified artifact proof — candidate AND references (R8.2-D)          */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the full proof for ONE artifact (candidate or reference):
   * manifest identity, artifact byte/content integrity, authoritative
   * source bytes, SourceDocument metadata agreement, archive proof when the
   * artifact's own policy requires it, and parser-run proof when its own
   * policy requires it.
   *
   * Candidate failures abort the resolution in production mode (throw).
   * Reference failures surface as blocking findings for the caller to tag
   * and exclude.
   */
  private async resolveSingleArtifactProof(
    input: SingleArtifactProofInput,
  ): Promise<SingleArtifactProofResult> {
    const findings: ProofFindingV1[] = [];
    const production = this.mode === 'production_proof';

    // 1. Read and hash manifest bytes through locator reader. The manifest
    //    governing THIS artifact may be the candidate's or a separate one.
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
      throw new Error(
        `document key "${input.manifestDocumentKey}" not found in manifest ${input.manifestLocator}`,
      );
    }

    // 2. Resolve THIS artifact's policy from its own manifest entry.
    const resolvedPolicy = lookupPolicy(manifestDocument.family, manifestDocument.exhibit);
    const requireImmutableArchive = resolvedPolicy?.requireImmutableArchive ?? false;
    const requireParserRunProof = resolvedPolicy?.requireParserRunProof ?? false;

    // 3. Policy-required dependencies. Candidate: abort in production mode.
    //    Reference: artifact-specific blocking finding (comparison exclusion).
    if (production) {
      const missing: string[] = [];
      if (requireParserRunProof && !this.options.parseJobClient) {
        missing.push('parseJobClient');
      }
      if (requireParserRunProof && !this.options.parserOutputProofSource) {
        missing.push('parserOutputProofSource');
      }
      if (requireImmutableArchive && !this.options.s3Reader) {
        missing.push('s3Reader');
      }
      if (missing.length > 0) {
        const message =
          `policy ${manifestDocument.family}/${manifestDocument.exhibit} requires ` +
          `${missing.join(', ')} but production proof dependencies are unavailable ` +
          `(artifact=${input.artifactLocator})`;
        if (input.isCandidate) {
          throw new TrustedProofResolutionError(`production_proof mode: ${message}`);
        }
        findings.push(blockingFinding('production_dependency_missing', message));
      }
    }

    // 4. Read and hash artifact bytes.
    const artifactLocated = await this.readBytesWithReader(input.artifactLocator);
    const artifactByteSha256 = sha256Bytes(artifactLocated.bytes);
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

    // 5. Load SourceDocument and authoritative source bytes.
    let sourceDocumentProof: TrustedSourceDocumentProofV1;
    let sourceDocRow: Awaited<ReturnType<SourceDocumentClient['sourceDocument']['findFirst']>> =
      null;
    let sourcePdfLocated: TrustedLocatedBytes | null = null;

    if (this.sourceDocResolver) {
      const sdResult = await this.sourceDocResolver.resolveWithRow({
        sourceDocumentId: input.sourceDocumentId,
        actualSourcePdfSha256: '',
        artifactSourcePdfSha256: artifact.source.sourcePdfSha256,
        fiscalYear: manifest.fiscalYear,
        sourceKey: manifestDocument.sourceLocator,
      });
      sourceDocumentProof = sdResult.sourceDocument;
      sourceDocRow = sdResult.row;
      findings.push(...sdResult.findings);

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
    if (production && !sourcePdfLocated) {
      const message =
        'authoritative source bytes could not be resolved for production proof ' +
        `(sourceDocumentId=${input.sourceDocumentId}, artifact=${input.artifactLocator})`;
      if (input.isCandidate) {
        throw new TrustedProofResolutionError(message);
      }
      findings.push(blockingFinding('source_bytes_unresolved', message));
    }

    const actualSourceSha256 = sourcePdfLocated
      ? sha256Bytes(sourcePdfLocated.bytes)
      : artifact.source.sourcePdfSha256;

    // R8.1 §2.4: SourceDocument metadata must agree with manifest + artifact.
    if (production && sourceDocRow) {
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

    // 6. Verify artifact source SHA matches actual
    if (actualSourceSha256 !== artifact.source.sourcePdfSha256) {
      findings.push(
        blockingFinding(
          'artifact_source_sha_mismatch',
          `artifact source SHA ${artifact.source.sourcePdfSha256} does not match actual ${actualSourceSha256}`,
        ),
      );
    }

    // 7. Resolve archive proof from SourceDocument archive fields using THIS
    //    artifact's own policy requirement.
    let archiveProof: TrustedArchiveProofV1 = { status: 'not_applicable' };
    if (this.archiveResolver && sourceDocRow) {
      const row = sourceDocRow as Record<string, unknown>;
      const archiveResult = await this.archiveResolver.resolve({
        archiveBucket: row.archiveBucket as string | null | undefined,
        archiveS3Key: row.archiveS3Key as string | null | undefined,
        archiveVersionId: row.archiveVersionId as string | null | undefined,
        archiveKmsKeyArn: row.archiveKmsKeyArn as string | null | undefined,
        retainUntil: row.retainUntil as Date | null | undefined,
        archivedAt: row.archivedAt as Date | null | undefined,
        expectedSourceSha256: actualSourceSha256,
        requireImmutableArchive,
      });
      archiveProof = archiveResult.archive;
      findings.push(...archiveResult.findings);
    } else if (this.archiveResolver) {
      // No source document row but archive resolver exists — check if source is in S3
      if (sourcePdfLocated?.kind === 's3' && sourcePdfLocated.bucket && sourcePdfLocated.key) {
        const archiveResult = await this.archiveResolver.resolve({
          archiveBucket: sourcePdfLocated.bucket,
          archiveS3Key: sourcePdfLocated.key,
          archiveVersionId: sourcePdfLocated.versionId,
          archiveKmsKeyArn: sourcePdfLocated.kmsKeyArn,
          expectedSourceSha256: actualSourceSha256,
          requireImmutableArchive,
        });
        archiveProof = archiveResult.archive;
        findings.push(...archiveResult.findings);
      }
    }

    // 8. Resolve parser-run proof using THIS artifact's own policy.
    let parserRuns: TrustedParserRunProofV1[] = [];
    if (this.parserRunResolver && actualSourceSha256) {
      const prResult = await this.parserRunResolver.resolve({
        artifact,
        actualSourcePdfSha256: actualSourceSha256,
        sourceDocumentId: input.sourceDocumentId,
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
      // When policy requires parser-run proof, a resolver is mandatory —
      // never silently mark not_applicable.
      if (requireParserRunProof) {
        if (production && input.isCandidate) {
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

    // 9. Build manifest and artifact proof for THIS artifact.
    const manifestProof: TrustedManifestProofV1 = {
      locator: input.manifestLocator,
      contentSha256: manifestContentSha256,
      cycleId: manifest.cycleId,
      fiscalYear: manifest.fiscalYear,
      documentKey: input.manifestDocumentKey,
    };

    const extractionArtifactProof: TrustedExtractionArtifactProofV1 = {
      locator: input.artifactLocator,
      artifactId: artifact.artifactId,
      contentSha256: recomputedContentSha,
      byteSha256: artifactByteSha256,
      schemaVersion: 'defense_budget_extraction_v1',
    };

    return {
      manifest,
      manifestDocument,
      manifestContentSha256,
      manifestProof,
      artifact,
      artifactByteSha256,
      artifactContentSha256: recomputedContentSha,
      extractionArtifactProof,
      sourceDocumentProof,
      archiveProof,
      parserRuns,
      findings,
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
