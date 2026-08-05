/** Exact Phase 3 composed-output adapter for Phase 4 semantic extraction. */
import type {
  ExtractionSourceV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestDocumentV1 } from '../../contracts/budget-cycle-manifest-v1.js';
import { buildContributingParserRuns } from '../../parser-router/extraction-artifact-bridge.js';
import type { ComposedPageOutputV1 } from '../../parser-router/page-result-compositor.js';
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';

export interface RdteCycleDocumentInputV1 {
  document: BudgetCycleManifestDocumentV1;
  source: ExtractionSourceV1 & { sourceDocumentId: string };
  pages: readonly ParserPageResultV1[];
  parserRuns: readonly ParserRunV1[];
  unresolvedPages: readonly number[];
}

export function rdteDocumentInputFromPhase3(input: {
  document: BudgetCycleManifestDocumentV1;
  source: ExtractionSourceV1 & { sourceDocumentId: string };
  composedOutput: ComposedPageOutputV1;
  providerJobIdsByParserRunId?: Readonly<Record<string, string>>;
}): RdteCycleDocumentInputV1 {
  if (input.composedOutput.sourceSha256 !== input.source.sourcePdfSha256) {
    throw new Error(
      `Phase 3/source SHA mismatch for ${input.document.documentKey}: ` +
        `${input.composedOutput.sourceSha256} != ${input.source.sourcePdfSha256}`,
    );
  }

  const parserRuns = buildContributingParserRuns(
    input.composedOutput.lineages,
    input.composedOutput.pages,
    input.providerJobIdsByParserRunId,
  );
  const pages: ParserPageResultV1[] = [];
  const unresolvedPages: number[] = [];
  for (const selected of [...input.composedOutput.pages].sort((a, b) => a.page - b.page)) {
    if (selected.selectedResult == null || selected.selectedParserRunId == null) {
      unresolvedPages.push(selected.page);
      continue;
    }
    pages.push(selected.selectedResult);
  }

  if (pages.length > 0 && parserRuns.length === 0) {
    throw new Error(
      `Phase 3 selected pages for ${input.document.documentKey} without contributing parser lineage`,
    );
  }
  const selectedRunIds = new Set(
    input.composedOutput.pages
      .map((page) => page.selectedParserRunId)
      .filter((value): value is string => value !== null),
  );
  const declaredRunIds = new Set(parserRuns.map((run) => run.parserRunId));
  for (const runId of selectedRunIds) {
    if (!declaredRunIds.has(runId)) {
      throw new Error(
        `selected parser run ${runId} is missing from Phase 4 lineage for ${input.document.documentKey}`,
      );
    }
  }

  return {
    document: input.document,
    source: input.source,
    pages,
    parserRuns,
    unresolvedPages,
  };
}
