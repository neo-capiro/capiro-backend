/** Exact Phase 3 composed-output adapter for Phase 4 semantic extraction. */
import type { ExtractionSourceV1, ParserRunV1 } from '../../contracts/extraction-artifact-v1.js';
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
  /** Phase 10B-21 (3rd independent review, Area 8): the SUBSET of
   * `unresolvedPages` where every attempted parser engine independently
   * reported the SAME typed failure code, `no_embedded_text` -- i.e. the
   * page genuinely has no extractable content at all (a blank separator
   * page), not a parser defect on real content. This is the identical
   * "provably blank" concept the R-2 segmenter already applies to pages it
   * CAN see (Class 4 non_semantic); this field extends that same
   * determination to pages that never reach the segmenter at all because no
   * engine produced any parsed blocks/text for them. A page with even one
   * differently-coded failure (pdf_parse_error, timeout, model_unavailable,
   * etc.) is NEVER included here -- that is real, ambiguous evidence of a
   * genuine extraction defect and must keep surfacing as a blocking
   * omission for human review. Optional (defaults to treating every
   * unresolved page as non-blank, the pre-existing safe behavior) so any
   * other construction site of this interface does not need to change. */
  provablyBlankPages?: readonly number[];
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
    input.composedOutput.parserRunEntries ?? [],
  );
  const pages: ParserPageResultV1[] = [];
  const unresolvedPages: number[] = [];
  const provablyBlankPages: number[] = [];
  for (const selected of [...input.composedOutput.pages].sort((a, b) => a.page - b.page)) {
    if (selected.selectedResult == null || selected.selectedParserRunId == null) {
      unresolvedPages.push(selected.page);
      /* "Provably blank" requires EVERY attempted engine to have
       * independently reported the exact same no-content failure code --
       * one engine reporting a genuine parse/timeout/model defect is real
       * evidence of a problem on real content and must never be masked by
       * another engine trivially agreeing there was nothing to read. */
      if (
        selected.failures.length > 0 &&
        selected.failures.every((failure) => failure.code === 'no_embedded_text')
      ) {
        provablyBlankPages.push(selected.page);
      }
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
    provablyBlankPages,
  };
}
