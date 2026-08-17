/**
 * Parser-run proof resolver.
 *
 * R8.2 Workstream C: fields inside the candidate artifact are NOT
 * independent proof of the parser output that produced the artifact. A
 * parser run receives `proofStatus: 'verified'` only when its independently
 * persisted output bytes were loaded and verified through an injected
 * `ParserOutputProofSource`:
 *
 *   - LlamaParse: the exact persisted parse-job row (terminal success,
 *     provider job binding, input SHA agreement) PLUS the persisted output
 *     object bytes loaded and hashed — a database row containing an output
 *     key is not itself output proof;
 *   - deterministic / camelot / docling / OCR / other local methods: the
 *     persisted parser-run record and its content-addressed output bytes
 *     loaded, hashed, contract-validated, and compared for source SHA,
 *     method, parser version, config SHA, output content SHA, page ranges,
 *     and evidence page coverage. Legacy runs whose output was never
 *     persisted independently return `missing` — never `verified`;
 *   - Manual: proof of bytes and source identity but always carries a
 *     mandatory human-review trigger.
 *
 * Does not fabricate a parse job. Does not require a fake LlamaParse job for
 * local parsers. Phase 2 only reads immutable parser output — it never
 * initiates parsing or escalation.
 */
import type {
  DefenseBudgetExtractionArtifactV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { TrustedParserRunProofV1, ProofFindingV1 } from './trusted-proof-types.js';
import { blockingFinding, reviewFinding } from './trusted-proof-types.js';
import type {
  ParserOutputProofSource,
  ResolvedParserOutputProof,
} from './parser-output-proof-source.js';

export interface ParseJobRow {
  id: string;
  sourceDocumentId: string;
  provider: string;
  providerJobId: string | null;
  mode: string;
  resultType: string;
  pageStart: number | null;
  pageEnd: number | null;
  inputSha256: string;
  outputMarkdownS3Key: string | null;
  outputJsonS3Key: string | null;
  status: string;
  error: string | null;
  /** Persisted job metadata JSON (parser version/config provenance, etc.). */
  metadata?: unknown;
}

export interface ParseJobDelegate {
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<ParseJobRow | null>;
}

export interface ParseJobClient {
  documentParseJob: ParseJobDelegate;
}

export interface ParserRunProofResolverInput {
  artifact: DefenseBudgetExtractionArtifactV1;
  /** Actual source PDF SHA from resolved proof. */
  actualSourcePdfSha256: string;
  /** SourceDocument ID for output-proof requests (LlamaParse binding). */
  sourceDocumentId?: string;
}

export interface ParserRunProofResolverResult {
  parserRuns: TrustedParserRunProofV1[];
  findings: ProofFindingV1[];
  manualReviewTriggered: boolean;
}

/** Expand an artifact's parser-run page ranges to the covered page set. */
function pagesFromRanges(run: ParserRunV1): Set<number> {
  const pages = new Set<number>();
  for (const range of run.pageRanges) {
    for (let p = range.startPage; p <= range.endPage; p++) {
      pages.add(p);
    }
  }
  return pages;
}

/** Evidence pages attributed to a parser run by the artifact's evidence. */
function evidencePagesForRun(artifact: DefenseBudgetExtractionArtifactV1, run: ParserRunV1) {
  const pages: number[] = [];
  for (const e of artifact.evidence) {
    if (e.parserRunId === run.parserRunId && typeof e.page === 'number') {
      pages.push(e.page);
    }
  }
  return pages;
}

/**
 * Resolve parser-run proof for all parser runs in the artifact.
 */
export class ParserRunProofResolver {
  constructor(
    private readonly parseJobClient?: ParseJobClient,
    private readonly parserOutputProofSource?: ParserOutputProofSource,
  ) {}

  async resolve(input: ParserRunProofResolverInput): Promise<ParserRunProofResolverResult> {
    const findings: ProofFindingV1[] = [];
    const parserRuns: TrustedParserRunProofV1[] = [];
    let manualReviewTriggered = false;

    for (const run of input.artifact.parserRuns) {
      const result = await this.resolveOne(run, input, input.artifact);
      parserRuns.push(result.proof);
      findings.push(...result.findings);
      if (run.method === 'manual') {
        manualReviewTriggered = true;
      }
    }

    return { parserRuns, findings, manualReviewTriggered };
  }

  private async resolveOne(
    run: ParserRunV1,
    input: ParserRunProofResolverInput,
    artifact: DefenseBudgetExtractionArtifactV1,
  ): Promise<{ proof: TrustedParserRunProofV1; findings: ProofFindingV1[] }> {
    const findings: ProofFindingV1[] = [];
    const actualSourceSha = input.actualSourcePdfSha256;

    // Verify input source SHA matches actual source PDF SHA
    if (run.inputSourceSha256 !== actualSourceSha) {
      findings.push(
        blockingFinding(
          'parse_input_sha_mismatch',
          `parser run ${run.parserRunId} input SHA ${run.inputSourceSha256} does not match actual source SHA ${actualSourceSha}`,
        ),
      );
    }

    // R8.2-C/D: the declared output SHA (`run.outputArtifactSha256`) is bound
    // to the INDEPENDENTLY persisted parser output bytes through the
    // ParserOutputProofSource below (`declaredOutputSha256` vs
    // `outputContentSha256`). The old R8.1 comparison against
    // `artifact.contentSha256` was removed: the artifact content hash covers
    // the parserRuns array itself, so equality could only hold at a hash
    // fixed point — a self-referential artifact-field comparison, not
    // independent proof.

    if (run.method === 'llamaparse') {
      return this.resolveLlamaParse(run, input, findings);
    }

    if (run.method === 'manual') {
      // Manual parser runs carry proof of bytes and source identity but always
      // trigger mandatory human review.
      return {
        proof: {
          parserRunId: run.parserRunId,
          method: 'manual',
          parserVersion: run.parserVersion,
          parserConfigSha256: run.parserConfigSha256,
          inputSourceSha256: run.inputSourceSha256,
          outputArtifactSha256: run.outputArtifactSha256,
          proofStatus: 'verified',
        },
        findings: [
          reviewFinding(
            'parse_output_sha_mismatch',
            `manual parser run ${run.parserRunId} requires mandatory human review`,
          ),
          ...findings,
        ],
      };
    }

    return this.resolveLocalParserRun(run, input, artifact, findings);
  }

  /* ------------------------------------------------------------------ */
  /* Local parsers — independent persisted output bytes required         */
  /* ------------------------------------------------------------------ */

  private async resolveLocalParserRun(
    run: ParserRunV1,
    input: ParserRunProofResolverInput,
    artifact: DefenseBudgetExtractionArtifactV1,
    findings: ProofFindingV1[],
  ): Promise<{ proof: TrustedParserRunProofV1; findings: ProofFindingV1[] }> {
    if (!this.parserOutputProofSource) {
      // R8.2-C: no independent output bytes can be loaded — never verified.
      return {
        proof: {
          parserRunId: run.parserRunId,
          method: run.method,
          parserVersion: run.parserVersion,
          parserConfigSha256: run.parserConfigSha256,
          inputSourceSha256: run.inputSourceSha256,
          outputArtifactSha256: run.outputArtifactSha256,
          proofStatus: 'missing',
        },
        findings: [
          blockingFinding(
            'parse_output_missing',
            `no parser-output proof source configured; local parser run ${run.parserRunId} cannot be independently verified`,
          ),
          ...findings,
        ],
      };
    }

    let outputProof: ResolvedParserOutputProof | null;
    try {
      outputProof = await this.parserOutputProofSource.resolveParserOutput({
        parserRunId: run.parserRunId,
        method: run.method,
        sourceDocumentId: input.sourceDocumentId ?? '',
        declaredOutputSha256: run.outputArtifactSha256,
      });
    } catch (err) {
      // Persisted output exists but failed independent verification
      // (byte mismatch, corrupted store entry, invalid contract).
      return {
        proof: {
          parserRunId: run.parserRunId,
          method: run.method,
          parserVersion: run.parserVersion,
          parserConfigSha256: run.parserConfigSha256,
          inputSourceSha256: run.inputSourceSha256,
          outputArtifactSha256: run.outputArtifactSha256,
          proofStatus: 'mismatch',
        },
        findings: [
          blockingFinding(
            'parse_output_sha_mismatch',
            `persisted parser output for ${run.parserRunId} failed independent verification: ${
              (err as Error).message
            }`,
          ),
          ...findings,
        ],
      };
    }

    if (!outputProof) {
      // Legacy parser output was not persisted independently — missing,
      // never verified.
      return {
        proof: {
          parserRunId: run.parserRunId,
          method: run.method,
          parserVersion: run.parserVersion,
          parserConfigSha256: run.parserConfigSha256,
          inputSourceSha256: run.inputSourceSha256,
          outputArtifactSha256: run.outputArtifactSha256,
          proofStatus: 'missing',
        },
        findings: [
          blockingFinding(
            'parse_output_missing',
            `no independently persisted parser output found for local parser run ${run.parserRunId}`,
          ),
          ...findings,
        ],
      };
    }

    // Compare the persisted output identity to the declaration + actual source.
    if (outputProof.inputSourceSha256 !== input.actualSourcePdfSha256) {
      findings.push(
        blockingFinding(
          'parse_input_sha_mismatch',
          `persisted parser output for ${run.parserRunId} records source SHA ${outputProof.inputSourceSha256} but actual source SHA is ${input.actualSourcePdfSha256}`,
        ),
      );
    }
    if (outputProof.parserVersion !== run.parserVersion) {
      findings.push(
        blockingFinding(
          'parser_version_mismatch',
          `persisted parser output for ${run.parserRunId} records parser version ${outputProof.parserVersion} but declaration says ${run.parserVersion}`,
        ),
      );
    }
    if (outputProof.parserConfigSha256 !== run.parserConfigSha256) {
      findings.push(
        blockingFinding(
          'parser_config_mismatch',
          `persisted parser output for ${run.parserRunId} records config SHA ${outputProof.parserConfigSha256} but declaration says ${run.parserConfigSha256}`,
        ),
      );
    }

    // Explicit content-SHA declaration binding (forward-compatible): when the
    // artifact declares the persisted output's content SHA, it must match.
    const declaredContentSha = (run.metadata as Record<string, unknown> | undefined)?.[
      'parserOutputContentSha256'
    ];
    if (
      typeof declaredContentSha === 'string' &&
      outputProof.outputContentSha256 !== undefined &&
      declaredContentSha !== outputProof.outputContentSha256
    ) {
      findings.push(
        blockingFinding(
          'parse_output_sha_mismatch',
          `declared parser output content SHA ${declaredContentSha} does not match persisted output content SHA ${outputProof.outputContentSha256} for ${run.parserRunId}`,
        ),
      );
    }

    // Evidence page coverage: every evidence page attributed to this run must
    // be covered by the persisted output's succeeded pages (when reported).
    if (outputProof.succeededPages !== undefined) {
      const covered = new Set(outputProof.succeededPages);
      const uncovered = evidencePagesForRun(artifact, run).filter((p) => !covered.has(p));
      if (uncovered.length > 0) {
        findings.push(
          blockingFinding(
            'parse_page_coverage_incomplete',
            `persisted parser output for ${run.parserRunId} does not cover evidence pages ${uncovered.join(', ')}`,
            { uncoveredEvidencePages: uncovered },
          ),
        );
      }
    } else {
      // Fall back to the declared page ranges covering evidence pages.
      const covered = pagesFromRanges(run);
      const uncovered = evidencePagesForRun(artifact, run).filter((p) => !covered.has(p));
      if (uncovered.length > 0) {
        findings.push(
          blockingFinding(
            'parse_page_coverage_incomplete',
            `parser run ${run.parserRunId} declared page ranges do not cover evidence pages ${uncovered.join(', ')}`,
            { uncoveredEvidencePages: uncovered },
          ),
        );
      }
    }

    const verified = findings.length === 0;
    return {
      proof: {
        parserRunId: run.parserRunId,
        method: run.method,
        parserVersion: run.parserVersion,
        parserConfigSha256: run.parserConfigSha256,
        inputSourceSha256: run.inputSourceSha256,
        outputArtifactSha256: run.outputArtifactSha256,
        persistedParseJobId: outputProof.persistedRunId,
        outputLocator: outputProof.outputLocator,
        proofStatus: verified ? 'verified' : 'mismatch',
      },
      findings,
    };
  }

  /* ------------------------------------------------------------------ */
  /* LlamaParse — persisted row + persisted output object bytes          */
  /* ------------------------------------------------------------------ */

  private async resolveLlamaParse(
    run: ParserRunV1,
    input: ParserRunProofResolverInput,
    findings: ProofFindingV1[],
  ): Promise<{ proof: TrustedParserRunProofV1; findings: ProofFindingV1[] }> {
    if (!this.parseJobClient) {
      // No persisted parse-job model available
      return {
        proof: {
          parserRunId: run.parserRunId,
          method: 'llamaparse',
          parserVersion: run.parserVersion,
          parserConfigSha256: run.parserConfigSha256,
          inputSourceSha256: run.inputSourceSha256,
          outputArtifactSha256: run.outputArtifactSha256,
          proofStatus: 'missing',
        },
        findings: [
          reviewFinding(
            'parse_job_missing',
            `no parse-job client available for LlamaParse run ${run.parserRunId}`,
          ),
          ...findings,
        ],
      };
    }

    // Look up persisted parse job by provider job ID
    let parseJob: ParseJobRow | null = null;
    if (run.providerJobId) {
      parseJob = await this.parseJobClient.documentParseJob.findFirst({
        where: { providerJobId: run.providerJobId },
      });
    }

    if (!parseJob) {
      // Try by input SHA + provider
      parseJob = await this.parseJobClient.documentParseJob.findFirst({
        where: { inputSha256: run.inputSourceSha256, provider: 'llamaparse' },
      });
    }

    if (!parseJob) {
      return {
        proof: {
          parserRunId: run.parserRunId,
          method: 'llamaparse',
          parserVersion: run.parserVersion,
          parserConfigSha256: run.parserConfigSha256,
          inputSourceSha256: run.inputSourceSha256,
          outputArtifactSha256: run.outputArtifactSha256,
          proofStatus: 'missing',
        },
        findings: [
          blockingFinding(
            'parse_job_missing',
            `no persisted parse job found for LlamaParse run ${run.parserRunId}`,
          ),
          ...findings,
        ],
      };
    }

    // Verify matching input SHA
    if (parseJob.inputSha256 !== run.inputSourceSha256) {
      findings.push(
        blockingFinding(
          'parse_input_sha_mismatch',
          `parse job ${parseJob.id} input SHA ${parseJob.inputSha256} does not match parser run input SHA ${run.inputSourceSha256}`,
        ),
      );
    }

    // Verify successful terminal status
    if (parseJob.status !== 'succeeded') {
      findings.push(
        blockingFinding(
          'parse_output_sha_mismatch',
          `parse job ${parseJob.id} has non-terminal status ${parseJob.status}`,
        ),
      );
    }

    // Verify provider job ID binding (both directions).
    if (run.providerJobId && parseJob.providerJobId !== run.providerJobId) {
      findings.push(
        blockingFinding(
          'provider_job_mismatch',
          `parse job ${parseJob.id} provider job ID ${parseJob.providerJobId ?? '(none)'} does not match declared provider job ID ${run.providerJobId}`,
        ),
      );
    }

    // R8.2-C: the row alone is not output proof — load and hash the persisted
    // output object through the injected proof source.
    if (!this.parserOutputProofSource) {
      findings.push(
        blockingFinding(
          'parse_output_missing',
          `parse job ${parseJob.id} row exists but no parser-output proof source is configured to load its output object`,
        ),
      );
      return {
        proof: {
          parserRunId: run.parserRunId,
          method: 'llamaparse',
          parserVersion: run.parserVersion,
          parserConfigSha256: run.parserConfigSha256,
          inputSourceSha256: run.inputSourceSha256,
          outputArtifactSha256: run.outputArtifactSha256,
          persistedParseJobId: parseJob.id,
          providerJobId: parseJob.providerJobId ?? undefined,
          outputLocator: parseJob.outputJsonS3Key ?? parseJob.outputMarkdownS3Key ?? undefined,
          proofStatus: 'missing',
        },
        findings,
      };
    }

    let outputProof: ResolvedParserOutputProof | null;
    try {
      outputProof = await this.parserOutputProofSource.resolveParserOutput({
        parserRunId: run.parserRunId,
        method: 'llamaparse',
        sourceDocumentId: input.sourceDocumentId ?? parseJob.sourceDocumentId,
        providerJobId: run.providerJobId ?? parseJob.providerJobId ?? undefined,
        declaredOutputSha256: run.outputArtifactSha256,
      });
    } catch (err) {
      findings.push(
        blockingFinding(
          'parse_output_sha_mismatch',
          `persisted LlamaParse output for ${run.parserRunId} failed independent verification: ${
            (err as Error).message
          }`,
        ),
      );
      outputProof = null;
      return {
        proof: {
          parserRunId: run.parserRunId,
          method: 'llamaparse',
          parserVersion: run.parserVersion,
          parserConfigSha256: run.parserConfigSha256,
          inputSourceSha256: run.inputSourceSha256,
          outputArtifactSha256: run.outputArtifactSha256,
          persistedParseJobId: parseJob.id,
          providerJobId: parseJob.providerJobId ?? undefined,
          outputLocator: parseJob.outputJsonS3Key ?? parseJob.outputMarkdownS3Key ?? undefined,
          proofStatus: 'mismatch',
        },
        findings,
      };
    }

    if (!outputProof) {
      findings.push(
        blockingFinding(
          'parse_output_missing',
          `parse job ${parseJob.id} row exists but its persisted output object could not be loaded`,
        ),
      );
      return {
        proof: {
          parserRunId: run.parserRunId,
          method: 'llamaparse',
          parserVersion: run.parserVersion,
          parserConfigSha256: run.parserConfigSha256,
          inputSourceSha256: run.inputSourceSha256,
          outputArtifactSha256: run.outputArtifactSha256,
          persistedParseJobId: parseJob.id,
          providerJobId: parseJob.providerJobId ?? undefined,
          outputLocator: parseJob.outputJsonS3Key ?? parseJob.outputMarkdownS3Key ?? undefined,
          proofStatus: 'missing',
        },
        findings,
      };
    }

    // Provider job binding through the loaded output proof.
    if (
      run.providerJobId &&
      outputProof.providerJobId &&
      outputProof.providerJobId !== run.providerJobId
    ) {
      findings.push(
        blockingFinding(
          'provider_job_mismatch',
          `loaded parser output for ${run.parserRunId} belongs to provider job ${outputProof.providerJobId}, not declared ${run.providerJobId}`,
        ),
      );
    }

    // Explicit byte-SHA declaration binding (forward-compatible).
    const declaredByteSha = (run.metadata as Record<string, unknown> | undefined)?.[
      'parserOutputByteSha256'
    ];
    if (
      typeof declaredByteSha === 'string' &&
      outputProof.outputByteSha256 !== undefined &&
      declaredByteSha !== outputProof.outputByteSha256
    ) {
      findings.push(
        blockingFinding(
          'parse_output_sha_mismatch',
          `declared LlamaParse output byte SHA ${declaredByteSha} does not match loaded output byte SHA ${outputProof.outputByteSha256} for ${run.parserRunId}`,
        ),
      );
    }

    const verified = findings.length === 0;
    return {
      proof: {
        parserRunId: run.parserRunId,
        method: 'llamaparse',
        parserVersion: run.parserVersion,
        parserConfigSha256: run.parserConfigSha256,
        inputSourceSha256: run.inputSourceSha256,
        outputArtifactSha256: run.outputArtifactSha256,
        persistedParseJobId: parseJob.id,
        providerJobId: outputProof.providerJobId ?? parseJob.providerJobId ?? undefined,
        outputLocator: outputProof.outputLocator,
        proofStatus: verified ? 'verified' : 'mismatch',
      },
      findings,
    };
  }
}
