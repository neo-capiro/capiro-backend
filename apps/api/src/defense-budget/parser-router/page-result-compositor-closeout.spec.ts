import {
  composePageResults,
  SELECTION_REASON_CODES,
  type ParserRunResultEntry,
} from './page-result-compositor.js';
import {
  sealParserRuntimeResult,
  type ParserRuntimeResultV1,
} from './parser-runtime-contract-v1.js';
import type { DefenseBudgetParsePlanV1 } from './route-planner.js';

const SOURCE_SHA = 'a'.repeat(64);
const CONFIG_SHA = 'b'.repeat(64);

function result(
  jobId: string,
  engine: 'deterministic_pdfplumber' | 'camelot',
  text: string,
): ParserRuntimeResultV1 {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId,
    engine,
    parserVersion: `${engine}-v1`,
    parserConfigSha256: CONFIG_SHA,
    inputSourceSha256: SOURCE_SHA,
    requestedPages: [1],
    succeededPages: [1],
    failedPages: [],
    pages: [
      {
        page: 1,
        text,
        blocks: [{ blockIndex: 0, blockType: 'text', text }],
        tables: [],
        images: [],
        evidencePrecision: 'page_only',
        warnings: [],
      },
    ],
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: 1,
      pagesSucceeded: 1,
      pagesFailed: 0,
      engineVersion: `${engine}-v1`,
    },
  });
}

function entry(
  parserRunId: string,
  engine: 'deterministic_pdfplumber' | 'camelot',
  text: string,
): ParserRunResultEntry {
  return {
    parserRunId,
    result: result(parserRunId, engine, text),
    method: engine,
    parserVersion: `${engine}-v1`,
    parserConfigSha256: CONFIG_SHA,
    sourceSha256: SOURCE_SHA,
    outputArtifactSha256: 'c'.repeat(64),
  };
}

describe('page compositor closeout', () => {
  it('derives the active escalation run from the current plan', () => {
    const initial = entry('run-pdfplumber', 'deterministic_pdfplumber', 'initial value');
    const escalated = entry('run-camelot', 'camelot', 'corrected value');
    const plan: DefenseBudgetParsePlanV1 = {
      schemaVersion: 'defense_budget_parse_plan_v1',
      executionId: 'execution-1',
      cycleId: 'fy2027-pb',
      manifestDocumentKey: 'r1-army',
      sourceSha256: SOURCE_SHA,
      parserPolicy: 'deterministic_table',
      steps: [
        {
          stepId: 'step-0',
          ordinal: 0,
          engine: 'camelot',
          pages: [1],
          reasonCodes: ['missing_evidence'],
          dependsOnStepIds: [],
          paid: false,
          terminalIfSuccessful: false,
        },
      ],
      paidAuthorizationRequired: false,
      plannedPaidPages: [],
      unresolvedPages: [],
      planSha256: 'd'.repeat(64),
    };

    const output = composePageResults({
      executionId: 'execution-1',
      sourceSha256: SOURCE_SHA,
      requestedPages: [1],
      parserRunEntries: [initial, escalated],
      plan,
    });

    expect(output.pages[0]).toMatchObject({
      selectedParserRunId: 'run-camelot',
      selectionReasonCodes: [SELECTION_REASON_CODES.RESOLVED_FINDING],
      alternativeParserRunIds: ['run-pdfplumber'],
    });
  });

  it('does not let a paid or stronger engine win without escalation evidence', () => {
    const initial = entry('run-pdfplumber', 'deterministic_pdfplumber', 'initial value');
    const camelot = entry('run-camelot', 'camelot', 'different value');
    const output = composePageResults({
      executionId: 'execution-1',
      sourceSha256: SOURCE_SHA,
      requestedPages: [1],
      parserRunEntries: [camelot, initial],
    });
    expect(output.pages[0]!.selectedParserRunId).toBe('run-pdfplumber');
    expect(output.pages[0]!.alternativeParserRunIds).toContain('run-camelot');
  });
});
