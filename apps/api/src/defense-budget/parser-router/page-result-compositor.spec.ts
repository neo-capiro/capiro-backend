/**
 * Tests for Workstream K — Deterministic page-result compositor.
 *
 * K7 mandatory tests:
 * - two parsers agree exactly
 * - two parsers conflict
 * - paid parser does not automatically win
 * - OCR not selected over clean digital result without reason
 * - missing page explicit failure
 * - deterministic output under shuffled input order
 * - no lost alternative run IDs
 *
 * K8 acceptance:
 * - No silent replacement
 * - Every page is accounted for
 * - composed output hash is deterministic
 */
import { describe, it, expect } from '@jest/globals';
import {
  composePageResults,
  computeBlockTableHash,
  arePageResultsIdentical,
  buildLineageEntries,
  verifyComposedContentSha,
  validatePageCompleteness,
  ENGINE_PREFERENCE_ORDER,
  SELECTION_REASON_CODES,
  type ParserRunResultEntry,
  type SelectedPageResultV1,
} from './page-result-compositor.js';
import type {
  ParserPageResultV1,
  ParserRuntimeResultV1,
  ParserPageFailureV1,
} from './parser-runtime-contract-v1.js';
import { sealParserRuntimeResult } from './parser-runtime-contract-v1.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';

/* ─── Helpers ─── */

function makePageResult(
  page: number,
  overrides: Partial<ParserPageResultV1> = {},
): ParserPageResultV1 {
  return {
    page,
    blocks: [],
    tables: [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
    ...overrides,
  };
}

function makeRuntimeResult(
  jobId: string,
  engine: ExtractionMethodV1,
  pages: ParserPageResultV1[],
  failures: ParserPageFailureV1[] = [],
): ParserRuntimeResultV1 {
  const succeeded = pages.map((p) => p.page);
  // requestedPages must include all pages referenced (failures + successes)
  const allPages = [...new Set([...succeeded, ...failures.map((f) => f.page)])].sort(
    (a, b) => a - b,
  );
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId,
    engine,
    parserVersion: `${engine}-v1`,
    parserConfigSha256: 'a'.repeat(64),
    inputSourceSha256: 'b'.repeat(64),
    requestedPages: allPages,
    succeededPages: succeeded,
    failedPages: failures,
    pages,
    warnings: [],
    metrics: {
      durationMillis: 100,
      pagesProcessed: pages.length + failures.length,
      pagesSucceeded: succeeded.length,
      pagesFailed: failures.length,
      engineVersion: `${engine}-v1`,
    },
  });
}

function makeRunEntry(
  parserRunId: string,
  method: ExtractionMethodV1,
  result: ParserRuntimeResultV1,
): ParserRunResultEntry {
  return {
    parserRunId,
    result,
    method,
    parserVersion: `${method}-v1`,
    parserConfigSha256: 'a'.repeat(64),
    sourceSha256: 'b'.repeat(64),
    outputArtifactSha256: 'c'.repeat(64),
  };
}

const SAMPLE_SOURCE_SHA = 'b'.repeat(64);

describe('page-result-compositor', () => {
  /* ─── K7: two parsers agree exactly ─── */
  describe('K7: two parsers agree exactly', () => {
    it('deduplicates identical results', () => {
      const page1 = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Budget text' }],
      });
      const page1Dup = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Budget text' }],
      });

      const entry1 = makeRunEntry(
        'run-pdfplumber-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-pdfplumber-1', 'deterministic_pdfplumber', [page1]),
      );
      const entry2 = makeRunEntry(
        'run-camelot-1',
        'camelot',
        makeRuntimeResult('run-camelot-1', 'camelot', [page1Dup]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry1, entry2],
      });

      expect(output.pages).toHaveLength(1);
      const page = output.pages[0]!;
      expect(page.selectedResult).not.toBeNull();
      expect(page.alternativeParserRunIds).toHaveLength(0); // deduplicated
    });

    it('produces identical content hash for identical inputs', () => {
      const page1 = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Same text' }],
      });

      const entry1 = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1]),
      );

      const output1 = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry1],
      });
      const output2 = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry1],
      });

      expect(output1.contentSha256).toBe(output2.contentSha256);
    });
  });

  /* ─── K7: two parsers conflict ─── */
  describe('K7: two parsers conflict', () => {
    it('retains conflicting results as alternatives', () => {
      const page1A = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Parser A text' }],
      });
      const page1B = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Parser B text' }],
      });

      const entry1 = makeRunEntry(
        'run-pdfplumber-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-pdfplumber-1', 'deterministic_pdfplumber', [page1A]),
      );
      const entry2 = makeRunEntry(
        'run-camelot-1',
        'camelot',
        makeRuntimeResult('run-camelot-1', 'camelot', [page1B]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry1, entry2],
      });

      const page = output.pages[0]!;
      expect(page.selectedResult).not.toBeNull();
      expect(page.alternativeParserRunIds).toHaveLength(1);
      // The alternative run ID should be present
      const altRunId = page.alternativeParserRunIds[0]!;
      expect(['run-pdfplumber-1', 'run-camelot-1']).toContain(altRunId);
    });
  });

  /* ─── K7: paid parser does not automatically win ─── */
  describe('K7: paid parser does not automatically win', () => {
    it('LlamaParse does not outrank local without resolved finding', () => {
      const localPage = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Local parser text' }],
        evidencePrecision: 'page_only',
      });
      const paidPage = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'LlamaParse text' }],
        evidencePrecision: 'page_only',
      });

      const localEntry = makeRunEntry(
        'run-pdfplumber-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-pdfplumber-1', 'deterministic_pdfplumber', [localPage]),
      );
      const paidEntry = makeRunEntry(
        'run-llamaparse-1',
        'llamaparse',
        makeRuntimeResult('run-llamaparse-1', 'llamaparse', [paidPage]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [localEntry, paidEntry],
      });

      const page = output.pages[0]!;
      // Local should be selected over LlamaParse (both page_only, no resolved finding)
      expect(page.selectedParserRunId).toBe('run-pdfplumber-1');
      expect(page.alternativeParserRunIds).toContain('run-llamaparse-1');
    });

    it('LlamaParse wins when it resolved a verifier finding', () => {
      const localPage = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Local text' }],
        evidencePrecision: 'page_only',
      });
      const paidPage = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'LlamaParse resolved text' }],
        evidencePrecision: 'page_only',
      });

      const localEntry = makeRunEntry(
        'run-pdfplumber-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-pdfplumber-1', 'deterministic_pdfplumber', [localPage]),
      );
      const paidEntry = makeRunEntry(
        'run-llamaparse-1',
        'llamaparse',
        makeRuntimeResult('run-llamaparse-1', 'llamaparse', [paidPage]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [localEntry, paidEntry],
        escalationRunIds: new Set(['run-llamaparse-1']), // LlamaParse was the escalation run
      });

      const page = output.pages[0]!;
      // LlamaParse should win because it resolved the finding
      expect(page.selectedParserRunId).toBe('run-llamaparse-1');
      expect(page.selectionReasonCodes).toContain(SELECTION_REASON_CODES.RESOLVED_FINDING);
    });
  });

  /* ─── K7: OCR not selected over clean digital result without reason ─── */
  describe('K7: OCR not selected over clean digital', () => {
    it('PaddleOCR does not outrank pdfplumber without reason', () => {
      const digitalPage = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Digital text' }],
        evidencePrecision: 'page_only',
      });
      const ocrPage = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'OCR text' }],
        evidencePrecision: 'page_only',
      });

      const digitalEntry = makeRunEntry(
        'run-pdfplumber-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-pdfplumber-1', 'deterministic_pdfplumber', [digitalPage]),
      );
      const ocrEntry = makeRunEntry(
        'run-paddleocr-1',
        'paddleocr',
        makeRuntimeResult('run-paddleocr-1', 'paddleocr', [ocrPage]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [digitalEntry, ocrEntry],
      });

      const page = output.pages[0]!;
      expect(page.selectedParserRunId).toBe('run-pdfplumber-1');
      expect(page.alternativeParserRunIds).toContain('run-paddleocr-1');
    });

    it('OCR wins when it resolved a finding on a scanned page', () => {
      const ocrPage = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'OCR recovered text' }],
        evidencePrecision: 'page_only',
      });
      const ocrEntry = makeRunEntry(
        'run-paddleocr-1',
        'paddleocr',
        makeRuntimeResult('run-paddleocr-1', 'paddleocr', [ocrPage]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [ocrEntry],
        escalationRunIds: new Set(['run-paddleocr-1']),
      });

      const page = output.pages[0]!;
      expect(page.selectedParserRunId).toBe('run-paddleocr-1');
      expect(page.selectionReasonCodes).toContain(SELECTION_REASON_CODES.RESOLVED_FINDING);
    });
  });

  /* ─── K7: missing page explicit failure ─── */
  describe('K7: missing page explicit failure', () => {
    it('page with no results has explicit null and NO_RESULTS reason', () => {
      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [5],
        parserRunEntries: [],
      });

      const page = output.pages[0]!;
      expect(page.page).toBe(5);
      expect(page.selectedResult).toBeNull();
      expect(page.selectedParserRunId).toBeNull();
      expect(page.selectionReasonCodes).toContain(SELECTION_REASON_CODES.NO_RESULTS);
    });

    it('page where all parsers failed has ALL_FAILED reason', () => {
      const failure: ParserPageFailureV1 = {
        page: 1,
        code: 'pdf_parse_error',
        message: 'failed to parse',
      };
      const entry = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [], [failure]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry],
      });

      const page = output.pages[0]!;
      expect(page.selectedResult).toBeNull();
      expect(page.failures).toHaveLength(1);
      expect(page.selectionReasonCodes).toContain(SELECTION_REASON_CODES.ALL_FAILED);
    });
  });

  /* ─── K7: deterministic output under shuffled input order ─── */
  describe('K7: deterministic output under shuffled input', () => {
    it('produces identical output regardless of entry order', () => {
      const page1A = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Text A' }],
      });
      const page1B = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Text B' }],
      });

      const entry1 = makeRunEntry(
        'run-aaa',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-aaa', 'deterministic_pdfplumber', [page1A]),
      );
      const entry2 = makeRunEntry(
        'run-bbb',
        'camelot',
        makeRuntimeResult('run-bbb', 'camelot', [page1B]),
      );

      const output1 = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry1, entry2],
      });
      const output2 = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry2, entry1], // shuffled
      });

      expect(output1.contentSha256).toBe(output2.contentSha256);
      expect(output1.pages[0]!.selectedParserRunId).toBe(output2.pages[0]!.selectedParserRunId);
    });

    it('produces identical output with shuffled requested pages order', () => {
      const page1 = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'P1' }],
      });
      const page2 = makePageResult(2, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'P2' }],
      });
      const page3 = makePageResult(3, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'P3' }],
      });

      const entry = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1, page2, page3]),
      );

      const output1 = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1, 2, 3],
        parserRunEntries: [entry],
      });
      const output2 = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [3, 1, 2], // shuffled
        parserRunEntries: [entry],
      });

      expect(output1.contentSha256).toBe(output2.contentSha256);
      // Pages should be sorted ascending
      expect(output2.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    });
  });

  /* ─── K7: no lost alternative run IDs ─── */
  describe('K7: no lost alternative run IDs', () => {
    it('preserves all non-duplicate alternative run IDs', () => {
      const page1A = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'A' }],
      });
      const page1B = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'B' }],
      });
      const page1C = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'C' }],
      });

      const entry1 = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1A]),
      );
      const entry2 = makeRunEntry(
        'run-2',
        'camelot',
        makeRuntimeResult('run-2', 'camelot', [page1B]),
      );
      const entry3 = makeRunEntry(
        'run-3',
        'docling',
        makeRuntimeResult('run-3', 'docling', [page1C]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry1, entry2, entry3],
      });

      const page = output.pages[0]!;
      expect(page.selectedParserRunId).not.toBeNull();
      // 2 alternatives (3 total - 1 selected)
      expect(page.alternativeParserRunIds).toHaveLength(2);
      // All run IDs should be accounted for
      const allRunIds = new Set([page.selectedParserRunId!, ...page.alternativeParserRunIds]);
      expect(allRunIds.has('run-1')).toBe(true);
      expect(allRunIds.has('run-2')).toBe(true);
      expect(allRunIds.has('run-3')).toBe(true);
    });

    it('does not lose alternatives when deduplicating', () => {
      // Two identical results + one different
      const page1A = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Same' }],
      });
      const page1Dup = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Same' }],
      });
      const page1Diff = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Different' }],
      });

      const entry1 = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1A]),
      );
      const entry2 = makeRunEntry(
        'run-2',
        'camelot',
        makeRuntimeResult('run-2', 'camelot', [page1Dup]),
      );
      const entry3 = makeRunEntry(
        'run-3',
        'docling',
        makeRuntimeResult('run-3', 'docling', [page1Diff]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry1, entry2, entry3],
      });

      const page = output.pages[0]!;
      // The different result should be an alternative
      expect(page.alternativeParserRunIds).toContain('run-3');
      // The duplicate should NOT be an alternative (deduplicated)
      const selectedRunId = page.selectedParserRunId!;
      const allRunIds = new Set([selectedRunId, ...page.alternativeParserRunIds]);
      // run-3 (different) must be present
      expect(allRunIds.has('run-3')).toBe(true);
    });
  });

  /* ─── K8: No silent replacement ─── */
  describe('K8: no silent replacement', () => {
    it('selected result is explicitly chosen with reason codes', () => {
      const page1 = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Text' }],
      });
      const entry = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry],
      });

      const page = output.pages[0]!;
      expect(page.selectionReasonCodes.length).toBeGreaterThan(0);
      expect(page.selectedParserRunId).not.toBeNull();
    });
  });

  /* ─── K8: Every page is accounted for ─── */
  describe('K8: every page is accounted for', () => {
    it('validatePageCompleteness passes for valid output', () => {
      const page1 = makePageResult(1);
      const entry = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry],
      });

      expect(validatePageCompleteness(output.pages)).toBe(true);
    });

    it('validatePageCompleteness passes for missing page', () => {
      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [],
      });

      // Missing page has NO_RESULTS — it's accounted for with null + reason
      expect(validatePageCompleteness(output.pages)).toBe(true);
    });

    it('every requested page appears in output', () => {
      const pages = [1, 2, 3, 4, 5].map((n) => makePageResult(n));
      const entry = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', pages),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1, 2, 3, 4, 5],
        parserRunEntries: [entry],
      });

      expect(output.pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  /* ─── K8: composed output hash is deterministic ─── */
  describe('K8: composed output hash is deterministic', () => {
    it('content SHA is 64-char hex', () => {
      const page1 = makePageResult(1);
      const entry = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry],
      });

      expect(output.contentSha256).toHaveLength(64);
      expect(output.contentSha256).toMatch(/^[0-9a-f]+$/);
    });

    it('verifyComposedContentSha returns true for valid output', () => {
      const page1 = makePageResult(1);
      const entry = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry],
      });

      expect(verifyComposedContentSha(output)).toBe(true);
    });

    it('same inputs produce same hash', () => {
      const page1 = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Test' }],
      });
      const entry = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1]),
      );

      const output1 = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry],
      });
      const output2 = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry],
      });

      expect(output1.contentSha256).toBe(output2.contentSha256);
    });
  });

  /* ─── K6: Lineage ─── */
  describe('K6: lineage', () => {
    it('builds lineage entries for all parser run pages', () => {
      const page1 = makePageResult(1);
      const page2 = makePageResult(2);
      const entry = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1, page2]),
      );

      const lineages = buildLineageEntries(entry);

      expect(lineages).toHaveLength(2);
      expect(lineages[0]!.parserRunId).toBe('run-1');
      expect(lineages[0]!.method).toBe('deterministic_pdfplumber');
      expect(lineages[0]!.page).toBe(1);
      expect(lineages[1]!.page).toBe(2);
    });

    it('lineage includes all required fields', () => {
      const page1 = makePageResult(1);
      const entry = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry],
      });

      const lineage = output.lineages[0]!;
      expect(lineage.parserRunId).toBe('run-1');
      expect(lineage.method).toBe('deterministic_pdfplumber');
      expect(lineage.parserVersion).toBe('deterministic_pdfplumber-v1');
      expect(lineage.parserConfigSha256).toBe('a'.repeat(64));
      expect(lineage.sourceSha256).toBe('b'.repeat(64));
      expect(lineage.page).toBe(1);
      expect(lineage.outputArtifactSha256).toBe('c'.repeat(64));
    });

    it('multiple parser runs produce multiple lineage entries', () => {
      const page1 = makePageResult(1);
      const entry1 = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', [page1]),
      );
      const entry2 = makeRunEntry(
        'run-2',
        'camelot',
        makeRuntimeResult('run-2', 'camelot', [page1]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entry1, entry2],
      });

      expect(output.lineages).toHaveLength(2);
      const runIds = output.lineages.map((l) => l.parserRunId);
      expect(runIds).toContain('run-1');
      expect(runIds).toContain('run-2');
    });
  });

  /* ─── K4: Deduplication helpers ─── */
  describe('K4: deduplication helpers', () => {
    it('computeBlockTableHash is deterministic', () => {
      const page = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Test' }],
      });
      expect(computeBlockTableHash(page)).toBe(computeBlockTableHash(page));
    });

    it('arePageResultsIdentical returns true for identical content', () => {
      const page1 = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Same' }],
      });
      const page2 = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Same' }],
      });
      expect(arePageResultsIdentical(page1, page2)).toBe(true);
    });

    it('arePageResultsIdentical returns false for different content', () => {
      const page1 = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'A' }],
      });
      const page2 = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'B' }],
      });
      expect(arePageResultsIdentical(page1, page2)).toBe(false);
    });

    it('does not deduplicate by title or approximate text', () => {
      const page1 = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Budget 2027' }],
      });
      const page2 = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Budget 2028' }],
      });
      expect(arePageResultsIdentical(page1, page2)).toBe(false);
    });
  });

  /* ─── K5: Page order ─── */
  describe('K5: page order', () => {
    it('output pages are sorted ascending', () => {
      const pages = [5, 3, 1, 4, 2].map((n) => makePageResult(n));
      const entry = makeRunEntry(
        'run-1',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-1', 'deterministic_pdfplumber', pages),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [5, 3, 1, 4, 2],
        parserRunEntries: [entry],
      });

      expect(output.pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  /* ─── Engine preference order ─── */
  describe('ENGINE_PREFERENCE_ORDER', () => {
    it('native_structured is first', () => {
      expect(ENGINE_PREFERENCE_ORDER[0]).toBe('native_structured');
    });

    it('llamaparse is not first (does not auto-outrank)', () => {
      expect(ENGINE_PREFERENCE_ORDER.indexOf('llamaparse')).toBeGreaterThan(0);
    });

    it('paddleocr is not first (does not auto-outrank)', () => {
      expect(ENGINE_PREFERENCE_ORDER.indexOf('paddleocr')).toBeGreaterThan(0);
    });
  });

  /* ─── Higher precision wins ─── */
  describe('evidence precision ranking', () => {
    it('cell_bbox wins over page_only', () => {
      const pageLow = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'Low' }],
        evidencePrecision: 'page_only',
      });
      const pageHigh = makePageResult(1, {
        blocks: [{ blockIndex: 0, blockType: 'text', text: 'High' }],
        evidencePrecision: 'cell_bbox',
        tables: [
          {
            tableIndex: 0,
            rowCount: 1,
            columnCount: 1,
            cells: [{ rowIndex: 0, columnIndex: 0, text: 'Data' }],
            warnings: [],
          },
        ],
      });

      const entryLow = makeRunEntry(
        'run-low',
        'deterministic_pdfplumber',
        makeRuntimeResult('run-low', 'deterministic_pdfplumber', [pageLow]),
      );
      const entryHigh = makeRunEntry(
        'run-high',
        'camelot',
        makeRuntimeResult('run-high', 'camelot', [pageHigh]),
      );

      const output = composePageResults({
        executionId: 'exec-1',
        sourceSha256: SAMPLE_SOURCE_SHA,
        requestedPages: [1],
        parserRunEntries: [entryLow, entryHigh],
      });

      expect(output.pages[0]!.selectedParserRunId).toBe('run-high');
      expect(output.pages[0]!.selectionReasonCodes).toContain(
        SELECTION_REASON_CODES.HIGHER_PRECISION,
      );
    });
  });
});
