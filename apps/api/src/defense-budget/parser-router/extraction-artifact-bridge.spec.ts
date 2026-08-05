import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseDefenseBudgetExtractionArtifactV1,
  validateDefenseBudgetExtractionArtifactV1,
} from '../contracts/extraction-artifact-v1.semantic.js';
import {
  buildContributingParserRuns,
  buildExtractionArtifact,
  pagesToContiguousRanges,
} from './extraction-artifact-bridge.js';
import type {
  ComposedPageOutputV1,
  PageLineageEntry,
  SelectedPageResultV1,
} from './page-result-compositor.js';

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'phase3-bridge-'));
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

function selectedPage(page: number, runId: string): SelectedPageResultV1 {
  return {
    page,
    selectedParserRunId: runId,
    selectionReasonCodes: ['initial_plan'],
    selectedResult: {
      page,
      text: `page ${page} text`,
      blocks: [],
      tables: [],
      images: [],
      evidencePrecision: 'text_span',
      warnings: [],
    },
    alternativeParserRunIds: [],
    failures: [],
  };
}

function lineage(page: number): PageLineageEntry {
  return {
    parserRunId: 'run-1',
    method: 'deterministic_pdfplumber',
    parserVersion: 'pdfplumber-0.11.0',
    parserConfigSha256: 'b'.repeat(64),
    sourceSha256: 'a'.repeat(64),
    page,
    outputArtifactSha256: 'c'.repeat(64),
  };
}

function composed(): ComposedPageOutputV1 {
  return {
    schemaVersion: 'defense_budget_composed_output_v1',
    executionId: 'exec-1',
    sourceSha256: 'a'.repeat(64),
    pages: [selectedPage(1, 'run-1'), selectedPage(2, 'run-1')],
    lineages: [lineage(1), lineage(2)],
    contentSha256: 'd'.repeat(64),
  };
}

describe('Phase 3 strict extraction artifact bridge', () => {
  it('derives exact contiguous page ranges', () => {
    expect(pagesToContiguousRanges([5, 1, 2, 4, 5])).toEqual([
      { startPage: 1, endPage: 2 },
      { startPage: 4, endPage: 5 },
    ]);
  });

  it('lists only parser runs that contributed selected pages', () => {
    const runs = buildContributingParserRuns(
      [lineage(1), lineage(2), { ...lineage(1), parserRunId: 'alternative-run' }],
      [selectedPage(1, 'run-1'), selectedPage(2, 'run-1')],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      parserRunId: 'run-1',
      pageRanges: [{ startPage: 1, endPage: 2 }],
    });
  });

  it('writes a schema-valid and semantically valid Phase 1 artifact', () => {
    const output = buildExtractionArtifact(
      {
        executionId: 'exec-1',
        cycleId: 'fy2027-pb',
        manifestDocumentKey: 'r1-army',
        sourceDocumentId: 'local-source-1',
        sourceSha256: 'a'.repeat(64),
        sourceLocator: '/tmp/r1.pdf',
        composedOutput: composed(),
        exhibitType: 'R-1',
        budgetFamily: 'rdte',
        fiscalYear: 2027,
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'r1',
      },
      workDir,
    );

    const parsed = parseDefenseBudgetExtractionArtifactV1(
      JSON.parse(readFileSync(output.artifactLocator, 'utf8')),
    );
    expect(validateDefenseBudgetExtractionArtifactV1(parsed)).toEqual([]);
    expect(parsed.source.sourceDocumentId).toBe('local-source-1');
    expect(parsed.parserRuns).toHaveLength(1);
    expect(parsed.evidence).toHaveLength(2);
    expect(parsed.sourceFacts).toHaveLength(2);
    expect(parsed.assertions).toHaveLength(0);
    expect(parsed.warnings.map((warning) => warning.code)).toContain(
      'router_family_assertion_mapping_deferred',
    );
    expect(output.artifactByteSha256).toHaveLength(64);
  });

  it('turns an unparsed page into an explicit blocking warning', () => {
    const value = composed();
    value.pages = [
      {
        page: 1,
        selectedParserRunId: null,
        selectionReasonCodes: [],
        selectedResult: null,
        alternativeParserRunIds: [],
        failures: [{ page: 1, code: 'pdf_parse_error', message: 'broken page' }],
      },
    ];
    value.lineages = [];
    const output = buildExtractionArtifact(
      {
        executionId: 'exec-failure',
        cycleId: 'fy2027-pb',
        manifestDocumentKey: 'r1-army',
        sourceSha256: 'a'.repeat(64),
        sourceLocator: '/tmp/r1.pdf',
        composedOutput: value,
        exhibitType: 'R-1',
        budgetFamily: 'rdte',
        fiscalYear: 2027,
      },
      workDir,
    );
    expect(output.artifact.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'parser_page_failure_pdf_parse_error', severity: 'blocking' }),
      ]),
    );
  });
});
