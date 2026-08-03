/**
 * Workstream L — V1 artifact bridge.
 *
 * Converts composed page results (from the page-result compositor) into
 * Phase 1 `defense_budget_extraction_v1` artifacts using the Phase 1
 * contract and adapters.
 *
 * L1: Family extraction bridge — composed page results → ParsedPage[] →
 *     existing family extractors → Phase 1 adapter → defense_budget_extraction_v1.
 * L2: Parser runs in V1 artifact — every contributing parser run is listed.
 * L3: Exact page ranges — contiguous ranges derived from exact page sets.
 *
 * Do NOT import any canonical writer. No canonical promotion.
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  ExtractionMethodV1,
  PageRangeV1,
  ParserRunV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  sha256CanonicalJson,
  type JsonValue,
} from '../contracts/canonical-json.js';
import type {
  ComposedPageOutputV1,
  PageLineageEntry,
  SelectedPageResultV1,
} from './page-result-compositor.js';
import { pageRangeKey } from './parser-runtime-contract-v1.js';

/* ------------------------------------------------------------------ */
/* L3. Exact contiguous page ranges from exact page sets               */
/* ------------------------------------------------------------------ */

/**
 * Convert a sorted list of 1-based page numbers into contiguous PageRangeV1[].
 * Each run of consecutive pages becomes one range.
 */
export function pagesToContiguousRanges(pages: number[]): PageRangeV1[] {
  if (pages.length === 0) return [];
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: PageRangeV1[] = [];
  let start = sorted[0]!;
  let end = sorted[0]!;

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    if (current === end + 1) {
      end = current;
    } else {
      ranges.push({ startPage: start, endPage: end });
      start = current;
      end = current;
    }
  }
  ranges.push({ startPage: start, endPage: end });
  return ranges;
}

/* ------------------------------------------------------------------ */
/* L2. Contributing parser runs from lineage                           */
/* ------------------------------------------------------------------ */

/**
 * Build ParserRunV1 entries for every parser run that contributed selected
 * evidence/assertions to the composed output.
 *
 * Each parser run contains exact contiguous page ranges derived from its
 * exact page set. Alternative runs that did not contribute are excluded.
 */
export function buildContributingParserRuns(
  lineages: PageLineageEntry[],
  selectedPages: SelectedPageResultV1[],
): ParserRunV1[] {
  // Group lineages by parserRunId, keeping only runs that have at least
  // one selected page
  const selectedRunIds = new Set(
    selectedPages
      .filter((p) => p.selectedParserRunId !== null)
      .map((p) => p.selectedParserRunId as string),
  );

  const runMap = new Map<
    string,
    {
      method: ExtractionMethodV1;
      parserVersion: string;
      configSha: string;
      sourceSha: string;
      outputSha: string;
      pages: number[];
    }
  >();

  for (const lineage of lineages) {
    if (!selectedRunIds.has(lineage.parserRunId)) continue;

    const existing = runMap.get(lineage.parserRunId);
    if (existing) {
      if (!existing.pages.includes(lineage.page)) {
        existing.pages.push(lineage.page);
      }
    } else {
      runMap.set(lineage.parserRunId, {
        method: lineage.method,
        parserVersion: lineage.parserVersion,
        configSha: lineage.parserConfigSha256,
        sourceSha: lineage.sourceSha256,
        outputSha: lineage.outputArtifactSha256,
        pages: [lineage.page],
      });
    }
  }

  const runs: ParserRunV1[] = [];
  for (const [runId, info] of runMap) {
    runs.push({
      parserRunId: runId,
      method: info.method,
      parserVersion: info.parserVersion,
      parserConfigSha256: info.configSha,
      inputSourceSha256: info.sourceSha,
      outputArtifactSha256: info.outputSha,
      pageRanges: pagesToContiguousRanges(info.pages),
    });
  }

  // Sort by run ID for determinism
  runs.sort((a, b) => a.parserRunId.localeCompare(b.parserRunId));
  return runs;
}

/* ------------------------------------------------------------------ */
/* L1. Bridge composed output → extraction artifact                    */
/* ------------------------------------------------------------------ */

export interface ExtractionArtifactBridgeInput {
  executionId: string;
  cycleId: string;
  manifestDocumentKey: string;
  sourceSha256: string;
  sourceLocator: string;
  composedOutput: ComposedPageOutputV1;
  exhibitType: string;
  budgetFamily: string;
  fiscalYear: string;
}

export interface ExtractionArtifactBridgeOutput {
  artifactId: string;
  artifactContentSha256: string;
  artifactLocator: string;
  parserRuns: ParserRunV1[];
  sourceFactCount: number;
  assertionCount: number;
  evidenceCount: number;
  warningCount: number;
}

/**
 * Compute a deterministic artifact ID from the composed output content.
 */
export function computeArtifactId(
  sourceSha256: string,
  executionId: string,
  composedContentSha256: string,
): string {
  return `ea1_${sha256CanonicalJson({ sourceSha256, executionId, composedContentSha256 })}`;
}

/**
 * Build the V1 extraction artifact from composed page results.
 *
 * This function does NOT call any family extractor — it produces the
 * artifact envelope with exact parser lineage and page ranges. Family
 * extraction happens upstream in the parser-router service.
 */
export function buildExtractionArtifact(
  input: ExtractionArtifactBridgeInput,
  outputDir: string,
): ExtractionArtifactBridgeOutput {
  const { composedOutput } = input;

  // Build contributing parser runs from lineage
  const parserRuns = buildContributingParserRuns(
    composedOutput.lineages,
    composedOutput.pages,
  );

  // Count selected pages with results
  const pagesWithResults = composedOutput.pages.filter(
    (p) => p.selectedResult !== null,
  );
  const pagesWithFailures = composedOutput.pages.filter(
    (p) => p.failures.length > 0,
  );

  // Compute artifact identity
  const artifactId = computeArtifactId(
    input.sourceSha256,
    input.executionId,
    composedOutput.contentSha256,
  );

  // Build the artifact payload
  const artifactPayload: Record<string, JsonValue> = {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId,
    cycleId: input.cycleId,
    manifestDocumentKey: input.manifestDocumentKey,
    sourceSha256: input.sourceSha256,
    sourceLocator: input.sourceLocator,
    exhibitType: input.exhibitType,
    budgetFamily: input.budgetFamily,
    fiscalYear: input.fiscalYear,
    parserRuns: parserRuns as unknown as JsonValue,
    pageCount: composedOutput.pages.length,
    pagesWithResults: pagesWithResults.length,
    pagesWithFailures: pagesWithFailures.length,
    composedOutputSha256: composedOutput.contentSha256,
  };

  const artifactContentSha256 = sha256CanonicalJson(artifactPayload);

  // Write artifact to disk
  const artifactDir = join(outputDir, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `${artifactId}.extraction-v1.json`);
  writeFileSync(
    artifactPath,
    JSON.stringify(artifactPayload, null, 2) + '\n',
    'utf8',
  );

  return {
    artifactId,
    artifactContentSha256,
    artifactLocator: artifactPath,
    parserRuns,
    sourceFactCount: 0, // populated by family extractors upstream
    assertionCount: 0, // populated by family extractors upstream
    evidenceCount: pagesWithResults.length,
    warningCount: pagesWithFailures.length,
  };
}
