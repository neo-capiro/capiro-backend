/**
 * rdte-phase3-document-input-v1.spec -- Phase 10B-21 (independent-review
 * follow-up): a dedicated test for the `provablyBlankPages` derivation,
 * specifically the multi-engine-disagreement case the 4th-round independent
 * reviewer flagged as logically correct (verified by reading) but not
 * covered by any test that actually constructs it.
 *
 * Drives the REAL compositor (`composePageResults`), not a hand-built
 * `ComposedPageOutputV1`, so lineage/selection semantics are exercised
 * faithfully.
 */
import { composePageResults, type ParserRunResultEntry } from '../../parser-router/page-result-compositor.js';
import type { ParserRuntimeResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestDocumentV1 } from '../../contracts/budget-cycle-manifest-v1.js';
import { rdteDocumentInputFromPhase3 } from './rdte-phase3-document-input-v1.js';

const SOURCE_SHA = 'd'.repeat(64);

function document(): BudgetCycleManifestDocumentV1 {
  return {
    documentKey: 'doc-1',
    required: true,
    title: 'r2',
    sourceLocator: '/sources/doc-1.pdf',
    family: 'rdte',
    exhibit: 'R-2',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'r2',
    parserPolicy: 'deterministic_table',
    requiredDataCategories: ['identity'],
    expectedLineKinds: ['RDTE_PE'],
    allowEmpty: false,
  };
}

function source(): ExtractionSourceV1 & { sourceDocumentId: string } {
  return {
    manifestDocumentKey: 'doc-1',
    sourceDocumentId: 'doc-1',
    sourcePdfSha256: SOURCE_SHA,
    sourceLocator: '/sources/doc-1.pdf',
    fiscalYear: 2027,
    family: 'rdte',
    exhibit: 'R-2',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'r2',
    title: 'r2',
  };
}

/**
 * `pageFailures`: which physical pages this engine fails on and with what
 * code. `succeedsPage3`: whether this engine also returns a real page-3
 * result (exactly one entry needs to, so the compositor has a winner and
 * `rdteDocumentInputFromPhase3`'s parser-lineage guard is satisfied).
 */
function engineEntry(input: {
  parserRunId: string;
  method: 'deterministic_pdfplumber' | 'camelot';
  pageFailures: Array<{ page: number; code: 'no_embedded_text' | 'pdf_parse_error' }>;
  succeedsPage3: boolean;
}): ParserRunResultEntry {
  const result: ParserRuntimeResultV1 = {
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: `job_${input.parserRunId}`,
    engine: input.method,
    parserVersion: `${input.method}-test`,
    parserConfigSha256: 'c'.repeat(64),
    inputSourceSha256: SOURCE_SHA,
    requestedPages: [1, 2, 3],
    succeededPages: input.succeedsPage3 ? [3] : [],
    failedPages: input.pageFailures.map((f) => ({
      page: f.page,
      code: f.code,
      message: f.code === 'no_embedded_text' ? 'page has no embedded text layer' : 'pdf parse failed',
    })),
    pages: input.succeedsPage3
      ? [
          {
            page: 3,
            text: 'real page 3 content',
            blocks: [],
            tables: [],
            images: [],
            evidencePrecision: 'text_span' as const,
            warnings: [],
          },
        ]
      : [],
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: 3,
      pagesSucceeded: input.succeedsPage3 ? 1 : 0,
      pagesFailed: input.pageFailures.length,
      engineVersion: `${input.method}-test`,
    },
    contentSha256: 'e'.repeat(64),
  };
  return {
    parserRunId: input.parserRunId,
    result,
    method: input.method,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    sourceSha256: SOURCE_SHA,
    outputArtifactSha256: `f_${input.parserRunId}`.padEnd(64, '0'),
  };
}

describe('rdteDocumentInputFromPhase3 -- provablyBlankPages multi-engine agreement', () => {
  it('marks a page provably blank only when EVERY attempted engine independently reports no_embedded_text, and keeps a page with a dissenting engine as a real blocking gap', () => {
    // Two independent engines, both attempted all 3 pages:
    //   page 1: BOTH engines report no_embedded_text -> unanimous, provably blank.
    //   page 2: pdfplumber reports no_embedded_text, camelot reports
    //           pdf_parse_error -> disagreement, must stay a real blocking gap.
    //   page 3: pdfplumber succeeds -> a normal selected page.
    const pdfplumber = engineEntry({
      parserRunId: 'run_pdfplumber',
      method: 'deterministic_pdfplumber',
      pageFailures: [
        { page: 1, code: 'no_embedded_text' },
        { page: 2, code: 'no_embedded_text' },
      ],
      succeedsPage3: true,
    });
    const camelot = engineEntry({
      parserRunId: 'run_camelot',
      method: 'camelot',
      pageFailures: [
        { page: 1, code: 'no_embedded_text' },
        { page: 2, code: 'pdf_parse_error' },
      ],
      succeedsPage3: false,
    });

    const composedOutput = composePageResults({
      executionId: 'test-execution',
      sourceSha256: SOURCE_SHA,
      requestedPages: [1, 2, 3],
      parserRunEntries: [pdfplumber, camelot],
    });

    const documentInput = rdteDocumentInputFromPhase3({
      document: document(),
      source: source(),
      composedOutput,
    });

    expect(documentInput.unresolvedPages).toEqual([1, 2]);
    // Only page 1 (unanimous no_embedded_text) is provably blank; page 2
    // (a real pdf_parse_error from one engine) must never be masked just
    // because a different engine also happened to see no text.
    expect(documentInput.provablyBlankPages).toEqual([1]);
    expect(documentInput.pages.map((page) => page.page)).toEqual([3]);
  });

  it('treats a page with zero attempted engines as unresolved but NOT provably blank (no vacuous-truth pass on an empty failures array)', () => {
    const pdfplumber = engineEntry({
      parserRunId: 'run_pdfplumber',
      method: 'deterministic_pdfplumber',
      pageFailures: [{ page: 1, code: 'no_embedded_text' }],
      succeedsPage3: true,
    });

    // Only page 3 is requested from a second, otherwise-irrelevant engine so
    // there is at least one contributing parser run; page 2 is requested but
    // no engine below returns any result OR failure for it at all.
    const composedOutput = composePageResults({
      executionId: 'test-execution',
      sourceSha256: SOURCE_SHA,
      requestedPages: [1, 2, 3],
      parserRunEntries: [pdfplumber],
    });

    const documentInput = rdteDocumentInputFromPhase3({
      document: document(),
      source: source(),
      composedOutput,
    });

    expect(documentInput.unresolvedPages).toEqual([1, 2]);
    // Page 1: one engine, unanimous no_embedded_text -> provably blank.
    // Page 2: zero engines even attempted it -> `failures.length > 0` guard
    // must keep this OUT of provablyBlankPages (Array.prototype.every on an
    // empty array is vacuously true, which would otherwise wrongly mask a
    // page nothing ever actually looked at).
    expect(documentInput.provablyBlankPages).toEqual([1]);
  });
});
