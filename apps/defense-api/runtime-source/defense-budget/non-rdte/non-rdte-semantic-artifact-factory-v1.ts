/**
 * Manifest-driven semantic artifact factory for Phase 5 source families.
 *
 * Family semantics are built from selected Phase 3 page results plus exact
 * contributing parser runs. The complete-single-result wrapper remains a
 * convenient replay path; multi-parser documents use the composed-output
 * factory and the same semantic builder below.
 */
import type { BudgetCycleManifestDocumentV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  computeParserRunId,
  parseParserRuntimeResultV1,
  verifyResultContentSha256,
  type ParserPageResultV1,
  type ParserRuntimeResultV1,
} from '../parser-router/parser-runtime-contract-v1.js';
import { extractP1FromPages } from './p1/p1-extractor-v1.js';
import { buildP1Artifact } from './p1/p1-artifact-builder-v1.js';
import { extractP40FromPages } from './p40/p40-extractor-v1.js';
import { buildP40Artifact } from './p40/p40-artifact-builder-v1.js';
import { extractP5FromPages } from './p5/p5-extractor-v1.js';
import { buildP5Artifact } from './p5/p5-artifact-builder-v1.js';
import { extractP21FromPages } from './p21/p21-extractor-v1.js';
import { buildP21Artifact } from './p21/p21-artifact-builder-v1.js';
import { extractP3aFromPages } from './p3a/p3a-extractor-v1.js';
import { buildP3aArtifact } from './p3a/p3a-artifact-builder-v1.js';
import { extractO1FromPages } from './o1/o1-extractor-v1.js';
import { buildO1Artifact } from './o1/o1-artifact-builder-v1.js';
import { extractOp5FromPages } from './op5/op5-extractor-v1.js';
import { buildOp5Artifact } from './op5/op5-artifact-builder-v1.js';
import { extractC1FromPages } from './c1/c1-extractor-v1.js';
import { buildC1Artifact } from './c1/c1-artifact-builder-v1.js';
import { extractDd1391FromPages } from './dd1391/dd1391-extractor-v1.js';
import { buildDd1391Artifact } from './dd1391/dd1391-artifact-builder-v1.js';
import { assertPhase5ArtifactProofBound } from './non-rdte-proof-bound-artifact-v1.js';

export class Phase5SemanticArtifactError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'Phase5SemanticArtifactError';
  }
}

function sortedUniquePages(pages: readonly number[]): number[] {
  return [...new Set(pages)].sort((left, right) => left - right);
}

function samePages(left: readonly number[], right: readonly number[]): boolean {
  const a = sortedUniquePages(left);
  const b = sortedUniquePages(right);
  return a.length === b.length && a.every((page, index) => page === b[index]);
}

/**
 * A single ParserRuntimeResultV1 is a valid Phase 5 semantic input only when it
 * represents the complete requested page set. Page-level failures and fallback
 * composition belong to the Phase 3 router; silently dropping failed pages here
 * would create a false-complete family artifact.
 */
function assertCompleteSingleParserResult(result: ParserRuntimeResultV1): void {
  const resultPages = result.pages.map((page) => page.page);
  const requestedPages = sortedUniquePages(result.requestedPages);
  const succeededPages = sortedUniquePages(result.succeededPages);

  if (
    result.failedPages.length > 0 ||
    !samePages(requestedPages, succeededPages) ||
    !samePages(succeededPages, resultPages)
  ) {
    const failedPages = sortedUniquePages(result.failedPages.map((failure) => failure.page));
    throw new Phase5SemanticArtifactError(
      `parser result ${result.jobId} is partial: requested=${requestedPages.join(',')}; ` +
        `succeeded=${succeededPages.join(',')}; resultPages=${sortedUniquePages(resultPages).join(',')}; ` +
        `failed=${failedPages.join(',') || 'none'}. Supply the complete Phase 3 composed result instead of dropping pages.`,
      'parser_result_partial',
    );
  }
}

function pagesToRanges(pages: readonly number[]): ParserRunV1['pageRanges'] {
  const sorted = sortedUniquePages(pages);
  if (sorted.length === 0) return [];
  const ranges: ParserRunV1['pageRanges'] = [];
  let start = sorted[0]!;
  let end = start;
  for (const page of sorted.slice(1)) {
    if (page === end + 1) {
      end = page;
      continue;
    }
    ranges.push({ startPage: start, endPage: end });
    start = page;
    end = page;
  }
  ranges.push({ startPage: start, endPage: end });
  return ranges;
}

export function phase5ParserRunFromResult(resultInput: unknown): {
  result: ParserRuntimeResultV1;
  run: ParserRunV1;
} {
  const result = parseParserRuntimeResultV1(resultInput);
  if (!verifyResultContentSha256(result)) {
    throw new Phase5SemanticArtifactError(
      `parser result ${result.jobId} has an invalid content SHA`,
      'parser_result_content_sha_mismatch',
    );
  }
  if (result.succeededPages.length === 0) {
    throw new Phase5SemanticArtifactError(
      `parser result ${result.jobId} contains no successful pages`,
      'parser_result_empty',
    );
  }
  assertCompleteSingleParserResult(result);
  const identity = {
    sourceSha256: result.inputSourceSha256,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    pages: result.succeededPages,
    runtimeContractVersion: result.schemaVersion,
  };
  return {
    result,
    run: {
      parserRunId: computeParserRunId(identity),
      method: result.engine,
      parserVersion: result.parserVersion,
      parserConfigSha256: result.parserConfigSha256,
      inputSourceSha256: result.inputSourceSha256,
      outputArtifactSha256: result.contentSha256,
      pageRanges: pagesToRanges(result.succeededPages),
      metadata: {
        parserJobId: result.jobId,
        requestedPages: result.requestedPages,
        failedPageCount: result.failedPages.length,
      },
    },
  };
}

function requiredAccount(document: BudgetCycleManifestDocumentV1): string {
  const account = document.account?.trim();
  if (!account) {
    throw new Phase5SemanticArtifactError(
      `${document.exhibit} document ${document.documentKey} requires manifest account context`,
      'manifest_account_missing',
    );
  }
  return account;
}

function parentBlinCode(document: BudgetCycleManifestDocumentV1): string | undefined {
  const value = document.metadata?.parentBlinCode;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function assertDocumentSourceBinding(input: {
  document: BudgetCycleManifestDocumentV1;
  source: ExtractionSourceV1;
}): void {
  if (input.document.documentKey !== input.source.manifestDocumentKey) {
    throw new Phase5SemanticArtifactError(
      'manifest/source document key mismatch',
      'manifest_source_key_mismatch',
    );
  }
  if (
    input.document.expectedSourceSha256 != null &&
    input.document.expectedSourceSha256 !== input.source.sourcePdfSha256
  ) {
    throw new Phase5SemanticArtifactError(
      `manifest/source SHA mismatch for ${input.document.documentKey}`,
      'manifest_source_sha_mismatch',
    );
  }
}

/**
 * Shared Phase 5 semantic dispatch. Callers must supply only pages selected by
 * the Phase 3 compositor and the exact parser runs that contributed them.
 */
export function buildNonRdteSemanticArtifactFromPages(input: {
  document: BudgetCycleManifestDocumentV1;
  source: ExtractionSourceV1;
  pages: readonly ParserPageResultV1[];
  parserRuns: readonly ParserRunV1[];
}): DefenseBudgetExtractionArtifactV1 {
  assertDocumentSourceBinding(input);
  if (input.pages.length === 0) {
    throw new Phase5SemanticArtifactError(
      `document ${input.document.documentKey} contains no selected parser pages`,
      'selected_pages_empty',
    );
  }
  if (input.parserRuns.length === 0) {
    throw new Phase5SemanticArtifactError(
      `document ${input.document.documentKey} contains selected pages without parser lineage`,
      'contributing_parser_runs_empty',
    );
  }

  const common = {
    source: input.source,
    parserRuns: [...input.parserRuns],
    cycleFiscalYear: input.source.fiscalYear,
  };
  const account = requiredAccount(input.document);
  const manifestParentBlinCode = parentBlinCode(input.document);

  switch (input.document.exhibit) {
    case 'P-1':
      return buildP1Artifact({
        ...common,
        extraction: extractP1FromPages({
          pages: input.pages,
          cycleFiscalYear: input.source.fiscalYear,
          account,
          component: input.source.component,
        }),
      });
    case 'P-40':
      return buildP40Artifact({
        ...common,
        extraction: extractP40FromPages({
          pages: input.pages,
          cycleFiscalYear: input.source.fiscalYear,
          account,
          component: input.source.component,
        }),
      });
    case 'P-5':
    case 'P-5A':
      return buildP5Artifact({
        ...common,
        extraction: extractP5FromPages({
          pages: input.pages,
          cycleFiscalYear: input.source.fiscalYear,
          account,
          component: input.source.component,
          ...(manifestParentBlinCode != null ? { parentBlinCode: manifestParentBlinCode } : {}),
        }),
      });
    case 'P-21':
      return buildP21Artifact({
        ...common,
        extraction: extractP21FromPages({
          pages: input.pages,
          cycleFiscalYear: input.source.fiscalYear,
          account,
          component: input.source.component,
          ...(manifestParentBlinCode != null ? { parentBlinCode: manifestParentBlinCode } : {}),
        }),
      });
    case 'P-3A':
      return buildP3aArtifact({
        ...common,
        extraction: extractP3aFromPages({
          pages: input.pages,
          cycleFiscalYear: input.source.fiscalYear,
          account,
          component: input.source.component,
          ...(manifestParentBlinCode != null ? { parentBlinCode: manifestParentBlinCode } : {}),
        }),
      });
    case 'O-1':
      return buildO1Artifact({
        ...common,
        extraction: extractO1FromPages({
          pages: input.pages,
          cycleFiscalYear: input.source.fiscalYear,
          account,
          component: input.source.component,
        }),
      });
    case 'OP-5':
      return buildOp5Artifact({
        ...common,
        extraction: extractOp5FromPages({
          pages: input.pages,
          cycleFiscalYear: input.source.fiscalYear,
          account,
          component: input.source.component,
        }),
      });
    case 'C-1':
      return buildC1Artifact({
        ...common,
        extraction: extractC1FromPages({
          pages: input.pages,
          cycleFiscalYear: input.source.fiscalYear,
          component: input.source.component,
          account,
        }),
      });
    case 'DD1391':
      return buildDd1391Artifact({
        ...common,
        extraction: extractDd1391FromPages({
          pages: input.pages,
          cycleFiscalYear: input.source.fiscalYear,
          component: input.source.component,
          account,
        }),
      });
    default:
      throw new Phase5SemanticArtifactError(
        `unsupported Phase 5 exhibit ${input.document.exhibit}`,
        'unsupported_exhibit',
      );
  }
}

export function buildProofBoundNonRdteArtifact(input: {
  document: BudgetCycleManifestDocumentV1;
  source: ExtractionSourceV1;
  parserResult: unknown;
  parserResultByteSha256?: string;
}): DefenseBudgetExtractionArtifactV1 {
  const { result, run } = phase5ParserRunFromResult(input.parserResult);
  if (result.inputSourceSha256 !== input.source.sourcePdfSha256) {
    throw new Phase5SemanticArtifactError(
      `parser result source SHA does not match ${input.document.documentKey}`,
      'parser_result_source_sha_mismatch',
    );
  }

  const artifact = buildNonRdteSemanticArtifactFromPages({
    document: input.document,
    source: input.source,
    pages: result.pages,
    parserRuns: [run],
  });
  assertPhase5ArtifactProofBound({
    artifact,
    parserResultProofs: [
      {
        parserRunId: run.parserRunId,
        result,
        ...(input.parserResultByteSha256 != null
          ? { resultByteSha256: input.parserResultByteSha256 }
          : {}),
      },
    ],
  });
  return artifact;
}
