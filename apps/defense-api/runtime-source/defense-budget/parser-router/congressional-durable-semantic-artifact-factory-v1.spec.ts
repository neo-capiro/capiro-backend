import { sha256Bytes } from '../contracts/canonical-json.js';
import {
  adapterTestContext,
  ADAPTER_TEST_CONFIG_SHA,
  ADAPTER_TEST_SOURCE_SHA,
} from '../contracts/adapters/testing-helpers.js';
import type { ParserRunV1 } from '../contracts/extraction-artifact-v1.js';
import { createHascSourceProfileV1 } from '../stages/authorization/hasc-source-profile-v1.js';
import {
  CONGRESSIONAL_TABLE_SCHEMA_VERSION,
  type CongressionalTableV1,
} from '../stages/congressional-table-v1.js';
import type { NativeIdentityIndexEntry } from '../stages/line-reference-resolver.js';
import { parserRunIdV1 } from './parser-run-identity-v1.js';
import { sealParserRuntimeResult } from './parser-runtime-contract-v1.js';
import { persistProofBoundHascStageArtifactV1 } from './congressional-durable-semantic-artifact-factory-v1.js';
import type { ExtractionArtifactStoreV1 } from './extraction-artifact-store.js';

const FY = 2099;
const DOCUMENT_KEY = 'hasc-stage-doc';
const SOURCE_DOCUMENT_ID = 'source-document-id';
const profile = createHascSourceProfileV1({
  fiscalYear: FY,
  reportNumber: 'H. Rept. 119-001',
  sourceDocumentKeys: [DOCUMENT_KEY],
});
const context = adapterTestContext({
  manifestDocumentKey: DOCUMENT_KEY,
  sourceDocumentId: SOURCE_DOCUMENT_ID,
  sourcePdfSha256: ADAPTER_TEST_SOURCE_SHA,
  sourceLocator: 'source.pdf',
  fiscalYear: FY,
  family: 'committee',
  exhibit: 'committee_report',
  authority: 'hasc',
  budgetCycle: 'hasc',
  documentType: 'committee_report',
  parser: {
    method: 'deterministic_pdfplumber',
    parserVersion: 'test-parser',
    parserConfigSha256: ADAPTER_TEST_CONFIG_SHA,
    outputArtifactSha256: '2'.repeat(64),
    pageRanges: [{ startPage: 1, endPage: 1 }],
  },
});
const result = sealParserRuntimeResult({
  schemaVersion: 'defense_budget_parser_result_v1',
  jobId: 'hasc-stage-test',
  engine: 'deterministic_pdfplumber',
  parserVersion: 'test-parser',
  parserConfigSha256: ADAPTER_TEST_CONFIG_SHA,
  inputSourceSha256: ADAPTER_TEST_SOURCE_SHA,
  requestedPages: [1],
  succeededPages: [1],
  failedPages: [],
  pages: [
    {
      page: 1,
      text: 'mixed-family table',
      blocks: [],
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
    engineVersion: 'test',
  },
});
const parserRunId = parserRunIdV1({
  sourceSha256: result.inputSourceSha256,
  method: result.engine,
  parserVersion: result.parserVersion,
  parserConfigSha256: result.parserConfigSha256,
  requestedPages: result.requestedPages,
});
const identity = { lineKind: 'RDTE_PE' as const, peCode: '0601102A' };
const table: CongressionalTableV1 = {
  schemaVersion: CONGRESSIONAL_TABLE_SCHEMA_VERSION,
  profileId: profile.profileId,
  sourceDocumentId: SOURCE_DOCUMENT_ID,
  sourceSha256: ADAPTER_TEST_SOURCE_SHA,
  page: 1,
  headings: ['TITLE II'],
  declaredUnit: 'thousands',
  columns: [
    { columnIndex: 0, headerText: 'Line', isQuantity: false },
    {
      columnIndex: 1,
      headerText: 'FY 2099 Request',
      isQuantity: false,
      moneySemantic: 'request_baseline',
      fiscalYear: FY,
    },
    {
      columnIndex: 2,
      headerText: 'Change',
      isQuantity: false,
      moneySemantic: 'change',
      fiscalYear: FY,
    },
  ],
  rows: [
    {
      rowIndex: 0,
      rawLabel: '0601102A',
      reference: { referenceKind: 'pe_code', peCode: identity.peCode },
      semanticKind: 'absolute_position',
      cells: [
        { rowIndex: 0, columnIndex: 0, rawText: identity.peCode },
        { rowIndex: 0, columnIndex: 1, rawText: '100', value: '100' },
        { rowIndex: 0, columnIndex: 2, rawText: '25', value: '25' },
      ],
    },
  ],
};
const index: NativeIdentityIndexEntry[] = [{ identity, manifestDocumentKey: 'request-r1' }];

function store(): ExtractionArtifactStoreV1 {
  return {
    putImmutable: async ({ bytes }) => ({
      locator: 'memory://artifact',
      byteSha256: sha256Bytes(bytes),
    }),
    readVerified: async () => Buffer.from('{}'),
    materializeForLocalConsumer: async () => ({
      localPath: 'memory://artifact',
      cleanup: async () => undefined,
    }),
  };
}

describe('native congressional stage durable factory', () => {
  it('composes a mixed-family-capable HASC packet and persists proof-bound bytes', async () => {
    const parserRun: ParserRunV1 = {
      parserRunId,
      method: result.engine,
      parserVersion: result.parserVersion,
      parserConfigSha256: result.parserConfigSha256,
      inputSourceSha256: result.inputSourceSha256,
      outputArtifactSha256: result.contentSha256,
      pageRanges: [{ startPage: 1, endPage: 1 }],
      requestedPages: result.requestedPages,
      succeededPages: result.succeededPages,
      failedPages: result.failedPages,
    };
    const output = await persistProofBoundHascStageArtifactV1({
      budgetFamily: 'committee',
      factoryContext: { profile, context },
      tables: [table],
      resolutionContext: { index, fiscalYear: FY, profileId: profile.profileId },
      parserResultProofs: [{ parserRunId, result, resultByteSha256: '3'.repeat(64) }],
      store: store(),
    });
    expect(output.artifact.parserRuns).toEqual([parserRun]);
    expect(
      output.artifact.assertions.some((assertion) => assertion.assertionKind === 'funding'),
    ).toBe(true);
    expect(output.artifactByteSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed when a table page is not covered by the persisted proof', async () => {
    await expect(
      persistProofBoundHascStageArtifactV1({
        budgetFamily: 'committee',
        factoryContext: { profile, context },
        tables: [{ ...table, page: 2 }],
        resolutionContext: { index, fiscalYear: FY, profileId: profile.profileId },
        parserResultProofs: [{ parserRunId, result, resultByteSha256: '3'.repeat(64) }],
        store: store(),
      }),
    ).rejects.toThrow('not covered by a successful parser proof page');
  });
});
