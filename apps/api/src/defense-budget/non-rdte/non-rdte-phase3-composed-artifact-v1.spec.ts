import { describe, expect, it } from '@jest/globals';
import type { BudgetCycleManifestDocumentV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type { ExtractionSourceV1 } from '../contracts/extraction-artifact-v1.js';
import {
  composePageResults,
  type ParserRunResultEntry,
} from '../parser-router/page-result-compositor.js';
import {
  computeParserRunId,
  sealParserRuntimeResult,
  type ParserPageResultV1,
  type ParserRuntimeResultV1,
} from '../parser-router/parser-runtime-contract-v1.js';
import { buildProofBoundNonRdteArtifactFromComposedOutput } from './non-rdte-phase3-composed-artifact-v1.js';

const SOURCE_SHA = 'a'.repeat(64);
const CONFIG_SHA_1 = 'b'.repeat(64);
const CONFIG_SHA_2 = 'c'.repeat(64);

function p1Page(page: number, code: string, amount: string): ParserPageResultV1 {
  return {
    page,
    text: `P-1 page ${page}`,
    blocks: [],
    tables: [
      {
        tableIndex: 0,
        label: 'Aircraft Procurement, Army ($ in Thousands)',
        rowCount: 2,
        columnCount: 5,
        cells: [
          { rowIndex: 0, columnIndex: 0, text: 'Line' },
          { rowIndex: 0, columnIndex: 1, text: 'Item' },
          { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
          { rowIndex: 0, columnIndex: 3, text: 'FY 2027 Qty' },
          { rowIndex: 0, columnIndex: 4, text: 'Type' },
          { rowIndex: 1, columnIndex: 0, text: code },
          { rowIndex: 1, columnIndex: 1, text: `Test line ${code}` },
          { rowIndex: 1, columnIndex: 2, text: amount },
          { rowIndex: 1, columnIndex: 3, text: '2' },
          { rowIndex: 1, columnIndex: 4, text: 'BASE' },
        ],
        warnings: [],
      },
    ],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function result(input: {
  jobId: string;
  configSha: string;
  page: ParserPageResultV1;
}): ParserRuntimeResultV1 {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: input.jobId,
    engine: 'deterministic_pdfplumber',
    parserVersion: 'pdfplumber-test',
    parserConfigSha256: input.configSha,
    inputSourceSha256: SOURCE_SHA,
    requestedPages: [input.page.page],
    succeededPages: [input.page.page],
    failedPages: [],
    pages: [input.page],
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: 1,
      pagesSucceeded: 1,
      pagesFailed: 0,
      engineVersion: 'test',
    },
  });
}

function entry(result: ParserRuntimeResultV1): ParserRunResultEntry {
  const parserRunId = computeParserRunId({
    sourceSha256: result.inputSourceSha256,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    pages: result.succeededPages,
    runtimeContractVersion: result.schemaVersion,
  });
  return {
    parserRunId,
    result,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    sourceSha256: result.inputSourceSha256,
    outputArtifactSha256: result.contentSha256,
  };
}

function document(): BudgetCycleManifestDocumentV1 {
  return {
    documentKey: 'p1-army',
    required: true,
    title: 'Army P-1',
    sourceLocator: 'fixture://p1-army.pdf',
    expectedSourceSha256: SOURCE_SHA,
    family: 'procurement',
    exhibit: 'P-1',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
    parserPolicy: 'deterministic_table',
    requiredDataCategories: ['identity', 'funding', 'quantities'],
    requiredFundingFields: ['request'],
    expectedLineKinds: ['PROCUREMENT_BLIN'],
    allowEmpty: false,
    account: 'aircraft_procurement_army',
  };
}

function source(): ExtractionSourceV1 {
  return {
    manifestDocumentKey: 'p1-army',
    sourceDocumentId: 'source-p1-army',
    sourcePdfSha256: SOURCE_SHA,
    sourceLocator: 'fixture://p1-army.pdf',
    fiscalYear: 2027,
    family: 'procurement',
    exhibit: 'P-1',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
    title: 'Army P-1',
  };
}

function twoRunFixture(requestedPages: number[] = [1, 2]) {
  const first = entry(
    result({
      jobId: 'p1-page-1',
      configSha: CONFIG_SHA_1,
      page: p1Page(1, 'WTCVAA', '1250'),
    }),
  );
  const second = entry(
    result({
      jobId: 'p1-page-2',
      configSha: CONFIG_SHA_2,
      page: p1Page(2, 'WTCVAB', '2500'),
    }),
  );
  const composedOutput = composePageResults({
    executionId: 'phase5-two-run-composition',
    sourceSha256: SOURCE_SHA,
    requestedPages,
    parserRunEntries: [first, second],
  });
  const proofs = [first, second].map((value, index) => ({
    parserRunId: value.parserRunId,
    result: value.result,
    resultByteSha256: String(index + 1).repeat(64),
  }));
  return { first, second, composedOutput, proofs };
}

describe('Phase 3 composed output -> Phase 5 artifact', () => {
  it('preserves two contributing parser runs and their selected pages', () => {
    const fixture = twoRunFixture();
    const artifact = buildProofBoundNonRdteArtifactFromComposedOutput({
      document: document(),
      source: source(),
      composedOutput: fixture.composedOutput,
      parserResultProofs: fixture.proofs,
    });

    expect(artifact.parserRuns.map((run) => run.parserRunId).sort()).toEqual(
      [fixture.first.parserRunId, fixture.second.parserRunId].sort(),
    );
    expect(artifact.parserRuns.map((run) => run.pageRanges)).toEqual(
      expect.arrayContaining([[{ startPage: 1, endPage: 1 }], [{ startPage: 2, endPage: 2 }]]),
    );
    expect(
      artifact.assertions.filter((assertion) => assertion.assertionKind === 'funding'),
    ).toHaveLength(2);
    expect(new Set(artifact.evidence.map((evidence) => evidence.parserRunId))).toEqual(
      new Set([fixture.first.parserRunId, fixture.second.parserRunId]),
    );
    expect(artifact.summary.completenessStatus).toBe('complete');
  });

  it('records an unresolved requested page as a blocking omission', () => {
    const fixture = twoRunFixture([1, 2, 3]);
    const artifact = buildProofBoundNonRdteArtifactFromComposedOutput({
      document: document(),
      source: source(),
      composedOutput: fixture.composedOutput,
      parserResultProofs: fixture.proofs,
    });

    expect(
      artifact.sourceFacts.some((fact) => fact.sourcePath === 'phase3/composed/unresolved/page:3'),
    ).toBe(true);
    expect(
      artifact.omissions.some(
        (omission) => omission.reason === 'missing_evidence' && omission.severity === 'blocking',
      ),
    ).toBe(true);
    expect(artifact.summary.completenessStatus).toBe('incomplete');
  });

  it('rejects a composed-output content hash mismatch', () => {
    const fixture = twoRunFixture();
    expect(() =>
      buildProofBoundNonRdteArtifactFromComposedOutput({
        document: document(),
        source: source(),
        composedOutput: {
          ...fixture.composedOutput,
          contentSha256: 'f'.repeat(64),
        },
        parserResultProofs: fixture.proofs,
      }),
    ).toThrow(/invalid content SHA/);
  });
});
