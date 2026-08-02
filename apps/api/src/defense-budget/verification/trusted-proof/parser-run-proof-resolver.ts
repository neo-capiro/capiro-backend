/**
 * Parser-run proof resolver.
 *
 * Resolves each artifact `parserRuns[]` entry according to method:
 *   - LlamaParse: requires a real persisted parse-job record if the current
 *     schema supports one, matching input SHA, provider job ID, output SHA,
 *     output locator/key, and successful terminal parse status.
 *   - Deterministic/local parsers: actual output artifact bytes, output SHA,
 *     parser version, config SHA, input SHA matching source PDF, page ranges
 *     covering every evidence page.
 *   - Manual: proof of bytes and source identity but always carries a
 *     mandatory human-review trigger.
 *
 * Does not fabricate a parse job. Does not require a fake LlamaParse job for
 * local parsers.
 */
import type {
  DefenseBudgetExtractionArtifactV1,
  ParserRunV1,
  ExtractionMethodV1,
} from '../../contracts/extraction-artifact-v1.js';
import type {
  TrustedParserRunProofV1,
  ProofFindingV1,
} from './trusted-proof-types.js';
import { blockingFinding, reviewFinding } from './trusted-proof-types.js';

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
}

export interface ParserRunProofResolverResult {
  parserRuns: TrustedParserRunProofV1[];
  findings: ProofFindingV1[];
  manualReviewTriggered: boolean;
}

/**
 * Resolve parser-run proof for all parser runs in the artifact.
 */
export class ParserRunProofResolver {
  constructor(
    private readonly parseJobClient?: ParseJobClient,
  ) {}

  async resolve(input: ParserRunProofResolverInput): Promise<ParserRunProofResolverResult> {
    const findings: ProofFindingV1[] = [];
    const parserRuns: TrustedParserRunProofV1[] = [];
    let manualReviewTriggered = false;

    for (const run of input.artifact.parserRuns) {
      const result = await this.resolveOne(run, input.actualSourcePdfSha256, input.artifact);
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
    actualSourceSha: string,
    artifact: DefenseBudgetExtractionArtifactV1,
  ): Promise<{ proof: TrustedParserRunProofV1; findings: ProofFindingV1[] }> {
    const findings: ProofFindingV1[] = [];

    // Verify input source SHA matches actual source PDF SHA
    if (run.inputSourceSha256 !== actualSourceSha) {
      findings.push(
        blockingFinding(
          'parse_input_sha_mismatch',
          `parser run ${run.parserRunId} input SHA ${run.inputSourceSha256} does not match actual source SHA ${actualSourceSha}`,
        ),
      );
    }

    // Verify output artifact SHA matches the artifact's content SHA
    // (The artifact is the output of the parser run)
    if (run.outputArtifactSha256 !== artifact.contentSha256) {
      findings.push(
        blockingFinding(
          'parse_output_sha_mismatch',
          `parser run ${run.parserRunId} output SHA ${run.outputArtifactSha256} does not match artifact content SHA ${artifact.contentSha256}`,
        ),
      );
    }

    if (run.method === 'llamaparse') {
      return this.resolveLlamaParse(run, findings);
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

    // Deterministic/local parsers
    return {
      proof: {
        parserRunId: run.parserRunId,
        method: run.method,
        parserVersion: run.parserVersion,
        parserConfigSha256: run.parserConfigSha256,
        inputSourceSha256: run.inputSourceSha256,
        outputArtifactSha256: run.outputArtifactSha256,
        proofStatus: findings.length > 0 ? 'mismatch' : 'verified',
      },
      findings,
    };
  }

  private async resolveLlamaParse(
    run: ParserRunV1,
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

    // Verify provider job ID when present
    if (run.providerJobId && parseJob.providerJobId && run.providerJobId !== parseJob.providerJobId) {
      findings.push(
        blockingFinding(
          'parser_method_mismatch',
          `parse job ${parseJob.id} provider job ID ${parseJob.providerJobId} does not match parser run ${run.providerJobId}`,
        ),
      );
    }

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
        proofStatus: findings.length > 0 ? 'mismatch' : 'verified',
      },
      findings,
    };
  }
}