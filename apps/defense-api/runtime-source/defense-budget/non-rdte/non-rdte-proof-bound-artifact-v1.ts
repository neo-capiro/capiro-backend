/**
 * Proof boundary for Phase 5 non-RDT&E artifacts.
 *
 * Family extractors remain pure and may be exercised with small unit fixtures,
 * but an artifact may enter verification/certification/projection only after
 * this module binds every evidence-bearing parser run to the exact persisted
 * Phase 3 parser result that produced it.
 */
import type {
  DefenseBudgetExtractionArtifactV1,
  ParserRunV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  computeParserRunId,
  parseParserRuntimeResultV1,
  verifyResultContentSha256,
  type ParserRuntimeResultV1,
} from '../parser-router/parser-runtime-contract-v1.js';

export interface Phase5ParserResultProofV1 {
  parserRunId: string;
  result: unknown;
  /** SHA-256 of the exact persisted result bytes, when independently loaded. */
  resultByteSha256?: string;
  resultLocator?: string;
}

export interface Phase5ProofBoundArtifactV1 {
  artifact: DefenseBudgetExtractionArtifactV1;
  parserResults: ReadonlyMap<string, ParserRuntimeResultV1>;
  parserResultByteSha256ByRunId: ReadonlyMap<string, string>;
}

export class Phase5ArtifactProofError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'Phase5ArtifactProofError';
  }
}

function pageCovered(run: ParserRunV1, page: number): boolean {
  return run.pageRanges.some((range) => page >= range.startPage && page <= range.endPage);
}

function pagesFromRanges(run: ParserRunV1): number[] {
  const pages: number[] = [];
  for (const range of run.pageRanges) {
    for (let page = range.startPage; page <= range.endPage; page += 1) pages.push(page);
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}

function sortedUniquePages(pages: readonly number[]): number[] {
  return [...new Set(pages)].sort((a, b) => a - b);
}

function pageSubset(subset: readonly number[], superset: readonly number[]): boolean {
  const allowed = new Set(superset);
  return subset.every((page) => allowed.has(page));
}

function assertRunMatchesResult(run: ParserRunV1, result: ParserRuntimeResultV1): void {
  if (!verifyResultContentSha256(result)) {
    throw new Phase5ArtifactProofError(
      `parser result ${run.parserRunId} has an invalid content SHA`,
      'parser_result_content_sha_mismatch',
    );
  }
  const expectedRunId = computeParserRunId({
    sourceSha256: result.inputSourceSha256,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    pages: result.succeededPages,
    runtimeContractVersion: result.schemaVersion,
  });
  if (run.parserRunId !== expectedRunId) {
    throw new Phase5ArtifactProofError(
      `parser run ${run.parserRunId} does not equal the deterministic ID ${expectedRunId}`,
      'parser_run_id_mismatch',
    );
  }
  if (run.inputSourceSha256 !== result.inputSourceSha256) {
    throw new Phase5ArtifactProofError(
      `parser run ${run.parserRunId} source SHA does not match its persisted result`,
      'parser_result_source_sha_mismatch',
    );
  }
  if (run.method !== result.engine) {
    throw new Phase5ArtifactProofError(
      `parser run ${run.parserRunId} method ${run.method} does not match result engine ${result.engine}`,
      'parser_result_method_mismatch',
    );
  }
  if (run.parserVersion !== result.parserVersion) {
    throw new Phase5ArtifactProofError(
      `parser run ${run.parserRunId} version does not match its persisted result`,
      'parser_result_version_mismatch',
    );
  }
  if (run.parserConfigSha256 !== result.parserConfigSha256) {
    throw new Phase5ArtifactProofError(
      `parser run ${run.parserRunId} config SHA does not match its persisted result`,
      'parser_result_config_sha_mismatch',
    );
  }
  if (run.outputArtifactSha256 !== result.contentSha256) {
    throw new Phase5ArtifactProofError(
      `parser run ${run.parserRunId} output SHA does not match the exact persisted parser result`,
      'parser_result_output_sha_mismatch',
    );
  }

  const selectedPages = pagesFromRanges(run);
  if (selectedPages.length === 0) {
    throw new Phase5ArtifactProofError(
      `parser run ${run.parserRunId} contributes no selected pages`,
      'parser_result_page_range_empty',
    );
  }
  if (!pageSubset(selectedPages, result.succeededPages)) {
    const unavailable = selectedPages.filter((page) => !result.succeededPages.includes(page));
    throw new Phase5ArtifactProofError(
      `parser run ${run.parserRunId} selects pages not successful in the persisted result: ${unavailable.join(', ')}`,
      'parser_result_page_range_mismatch',
    );
  }
}

/**
 * Bind an artifact to independently loaded Phase 3 parser results.
 *
 * Fail-closed rules:
 * - no empty parser-run ledger;
 * - no manufactured manual run that aliases the source-PDF SHA;
 * - every run has one exact persisted result proof and there are no extra proofs;
 * - deterministic parser-run ID is recomputed independently from the full
 *   persisted parser result;
 * - artifact page ranges are nonempty selected subsets of successful pages;
 * - every evidence page is covered by the referenced run and result;
 * - every run/result source, method, version, config, and content SHA agrees.
 */
export function assertPhase5ArtifactProofBound(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  parserResultProofs: readonly Phase5ParserResultProofV1[];
  /** Require independently computed SHA-256 of the exact persisted result bytes. */
  requireResultByteSha256?: boolean;
}): Phase5ProofBoundArtifactV1 {
  const { artifact } = input;
  if (artifact.parserRuns.length === 0) {
    throw new Phase5ArtifactProofError(
      `artifact ${artifact.artifactId} has no parser runs`,
      'parser_run_missing',
    );
  }

  const proofByRunId = new Map<string, Phase5ParserResultProofV1>();
  for (const proof of input.parserResultProofs) {
    if (proofByRunId.has(proof.parserRunId)) {
      throw new Phase5ArtifactProofError(
        `duplicate parser-result proof for ${proof.parserRunId}`,
        'parser_result_proof_duplicate',
      );
    }
    if (proof.resultByteSha256 != null && !/^[a-f0-9]{64}$/.test(proof.resultByteSha256)) {
      throw new Phase5ArtifactProofError(
        `parser-result byte SHA for ${proof.parserRunId} is malformed`,
        'parser_result_byte_sha_invalid',
      );
    }
    if (input.requireResultByteSha256 && proof.resultByteSha256 == null) {
      throw new Phase5ArtifactProofError(
        `parser-result byte SHA is required for ${proof.parserRunId}`,
        'parser_result_byte_sha_missing',
      );
    }
    proofByRunId.set(proof.parserRunId, proof);
  }

  const resultByRunId = new Map<string, ParserRuntimeResultV1>();
  const byteShaByRunId = new Map<string, string>();
  const runById = new Map(artifact.parserRuns.map((run) => [run.parserRunId, run]));
  if (runById.size !== artifact.parserRuns.length) {
    throw new Phase5ArtifactProofError(
      `artifact ${artifact.artifactId} contains duplicate parser-run IDs`,
      'parser_run_duplicate',
    );
  }

  for (const proofRunId of proofByRunId.keys()) {
    if (!runById.has(proofRunId)) {
      throw new Phase5ArtifactProofError(
        `parser-result proof ${proofRunId} is not referenced by artifact ${artifact.artifactId}`,
        'parser_result_proof_extra',
      );
    }
  }

  for (const run of artifact.parserRuns) {
    if (
      run.method === 'manual' &&
      run.outputArtifactSha256 === artifact.source.sourcePdfSha256 &&
      run.pageRanges.length === 0
    ) {
      throw new Phase5ArtifactProofError(
        `artifact ${artifact.artifactId} contains a manufactured manual parser run`,
        'synthetic_parser_run',
      );
    }
    if (run.inputSourceSha256 !== artifact.source.sourcePdfSha256) {
      throw new Phase5ArtifactProofError(
        `parser run ${run.parserRunId} is not bound to the artifact source PDF`,
        'parser_run_source_sha_mismatch',
      );
    }
    const proof = proofByRunId.get(run.parserRunId);
    if (proof == null) {
      throw new Phase5ArtifactProofError(
        `artifact ${artifact.artifactId} has no persisted result proof for ${run.parserRunId}`,
        'parser_result_proof_missing',
      );
    }
    const result = parseParserRuntimeResultV1(proof.result);
    assertRunMatchesResult(run, result);
    resultByRunId.set(run.parserRunId, result);
    if (proof.resultByteSha256 != null) {
      byteShaByRunId.set(run.parserRunId, proof.resultByteSha256);
    }
  }

  for (const evidence of artifact.evidence) {
    const run = runById.get(evidence.parserRunId);
    if (run == null) {
      throw new Phase5ArtifactProofError(
        `evidence ${evidence.evidenceId} references unknown parser run ${evidence.parserRunId}`,
        'evidence_parser_run_missing',
      );
    }
    if (evidence.sourcePdfSha256 !== artifact.source.sourcePdfSha256) {
      throw new Phase5ArtifactProofError(
        `evidence ${evidence.evidenceId} is not bound to the artifact source PDF`,
        'evidence_source_sha_mismatch',
      );
    }
    if (evidence.page != null) {
      if (!pageCovered(run, evidence.page)) {
        throw new Phase5ArtifactProofError(
          `evidence ${evidence.evidenceId} page ${evidence.page} is outside parser run ${run.parserRunId}`,
          'evidence_page_not_covered',
        );
      }
      const result = resultByRunId.get(run.parserRunId)!;
      if (!result.succeededPages.includes(evidence.page)) {
        throw new Phase5ArtifactProofError(
          `evidence ${evidence.evidenceId} page ${evidence.page} was not successful in the persisted parser result`,
          'evidence_page_not_in_result',
        );
      }
    }
  }

  return {
    artifact,
    parserResults: resultByRunId,
    parserResultByteSha256ByRunId: byteShaByRunId,
  };
}
