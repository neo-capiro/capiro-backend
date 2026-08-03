/**
 * Tests for Workstream L — V1 artifact bridge.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  pagesToContiguousRanges,
  buildContributingParserRuns,
  buildExtractionArtifact,
  computeArtifactId,
} from './extraction-artifact-bridge.js';
import type {
  ComposedPageOutputV1,
  PageLineageEntry,
  SelectedPageResultV1,
} from './page-result-compositor.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* pagesToContiguousRanges                                             */
/* ------------------------------------------------------------------ */

describe('pagesToContiguousRanges', () => {
  it('converts consecutive pages to a single range', () => {
    expect(pagesToContiguousRanges([1, 2, 3])).toEqual([
      { startPage: 1, endPage: 3 },
    ]);
  });

  it('splits non-consecutive pages into separate ranges', () => {
    expect(pagesToContiguousRanges([1, 3, 4, 7])).toEqual([
      { startPage: 1, endPage: 1 },
      { startPage: 3, endPage: 4 },
      { startPage: 7, endPage: 7 },
    ]);
  });

  it('handles a single page', () => {
    expect(pagesToContiguousRanges([5])).toEqual([
      { startPage: 5, endPage: 5 },
    ]);
  });

  it('handles empty input', () => {
    expect(pagesToContiguousRanges([])).toEqual([]);
  });

  it('sorts unsorted input', () => {
    expect(pagesToContiguousRanges([3, 1, 2])).toEqual([
      { startPage: 1, endPage: 3 },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* buildContributingParserRuns                                         */
/* ------------------------------------------------------------------ */

describe('buildContributingParserRuns', () => {
  const makeLineage = (
    runId: string,
    method: string,
    page: number,
  ): PageLineageEntry => ({
    parserRunId: runId,
    method: method as PageLineageEntry['method'],
    parserVersion: '1.0.0',
    parserConfigSha256: 'a'.repeat(64),
    sourceSha256: 'b'.repeat(64),
    page,
    outputArtifactSha256: 'c'.repeat(64),
  });

  const makeSelectedPage = (
    page: number,
    runId: string | null,
  ): SelectedPageResultV1 => ({
    page,
    selectedParserRunId: runId,
    selectionReasonCodes: ['initial_route'],
    selectedResult: runId
      ? {
          page,
          blocks: [],
          tables: [],
          images: [],
          evidencePrecision: 'page_only',
          warnings: [],
        }
      : null,
    alternativeParserRunIds: [],
    failures: [],
  });

  it('includes only runs with selected pages', () => {
    const lineages = [
      makeLineage('run1', 'deterministic_pdfplumber', 1),
      makeLineage('run1', 'deterministic_pdfplumber', 2),
      makeLineage('run2', 'camelot', 1), // alternative, not selected
    ];
    const selected = [makeSelectedPage(1, 'run1'), makeSelectedPage(2, 'run1')];

    const runs = buildContributingParserRuns(lineages, selected);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.parserRunId).toBe('run1');
    expect(runs[0]!.pageRanges).toEqual([{ startPage: 1, endPage: 2 }]);
  });

  it('excludes runs with no selected pages', () => {
    const lineages = [makeLineage('run2', 'camelot', 1)];
    const selected = [makeSelectedPage(1, null)];

    const runs = buildContributingParserRuns(lineages, selected);
    expect(runs).toHaveLength(0);
  });

  it('produces exact contiguous ranges from page sets', () => {
    const lineages = [
      makeLineage('run1', 'deterministic_pdfplumber', 1),
      makeLineage('run1', 'deterministic_pdfplumber', 2),
      makeLineage('run1', 'deterministic_pdfplumber', 4),
      makeLineage('run1', 'deterministic_pdfplumber', 5),
    ];
    const selected = [1, 2, 4, 5].map((p) => makeSelectedPage(p, 'run1'));

    const runs = buildContributingParserRuns(lineages, selected);
    expect(runs[0]!.pageRanges).toEqual([
      { startPage: 1, endPage: 2 },
      { startPage: 4, endPage: 5 },
    ]);
  });

  it('sorts runs by parserRunId for determinism', () => {
    const lineages = [
      makeLineage('run_b', 'camelot', 1),
      makeLineage('run_a', 'deterministic_pdfplumber', 2),
    ];
    const selected = [
      makeSelectedPage(1, 'run_b'),
      makeSelectedPage(2, 'run_a'),
    ];

    const runs = buildContributingParserRuns(lineages, selected);
    expect(runs[0]!.parserRunId).toBe('run_a');
    expect(runs[1]!.parserRunId).toBe('run_b');
  });
});

/* ------------------------------------------------------------------ */
/* computeArtifactId                                                   */
/* ------------------------------------------------------------------ */

describe('computeArtifactId', () => {
  it('produces deterministic IDs', () => {
    const id1 = computeArtifactId('sha1', 'exec1', 'content1');
    const id2 = computeArtifactId('sha1', 'exec1', 'content1');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^ea1_/);
  });

  it('produces different IDs for different inputs', () => {
    const id1 = computeArtifactId('sha1', 'exec1', 'content1');
    const id2 = computeArtifactId('sha2', 'exec1', 'content1');
    expect(id1).not.toBe(id2);
  });
});

/* ------------------------------------------------------------------ */
/* buildExtractionArtifact                                             */
/* ------------------------------------------------------------------ */

describe('buildExtractionArtifact', () => {
  it('produces an artifact with parser runs and page counts', () => {
    const composed: ComposedPageOutputV1 = {
      schemaVersion: 'defense_budget_composed_output_v1',
      executionId: 'exec-1',
      sourceSha256: 'a'.repeat(64),
      pages: [
        {
          page: 1,
          selectedParserRunId: 'run1',
          selectionReasonCodes: ['initial_route'],
          selectedResult: {
            page: 1,
            blocks: [],
            tables: [],
            images: [],
            evidencePrecision: 'page_only',
            warnings: [],
          },
          alternativeParserRunIds: [],
          failures: [],
        },
        {
          page: 2,
          selectedParserRunId: 'run1',
          selectionReasonCodes: ['initial_route'],
          selectedResult: {
            page: 2,
            blocks: [],
            tables: [],
            images: [],
            evidencePrecision: 'page_only',
            warnings: [],
          },
          alternativeParserRunIds: [],
          failures: [],
        },
      ],
      lineages: [
        {
          parserRunId: 'run1',
          method: 'deterministic_pdfplumber',
          parserVersion: '1.0.0',
          parserConfigSha256: 'b'.repeat(64),
          sourceSha256: 'a'.repeat(64),
          page: 1,
          outputArtifactSha256: 'c'.repeat(64),
        },
        {
          parserRunId: 'run1',
          method: 'deterministic_pdfplumber',
          parserVersion: '1.0.0',
          parserConfigSha256: 'b'.repeat(64),
          sourceSha256: 'a'.repeat(64),
          page: 2,
          outputArtifactSha256: 'c'.repeat(64),
        },
      ],
      contentSha256: 'd'.repeat(64),
    };

    const output = buildExtractionArtifact(
      {
        executionId: 'exec-1',
        cycleId: 'fy2026',
        manifestDocumentKey: 'rdte-army-vol1',
        sourceSha256: 'a'.repeat(64),
        sourceLocator: '/tmp/test.pdf',
        composedOutput: composed,
        exhibitType: 'R-1',
        budgetFamily: 'rdte',
        fiscalYear: '2026',
      },
      tmpDir,
    );

    expect(output.artifactId).toMatch(/^ea1_/);
    expect(output.artifactContentSha256).toHaveLength(64);
    expect(output.parserRuns).toHaveLength(1);
    expect(output.parserRuns[0]!.method).toBe('deterministic_pdfplumber');
    expect(output.parserRuns[0]!.pageRanges).toEqual([
      { startPage: 1, endPage: 2 },
    ]);
    expect(output.evidenceCount).toBe(2);
    expect(output.warningCount).toBe(0);
  });

  it('counts failures correctly', () => {
    const composed: ComposedPageOutputV1 = {
      schemaVersion: 'defense_budget_composed_output_v1',
      executionId: 'exec-1',
      sourceSha256: 'a'.repeat(64),
      pages: [
        {
          page: 1,
          selectedParserRunId: null,
          selectionReasonCodes: [],
          selectedResult: null,
          alternativeParserRunIds: [],
          failures: [{ page: 1, code: 'pdf_parse_error', message: 'test' }],
        },
      ],
      lineages: [],
      contentSha256: 'd'.repeat(64),
    };

    const output = buildExtractionArtifact(
      {
        executionId: 'exec-1',
        cycleId: 'fy2026',
        manifestDocumentKey: 'test',
        sourceSha256: 'a'.repeat(64),
        sourceLocator: '/tmp/test.pdf',
        composedOutput: composed,
        exhibitType: 'R-1',
        budgetFamily: 'rdte',
        fiscalYear: '2026',
      },
      tmpDir,
    );

    expect(output.evidenceCount).toBe(0);
    expect(output.warningCount).toBe(1);
  });
});
