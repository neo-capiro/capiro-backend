import {
  adapterTestContext,
  ADAPTER_TEST_CONFIG_SHA,
  ADAPTER_TEST_SOURCE_SHA,
} from '../contracts/adapters/testing-helpers.js';
import { createHascSourceProfileV1 } from '../stages/authorization/hasc-source-profile-v1.js';
import { sealParserRuntimeResult } from './parser-runtime-contract-v1.js';
import { resolveSourceDocumentArtifactFactoryV1 } from './source-document-parser-handoff-artifact-factory-v1.js';
import type { SourceDocumentParserHandoffInput } from './source-document-parser-handoff.js';

const sourceDocumentId = 'source-document-db-id';
const sourceKey = 'doc-a';
const sourceLocator = 'source://doc-a';
const parserResult = sealParserRuntimeResult({
  schemaVersion: 'defense_budget_parser_result_v1',
  jobId: 'factory-selection-test',
  engine: 'deterministic_pdfplumber',
  parserVersion: 'test-1',
  parserConfigSha256: ADAPTER_TEST_CONFIG_SHA,
  inputSourceSha256: ADAPTER_TEST_SOURCE_SHA,
  requestedPages: [1],
  succeededPages: [1],
  failedPages: [],
  pages: [],
  warnings: [],
  metrics: {
    durationMillis: 1,
    pagesProcessed: 1,
    pagesSucceeded: 1,
    pagesFailed: 0,
    engineVersion: 'test',
  },
});

function bundle() {
  const profile = createHascSourceProfileV1({
    fiscalYear: 2027,
    reportNumber: 'H. Rept. test',
    sourceDocumentKeys: [sourceKey],
  });
  const context = adapterTestContext({
    manifestDocumentKey: sourceKey,
    sourceDocumentId,
    sourcePdfSha256: ADAPTER_TEST_SOURCE_SHA,
    sourceLocator,
    fiscalYear: 2027,
  });
  return {
    packetBytes: Buffer.from('{}'),
    factoryContext: { profile, context },
    input: { fy: 2027, rows: [] },
    parserResultProofs: [{ parserRunId: 'proof-a', result: parserResult }],
  } as unknown as NonNullable<SourceDocumentParserHandoffInput['congressionalFactoryInputs']>;
}

const handoffIdentity = {
  sourceDocumentId,
  sourceKey,
  sourceSha256: ADAPTER_TEST_SOURCE_SHA,
  sourceLocator,
  fiscalYear: 2027,
  component: 'ARMY' as const,
};

describe('source document congressional artifact factory selection', () => {
  it('selects a factory for a matching validated committee bundle', () => {
    expect(
      typeof resolveSourceDocumentArtifactFactoryV1({
        ...handoffIdentity,
        budgetFamily: 'committee',
        congressionalFactoryInputs: bundle(),
      }),
    ).toBe('function');
  });

  it('requires a bundle for committee and rejects source mismatches', () => {
    expect(() =>
      resolveSourceDocumentArtifactFactoryV1({ ...handoffIdentity, budgetFamily: 'committee' }),
    ).toThrow(/require validated congressional factory inputs/);
    expect(() =>
      resolveSourceDocumentArtifactFactoryV1({
        ...handoffIdentity,
        sourceSha256: 'b'.repeat(64),
        budgetFamily: 'committee',
        congressionalFactoryInputs: bundle(),
      }),
    ).toThrow(/do not match handoff source identity/);
    expect(() =>
      resolveSourceDocumentArtifactFactoryV1({
        ...handoffIdentity,
        sourceKey: 'wrong-manifest-key',
        budgetFamily: 'committee',
        congressionalFactoryInputs: bundle(),
      }),
    ).toThrow(/do not match handoff source identity/);
    expect(() =>
      resolveSourceDocumentArtifactFactoryV1({
        ...handoffIdentity,
        sourceDocumentId: 'wrong-database-id',
        budgetFamily: 'committee',
        congressionalFactoryInputs: bundle(),
      }),
    ).toThrow(/do not match handoff source identity/);
    expect(() =>
      resolveSourceDocumentArtifactFactoryV1({
        ...handoffIdentity,
        component: 'AF',
        budgetFamily: 'committee',
        congressionalFactoryInputs: bundle(),
      }),
    ).toThrow(/do not match handoff source identity/);
  });

  it('keeps non-committee families on their existing selector and rejects supplied committee bundles', () => {
    expect(
      resolveSourceDocumentArtifactFactoryV1({
        ...handoffIdentity,
        budgetFamily: 'rdte',
      }),
    ).toBeUndefined();
    expect(() =>
      resolveSourceDocumentArtifactFactoryV1({
        ...handoffIdentity,
        budgetFamily: 'procurement',
        congressionalFactoryInputs: bundle(),
      }),
    ).toThrow(/only valid for committee/);
  });
});
