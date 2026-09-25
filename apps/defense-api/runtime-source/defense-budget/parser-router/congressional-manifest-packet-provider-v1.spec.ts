import { sha256Bytes } from '../contracts/canonical-json.js';
import {
  adapterTestContext,
  ADAPTER_TEST_CONFIG_SHA,
  ADAPTER_TEST_SOURCE_SHA,
} from '../contracts/adapters/testing-helpers.js';
import { createHascSourceProfileV1 } from '../stages/authorization/hasc-source-profile-v1.js';
import { sealParserRuntimeResult } from './parser-runtime-contract-v1.js';
import { parserRunIdV1 } from './parser-run-identity-v1.js';
import type { ParserArtifactStoreV1 } from './parser-artifact-store.js';
import { loadCongressionalFactoryInputsV1 } from './congressional-manifest-packet-provider-v1.js';

const result = sealParserRuntimeResult({
  schemaVersion: 'defense_budget_parser_result_v1',
  jobId: 'manifest-test',
  engine: 'deterministic_pdfplumber',
  parserVersion: 'test-1',
  parserConfigSha256: ADAPTER_TEST_CONFIG_SHA,
  inputSourceSha256: ADAPTER_TEST_SOURCE_SHA,
  requestedPages: [1],
  succeededPages: [1],
  failedPages: [],
  pages: [
    {
      page: 1,
      text: 'row',
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
const runId = parserRunIdV1({
  sourceSha256: result.inputSourceSha256,
  method: result.engine,
  parserVersion: result.parserVersion,
  parserConfigSha256: result.parserConfigSha256,
  requestedPages: result.requestedPages,
});
const profile = createHascSourceProfileV1({
  fiscalYear: 2027,
  reportNumber: 'H. Rept. test',
  sourceDocumentKeys: ['doc-a'],
});
profile.requiredLineFamilies = ['rdte_pe'];
const packetBytes = Buffer.from(
  JSON.stringify({
    schemaVersion: 'congressional_structured_packet_v1',
    documentKey: 'doc-a',
    stage: 'hasc',
    fiscalYear: 2027,
    declaredUnit: 'thousands',
    profileId: profile.profileId,
    sourcePdfSha256: ADAPTER_TEST_SOURCE_SHA,
    artifact: {
      chamber: 'HASC',
      fy: 2027,
      rows: [{ peCode: '0601102A', fy: 2027, mark: '10', markUnit: 'thousands', page: 1 }],
    },
  }),
);
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'congressional_packet_manifest_v1',
    documents: [
      {
        documentKey: 'doc-a',
        stage: 'hasc',
        fiscalYear: 2027,
        declaredUnit: 'thousands',
        sourcePdfSha256: ADAPTER_TEST_SOURCE_SHA,
        sourceLocator: 'source.pdf',
        packetLocator: 'packet.json',
        packetByteSha256: sha256Bytes(packetBytes),
        profile,
        context: adapterTestContext({
          manifestDocumentKey: 'doc-a',
          sourceDocumentId: 'source-a',
          sourcePdfSha256: ADAPTER_TEST_SOURCE_SHA,
          sourceLocator: 'source.pdf',
          fiscalYear: 2027,
          family: 'committee',
          exhibit: 'committee_report',
          authority: 'hasc',
          budgetCycle: 'pb_fy2027',
          parser: {
            method: result.engine,
            parserVersion: result.parserVersion,
            parserConfigSha256: result.parserConfigSha256,
            outputArtifactSha256: result.contentSha256,
            pageRanges: [{ startPage: 1, endPage: 1 }],
          },
        }),
        parserRuns: [
          {
            sourceSha256: ADAPTER_TEST_SOURCE_SHA,
            method: result.engine,
            parserVersion: result.parserVersion,
            parserConfigSha256: result.parserConfigSha256,
            requestedPages: [1],
            runtimeContractVersion: 'defense_budget_parser_job_v1',
          },
        ],
        ...overrides,
      },
    ],
  };
}
function store(resultValue = result): ParserArtifactStoreV1 {
  const descriptor = {
    parserRunId: runId,
    sourceSha256: result.inputSourceSha256,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    requestedPages: result.requestedPages,
    contentSha256: result.contentSha256,
    byteSha256: 'b'.repeat(64),
    resultLocator: 'proof.json',
  } as never;
  return {
    findExact: async () => descriptor,
    readVerified: async () => resultValue,
    putVerified: async () => descriptor,
  };
}
const request = { documentKey: 'doc-a', profileId: profile.profileId, stage: 'hasc' } as const;

describe('congressional manifest packet provider', () => {
  it('loads an exact packet and persisted proof for factory readback', async () => {
    const loaded = await loadCongressionalFactoryInputsV1({
      manifest: manifest(),
      request,
      parserArtifactStore: store(),
      readPacket: async () => packetBytes,
    });
    expect(loaded.input.rows).toHaveLength(1);
    expect(loaded.factoryContext.context.sourcePdfSha256).toBe(ADAPTER_TEST_SOURCE_SHA);
    expect(loaded.parserResultProofs[0]?.parserRunId).toBe(runId);
    expect(loaded.parserResultProofs[0]?.resultByteSha256).toBe('b'.repeat(64));
  });
  it('rejects a wrong packet digest and requested document/profile identity', async () => {
    await expect(
      loadCongressionalFactoryInputsV1({
        manifest: manifest({ packetByteSha256: 'c'.repeat(64) }),
        request,
        parserArtifactStore: store(),
        readPacket: async () => packetBytes,
      }),
    ).rejects.toThrow('packet byte SHA');
    await expect(
      loadCongressionalFactoryInputsV1({
        manifest: manifest(),
        request: { ...request, documentKey: 'missing' },
        parserArtifactStore: store(),
        readPacket: async () => packetBytes,
      }),
    ).rejects.toThrow('exactly one manifest document');
    const wrongPacket = Buffer.from(packetBytes.toString('utf8').replace('"doc-a"', '"doc-other"'));
    await expect(
      loadCongressionalFactoryInputsV1({
        manifest: manifest({ packetByteSha256: sha256Bytes(wrongPacket) }),
        request,
        parserArtifactStore: store(),
        readPacket: async () => wrongPacket,
      }),
    ).rejects.toThrow('document/profile/source binding');
  });
  it('rejects source-SHA drift, missing proofs, and a tampered proof result', async () => {
    await expect(
      loadCongressionalFactoryInputsV1({
        manifest: manifest({ sourcePdfSha256: 'd'.repeat(64) }),
        request,
        parserArtifactStore: store(),
        readPacket: async () => packetBytes,
      }),
    ).rejects.toThrow('source PDF binding');
    const missing = { ...store(), findExact: async () => null } as ParserArtifactStoreV1;
    await expect(
      loadCongressionalFactoryInputsV1({
        manifest: manifest(),
        request,
        parserArtifactStore: missing,
        readPacket: async () => packetBytes,
      }),
    ).rejects.toThrow('was not found');
    const { contentSha256: _contentSha256, ...unsealedResult } = result;
    const wrongSourceResult = sealParserRuntimeResult({
      ...unsealedResult,
      inputSourceSha256: 'e'.repeat(64),
    });
    await expect(
      loadCongressionalFactoryInputsV1({
        manifest: manifest(),
        request,
        parserArtifactStore: store(wrongSourceResult),
        readPacket: async () => packetBytes,
      }),
    ).rejects.toThrow('does not match manifest identity');
  });
});
