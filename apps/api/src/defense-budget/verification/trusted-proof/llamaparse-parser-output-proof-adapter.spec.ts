import {
  canonicalJsonStringify,
  sha256Bytes,
  type JsonValue,
} from '../../contracts/canonical-json.js';
import {
  sealParserRuntimeResult,
  type ParserRuntimeResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { LlamaParseParserOutputProofAdapter } from './parser-output-proof-adapters.js';
import type { ParseJobClient, ParseJobRow } from './parser-run-proof-resolver.js';
import type {
  TrustedByteLocatorReader,
  TrustedLocatedBytes,
} from './trusted-byte-locator-reader.js';

const SOURCE_SHA = 'a'.repeat(64);
const CONFIG_SHA = 'b'.repeat(64);

function normalizedResult(): ParserRuntimeResultV1 {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'normalized-run-1',
    engine: 'llamaparse',
    parserVersion: 'llamaparse-v1',
    parserConfigSha256: CONFIG_SHA,
    inputSourceSha256: SOURCE_SHA,
    requestedPages: [1, 3],
    succeededPages: [1, 3],
    failedPages: [],
    pages: [1, 3].map((page) => ({
      page,
      blocks: [],
      tables: [],
      images: [],
      evidencePrecision: 'page_only' as const,
      warnings: [],
    })),
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: 2,
      pagesSucceeded: 2,
      pagesFailed: 0,
      engineVersion: 'llamaparse-v1',
    },
  });
}

function jobFor(result: ParserRuntimeResultV1, byteSha: string): ParseJobRow {
  return {
    id: 'parse-job-1',
    sourceDocumentId: 'source-document-1',
    provider: 'llamaparse',
    providerJobId: 'provider-job-1',
    mode: 'pdf_premium',
    resultType: 'json',
    pageStart: 1,
    pageEnd: 3,
    inputSha256: SOURCE_SHA,
    outputMarkdownS3Key: null,
    outputJsonS3Key: 's3://proof-bucket/parser/result.json?versionId=v1',
    status: 'succeeded',
    error: null,
    metadata: {
      exactPageList: [1, 3],
      parserVersion: result.parserVersion,
      parserConfigSha256: result.parserConfigSha256,
      outputByteSha256: byteSha,
      normalizedResultSha256: result.contentSha256,
    },
  };
}

function adapter(input?: {
  result?: ParserRuntimeResultV1;
  bytes?: Buffer;
  metadata?: Record<string, unknown>;
}) {
  const result = input?.result ?? normalizedResult();
  const bytes =
    input?.bytes ?? Buffer.from(canonicalJsonStringify(result as unknown as JsonValue), 'utf8');
  const row = jobFor(result, sha256Bytes(bytes));
  if (input?.metadata) row.metadata = input.metadata;
  const parseJobClient: ParseJobClient = {
    documentParseJob: {
      findFirst: jest.fn(async () => row),
    },
  };
  const reader: TrustedByteLocatorReader = {
    read: jest.fn(async (locator: string): Promise<TrustedLocatedBytes> => ({
      locator,
      bytes,
      kind: 's3',
      bucket: 'proof-bucket',
      key: 'parser/result.json',
      versionId: 'v1',
    })),
  };
  return {
    row,
    instance: new LlamaParseParserOutputProofAdapter({
      parseJobClient,
      byteLocatorReader: reader,
      outputBucket: 'proof-bucket',
      requireDeclarationBinding: true,
    }),
  };
}

describe('LlamaParseParserOutputProofAdapter', () => {
  it('recomputes normalized content from exact persisted bytes and preserves noncontiguous pages', async () => {
    const result = normalizedResult();
    const { instance } = adapter({ result });
    const proof = await instance.resolveParserOutput({
      parserRunId: 'parser-run-1',
      method: 'llamaparse',
      sourceDocumentId: 'source-document-1',
      providerJobId: 'provider-job-1',
      declaredOutputSha256: result.contentSha256,
    });

    expect(proof).toMatchObject({
      outputContentSha256: result.contentSha256,
      inputSourceSha256: SOURCE_SHA,
      parserVersion: 'llamaparse-v1',
      parserConfigSha256: CONFIG_SHA,
      succeededPages: [1, 3],
    });
  });

  it('rejects bytes whose embedded normalized content SHA does not recompute', async () => {
    const result = normalizedResult();
    const tampered = {
      ...result,
      pages: [{ ...result.pages[0], page: 1, text: 'tampered' }, result.pages[1]],
    };
    const bytes = Buffer.from(
      canonicalJsonStringify(tampered as unknown as JsonValue),
      'utf8',
    );
    const { instance, row } = adapter({ result, bytes });
    row.metadata = {
      parserVersion: result.parserVersion,
      parserConfigSha256: result.parserConfigSha256,
      outputByteSha256: sha256Bytes(bytes),
      normalizedResultSha256: result.contentSha256,
    };

    await expect(
      instance.resolveParserOutput({
        parserRunId: 'parser-run-1',
        method: 'llamaparse',
        sourceDocumentId: 'source-document-1',
        providerJobId: 'provider-job-1',
        declaredOutputSha256: result.contentSha256,
      }),
    ).rejects.toThrow(/content SHA does not recompute/);
  });

  it('rejects metadata that names a different normalized result SHA', async () => {
    const result = normalizedResult();
    const bytes = Buffer.from(canonicalJsonStringify(result as unknown as JsonValue), 'utf8');
    const { instance } = adapter({
      result,
      bytes,
      metadata: {
        parserVersion: result.parserVersion,
        parserConfigSha256: result.parserConfigSha256,
        outputByteSha256: sha256Bytes(bytes),
        normalizedResultSha256: 'f'.repeat(64),
      },
    });

    await expect(
      instance.resolveParserOutput({
        parserRunId: 'parser-run-1',
        method: 'llamaparse',
        sourceDocumentId: 'source-document-1',
        providerJobId: 'provider-job-1',
        declaredOutputSha256: result.contentSha256,
      }),
    ).rejects.toThrow(/does not match recorded SHA/);
  });
});
