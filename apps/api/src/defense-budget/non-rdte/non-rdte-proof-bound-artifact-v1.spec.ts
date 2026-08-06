import type {
  DefenseBudgetExtractionArtifactV1,
  ParserRunV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  computeParserRunId,
  sealParserRuntimeResult,
  type ParserRuntimeResultV1,
} from '../parser-router/parser-runtime-contract-v1.js';
import {
  assertPhase5ArtifactProofBound,
  Phase5ArtifactProofError,
} from './non-rdte-proof-bound-artifact-v1.js';

const SOURCE_SHA = 'a'.repeat(64);
const CONFIG_SHA = 'b'.repeat(64);
const ARTIFACT_SHA = 'c'.repeat(64);

function parserResult(pages: number[] = [1]): ParserRuntimeResultV1 {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'phase5-test-job',
    engine: 'deterministic_pdfplumber',
    parserVersion: 'pdfplumber-test',
    parserConfigSha256: CONFIG_SHA,
    inputSourceSha256: SOURCE_SHA,
    requestedPages: pages,
    succeededPages: pages,
    failedPages: [],
    pages: pages.map((page) => ({
      page,
      text: `P-1 test page ${page}`,
      blocks: [],
      tables: [],
      images: [],
      evidencePrecision: 'page_only' as const,
      warnings: [],
    })),
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: pages.length,
      pagesSucceeded: pages.length,
      pagesFailed: 0,
      engineVersion: 'test',
    },
  });
}

function runId(result: ParserRuntimeResultV1): string {
  return computeParserRunId({
    sourceSha256: result.inputSourceSha256,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    pages: result.succeededPages,
    runtimeContractVersion: result.schemaVersion,
  });
}

function artifact(result = parserResult()): DefenseBudgetExtractionArtifactV1 {
  const parserRunId = runId(result);
  const run: ParserRunV1 = {
    parserRunId,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    inputSourceSha256: result.inputSourceSha256,
    outputArtifactSha256: result.contentSha256,
    pageRanges: result.succeededPages.map((page) => ({ startPage: page, endPage: page })),
  };
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: 'dbx1_phase5_test',
    contentSha256: ARTIFACT_SHA,
    source: {
      manifestDocumentKey: 'p1-test',
      sourcePdfSha256: SOURCE_SHA,
      sourceLocator: 'fixture://p1.pdf',
      fiscalYear: 2027,
      family: 'procurement',
      exhibit: 'P-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb_fy2027',
      documentType: 'pb_exhibit',
    },
    parserRuns: [run],
    evidence: [
      {
        evidenceId: 'ev_phase5_test',
        sourcePdfSha256: SOURCE_SHA,
        parserRunId,
        granularity: 'page_only',
        page: 1,
      },
    ],
    sourceFacts: [],
    assertions: [],
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: 0,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
  };
}

function proof(result = parserResult(), parserRunId = runId(result)) {
  return [{ parserRunId, result, resultByteSha256: 'd'.repeat(64) }];
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Phase5ArtifactProofError);
    expect((error as Phase5ArtifactProofError).code).toBe(code);
  }
}

describe('assertPhase5ArtifactProofBound', () => {
  it('accepts an exact deterministic parser run and persisted result', () => {
    const result = parserResult();
    const parserRunId = runId(result);
    const bound = assertPhase5ArtifactProofBound({
      artifact: artifact(result),
      parserResultProofs: proof(result),
      requireResultByteSha256: true,
    });
    expect(bound.parserResults.get(parserRunId)?.contentSha256).toBe(result.contentSha256);
  });

  it('accepts selected pages as a nonempty subset of a larger successful parser result', () => {
    const result = parserResult([1, 2]);
    const base = artifact(result);
    const selectedSubset: DefenseBudgetExtractionArtifactV1 = {
      ...base,
      parserRuns: [{ ...base.parserRuns[0]!, pageRanges: [{ startPage: 1, endPage: 1 }] }],
      evidence: [{ ...base.evidence[0]!, page: 1 }],
    };
    expect(() =>
      assertPhase5ArtifactProofBound({
        artifact: selectedSubset,
        parserResultProofs: proof(result),
        requireResultByteSha256: true,
      }),
    ).not.toThrow();
  });

  it('rejects empty and synthetic parser ledgers', () => {
    expectCode(
      () =>
        assertPhase5ArtifactProofBound({
          artifact: { ...artifact(), parserRuns: [] },
          parserResultProofs: [],
        }),
      'parser_run_missing',
    );
    const synthetic: ParserRunV1 = {
      parserRunId: 'synthetic',
      method: 'manual',
      parserVersion: 'p1-extractor-v1',
      parserConfigSha256: SOURCE_SHA,
      inputSourceSha256: SOURCE_SHA,
      outputArtifactSha256: SOURCE_SHA,
      pageRanges: [],
    };
    expectCode(
      () =>
        assertPhase5ArtifactProofBound({
          artifact: { ...artifact(), parserRuns: [synthetic] },
          parserResultProofs: [],
        }),
      'synthetic_parser_run',
    );
  });

  it('rejects a caller-manufactured parser-run ID', () => {
    const result = parserResult();
    const base = artifact(result);
    const badRun = { ...base.parserRuns[0]!, parserRunId: 'pr1_manufactured' };
    expectCode(
      () =>
        assertPhase5ArtifactProofBound({
          artifact: {
            ...base,
            parserRuns: [badRun],
            evidence: base.evidence.map((entry) => ({
              ...entry,
              parserRunId: badRun.parserRunId,
            })),
          },
          parserResultProofs: proof(result, badRun.parserRunId),
        }),
      'parser_run_id_mismatch',
    );
  });

  it('rejects missing proof, extra proof, and tampered result content', () => {
    const result = parserResult();
    const base = artifact(result);
    expectCode(
      () =>
        assertPhase5ArtifactProofBound({
          artifact: base,
          parserResultProofs: [],
        }),
      'parser_result_proof_missing',
    );
    expectCode(
      () =>
        assertPhase5ArtifactProofBound({
          artifact: base,
          parserResultProofs: [
            ...proof(result),
            { parserRunId: 'pr1_extra', result, resultByteSha256: 'e'.repeat(64) },
          ],
        }),
      'parser_result_proof_extra',
    );
    const tampered = { ...result, contentSha256: 'e'.repeat(64) };
    expectCode(
      () =>
        assertPhase5ArtifactProofBound({
          artifact: base,
          parserResultProofs: proof(tampered, runId(result)),
        }),
      'parser_result_content_sha_mismatch',
    );
  });

  it('requires exact persisted byte proof when requested', () => {
    const result = parserResult();
    expectCode(
      () =>
        assertPhase5ArtifactProofBound({
          artifact: artifact(result),
          parserResultProofs: [{ parserRunId: runId(result), result }],
          requireResultByteSha256: true,
        }),
      'parser_result_byte_sha_missing',
    );
  });

  it('rejects evidence outside the selected run page range', () => {
    const result = parserResult();
    const base = artifact(result);
    expectCode(
      () =>
        assertPhase5ArtifactProofBound({
          artifact: {
            ...base,
            evidence: [{ ...base.evidence[0]!, page: 2 }],
          },
          parserResultProofs: proof(result),
        }),
      'evidence_page_not_covered',
    );
  });

  it('rejects a selected page that was not successful in the persisted result', () => {
    const result = parserResult([1, 2]);
    const base = artifact(result);
    const invalidRun = {
      ...base.parserRuns[0]!,
      pageRanges: [{ startPage: 3, endPage: 3 }],
    };
    expectCode(
      () =>
        assertPhase5ArtifactProofBound({
          artifact: {
            ...base,
            parserRuns: [invalidRun],
            evidence: [{ ...base.evidence[0]!, page: 3 }],
          },
          parserResultProofs: proof(result),
        }),
      'parser_result_page_range_mismatch',
    );
  });

  it('rejects a parser run that contributes no selected pages', () => {
    const result = parserResult();
    const base = artifact(result);
    expectCode(
      () =>
        assertPhase5ArtifactProofBound({
          artifact: {
            ...base,
            parserRuns: [{ ...base.parserRuns[0]!, pageRanges: [] }],
          },
          parserResultProofs: proof(result),
        }),
      'parser_result_page_range_empty',
    );
  });
});
