/**
 * Workstream L — strict V1 artifact bridge.
 *
 * Converts deterministic composed page results into a schema-valid
 * `defense_budget_extraction_v1` envelope. Phase 3 owns parser lineage,
 * page evidence and parser-output audit facts. Family-specific semantic
 * extraction may add assertions in later phases, but this bridge never emits
 * a non-contract pseudo-artifact and never fabricates cell geometry.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArtifactBuilderV1,
  evidenceIdV1,
  factIdV1,
  warningIdV1,
} from '../contracts/artifact-builders.js';
import {
  budgetAuthorityV1Schema,
  budgetComponentV1Schema,
  budgetFamilyV1Schema,
  exhibitV1Schema,
  type BudgetAuthorityV1,
  type BudgetComponentV1,
  type BudgetFamilyV1,
  type DefenseBudgetExtractionArtifactV1,
  type ExhibitV1,
  type PageRangeV1,
  type ParserRunV1,
} from '../contracts/extraction-artifact-v1.js';
import { sha256Bytes, type JsonValue } from '../contracts/canonical-json.js';
import type {
  ComposedPageOutputV1,
  PageLineageEntry,
  SelectedPageResultV1,
} from './page-result-compositor.js';

export function pagesToContiguousRanges(pages: number[]): PageRangeV1[] {
  if (pages.length === 0) return [];
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: PageRangeV1[] = [];
  let start = sorted[0]!;
  let end = start;
  for (let index = 1; index < sorted.length; index++) {
    const page = sorted[index]!;
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

export function buildContributingParserRuns(
  lineages: PageLineageEntry[],
  selectedPages: SelectedPageResultV1[],
  providerJobIdsByParserRunId: Readonly<Record<string, string>> = {},
): ParserRunV1[] {
  const selectedRunIds = new Set(
    selectedPages
      .map((page) => page.selectedParserRunId)
      .filter((runId): runId is string => runId !== null),
  );
  const grouped = new Map<
    string,
    {
      method: ParserRunV1['method'];
      parserVersion: string;
      parserConfigSha256: string;
      inputSourceSha256: string;
      outputArtifactSha256: string;
      pages: number[];
    }
  >();

  for (const lineage of lineages) {
    if (!selectedRunIds.has(lineage.parserRunId)) continue;
    const current = grouped.get(lineage.parserRunId);
    if (current) {
      if (!current.pages.includes(lineage.page)) current.pages.push(lineage.page);
      continue;
    }
    grouped.set(lineage.parserRunId, {
      method: lineage.method,
      parserVersion: lineage.parserVersion,
      parserConfigSha256: lineage.parserConfigSha256,
      inputSourceSha256: lineage.sourceSha256,
      outputArtifactSha256: lineage.outputArtifactSha256,
      pages: [lineage.page],
    });
  }

  return [...grouped.entries()]
    .map(([parserRunId, run]) => ({
      parserRunId,
      method: run.method,
      parserVersion: run.parserVersion,
      parserConfigSha256: run.parserConfigSha256,
      inputSourceSha256: run.inputSourceSha256,
      outputArtifactSha256: run.outputArtifactSha256,
      ...(providerJobIdsByParserRunId[parserRunId]
        ? { providerJobId: providerJobIdsByParserRunId[parserRunId] }
        : {}),
      pageRanges: pagesToContiguousRanges(run.pages),
    }))
    .sort((a, b) => a.parserRunId.localeCompare(b.parserRunId));
}

export interface ExtractionArtifactBridgeInput {
  executionId: string;
  cycleId: string;
  manifestDocumentKey: string;
  sourceDocumentId?: string;
  sourceSha256: string;
  sourceLocator: string;
  sourceUrl?: string;
  composedOutput: ComposedPageOutputV1;
  exhibitType: ExhibitV1 | string;
  budgetFamily: BudgetFamilyV1 | string;
  fiscalYear: number | string;
  authority?: BudgetAuthorityV1 | string;
  component?: BudgetComponentV1 | string;
  budgetCycle?: string;
  documentType?: string;
  title?: string;
  providerJobIdsByParserRunId?: Readonly<Record<string, string>>;
}

export interface ExtractionArtifactBridgeOutput {
  artifact: DefenseBudgetExtractionArtifactV1;
  artifactId: string;
  artifactContentSha256: string;
  artifactByteSha256: string;
  artifactLocator: string;
  parserRuns: ParserRunV1[];
  sourceFactCount: number;
  assertionCount: number;
  evidenceCount: number;
  warningCount: number;
}

function parseFiscalYear(value: number | string): number {
  const fiscalYear = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) {
    throw new Error(`invalid fiscal year: ${String(value)}`);
  }
  return fiscalYear;
}

export function buildExtractionArtifact(
  input: ExtractionArtifactBridgeInput,
  outputDir: string,
): ExtractionArtifactBridgeOutput {
  const parserRuns = buildContributingParserRuns(
    input.composedOutput.lineages,
    input.composedOutput.pages,
    input.providerJobIdsByParserRunId,
  );
  const fiscalYear = parseFiscalYear(input.fiscalYear);
  const family = budgetFamilyV1Schema.parse(input.budgetFamily);
  const exhibit = exhibitV1Schema.parse(input.exhibitType);
  const authority = budgetAuthorityV1Schema.parse(input.authority ?? 'unknown');
  const component = budgetComponentV1Schema.parse(input.component ?? 'UNKNOWN');

  const builder = new ArtifactBuilderV1({
    manifestDocumentKey: input.manifestDocumentKey,
    ...(input.sourceDocumentId ? { sourceDocumentId: input.sourceDocumentId } : {}),
    sourcePdfSha256: input.sourceSha256,
    sourceLocator: input.sourceLocator,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    fiscalYear,
    family,
    exhibit,
    authority,
    component,
    budgetCycle: input.budgetCycle ?? input.cycleId,
    documentType: input.documentType ?? exhibit,
    pageCount: input.composedOutput.pages.length,
    ...(input.title ? { title: input.title } : {}),
  });

  for (const run of parserRuns) builder.addParserRun(run);

  for (const page of input.composedOutput.pages) {
    if (page.selectedResult && page.selectedParserRunId) {
      const hashedEvidenceId = evidenceIdV1({
        executionId: input.executionId,
        page: page.page,
        parserRunId: page.selectedParserRunId,
        composedOutputSha256: input.composedOutput.contentSha256,
      });
      const evidenceId = `ev1_page_${page.page}_${hashedEvidenceId.slice(4)}`;
      builder.addEvidence({
        evidenceId,
        sourcePdfSha256: input.sourceSha256,
        parserRunId: page.selectedParserRunId,
        granularity: 'page_only',
        page: page.page,
        ...(page.selectedResult.printedPage
          ? { printedPage: page.selectedResult.printedPage }
          : {}),
        ...((page.selectedResult.text ?? page.selectedResult.markdown)
          ? { excerpt: (page.selectedResult.text ?? page.selectedResult.markdown)!.slice(0, 1000) }
          : {}),
      });
      builder.addSourceFact({
        factId: factIdV1({
          executionId: input.executionId,
          page: page.page,
          parserRunId: page.selectedParserRunId,
          kind: 'router_page_result',
        }),
        sourcePath: `composed.pages[${page.page}]`,
        category: 'metadata',
        requiredForCompleteness: false,
        rawValue: {
          selectedParserRunId: page.selectedParserRunId,
          selectionReasonCodes: page.selectionReasonCodes,
          alternativeParserRunIds: page.alternativeParserRunIds,
          blockCount: page.selectedResult.blocks.length,
          tableCount: page.selectedResult.tables.length,
          imageCount: page.selectedResult.images.length,
          evidencePrecision: page.selectedResult.evidencePrecision,
        } as JsonValue,
        evidenceIds: [evidenceId],
      });

      page.selectedResult.warnings.forEach((message, warningIndex) => {
        builder.addWarning({
          warningId: warningIdV1({
            executionId: input.executionId,
            page: page.page,
            warningIndex,
            message,
          }),
          code: 'parser_page_warning',
          severity: 'review',
          message,
          sourceFactIds: [],
          evidenceIds: [evidenceId],
        });
      });
    }

    page.failures.forEach((failure, failureIndex) => {
      builder.addWarning({
        warningId: warningIdV1({
          executionId: input.executionId,
          page: page.page,
          failureIndex,
          code: failure.code,
        }),
        code: `parser_page_failure_${failure.code}`,
        severity: 'blocking',
        message: `page ${failure.page}: ${failure.message}`,
        sourceFactIds: [],
        evidenceIds: [],
      });
    });
  }

  builder.addWarning({
    warningId: warningIdV1({
      executionId: input.executionId,
      code: 'router_family_assertion_mapping_deferred',
    }),
    code: 'router_family_assertion_mapping_deferred',
    severity: 'review',
    message:
      'Phase 3 produced strict parser lineage and page evidence; family-specific budget assertions must be supplied by a registered family extractor before machine verification can pass.',
    sourceFactIds: [],
    evidenceIds: [],
  });

  const artifact = builder.finalize();
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const artifactDir = join(outputDir, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const artifactLocator = join(artifactDir, `${artifact.artifactId}.extraction-v1.json`);
  writeFileSync(artifactLocator, serialized, 'utf8');

  return {
    artifact,
    artifactId: artifact.artifactId,
    artifactContentSha256: artifact.contentSha256,
    artifactByteSha256: sha256Bytes(Buffer.from(serialized, 'utf8')),
    artifactLocator,
    parserRuns: artifact.parserRuns,
    sourceFactCount: artifact.sourceFacts.length,
    assertionCount: artifact.assertions.length,
    evidenceCount: artifact.evidence.length,
    warningCount: artifact.warnings.length,
  };
}
