import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FilesystemParserArtifactStore } from '../../parser-router/parser-artifact-store.js';
import {
  computeParserRunId,
  sealParserRuntimeResult,
  type ParserRunIdentityV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { sha256Bytes } from '../../contracts/canonical-json.js';
import {
  FilesystemParserOutputProofAdapter,
  LlamaParseParserOutputProofAdapter,
} from './parser-output-proof-adapters.js';

const SOURCE_SHA = 'a'.repeat(64);
const CONFIG_SHA = 'b'.repeat(64);

function identity(): ParserRunIdentityV1 {
  return {
    sourceSha256: SOURCE_SHA,
    method: 'deterministic_pdfplumber',
    parserVersion: '1.0.0',
    parserConfigSha256: CONFIG_SHA,
    pages: [1],
    runtimeContractVersion: 'defense_budget_parser_job_v1',
  };
}

function resultFor(runIdentity: ParserRunIdentityV1) {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'job-1',
    engine: runIdentity.method,
    parserVersion: runIdentity.parserVersion,
    parserConfigSha256: runIdentity.parserConfigSha256,
    inputSourceSha256: runIdentity.sourceSha256,
    requestedPages: [1],
    succeededPages: [1],
    failedPages: [],
    pages: [
      {
        page: 1,
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
      engineVersion: '1.0.0',
    },
  });
}

describe('R8.3 strict parser output declaration binding', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'r83-parser-proof-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects a local parser-run declaration that names the wrong content SHA', async () => {
    const runIdentity = identity();
    const result = resultFor(runIdentity);
    const store = new FilesystemParserArtifactStore(root);
    await store.putVerified({
      identity: runIdentity,
      result,
      resultJson: JSON.stringify(result),
    });
    const adapter = new FilesystemParserOutputProofAdapter(root, {
      requireDeclarationBinding: true,
    });

    await expect(
      adapter.resolveParserOutput({
        parserRunId: computeParserRunId(runIdentity),
        method: runIdentity.method,
        sourceDocumentId: 'source-1',
        declaredOutputSha256: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/does not match persisted parser output content SHA/);
  });

  it('accepts the exact local parser result content SHA', async () => {
    const runIdentity = identity();
    const result = resultFor(runIdentity);
    const store = new FilesystemParserArtifactStore(root);
    await store.putVerified({
      identity: runIdentity,
      result,
      resultJson: JSON.stringify(result),
    });
    const adapter = new FilesystemParserOutputProofAdapter(root, {
      requireDeclarationBinding: true,
    });

    const proof = await adapter.resolveParserOutput({
      parserRunId: computeParserRunId(runIdentity),
      method: runIdentity.method,
      sourceDocumentId: 'source-1',
      declaredOutputSha256: result.contentSha256,
    });
    expect(proof?.outputContentSha256).toBe(result.contentSha256);
  });

  it('requires LlamaParse normalized-result and raw-byte SHA metadata', async () => {
    const bytes = Buffer.from('{"raw":"llamaparse"}', 'utf8');
    const byteSha = sha256Bytes(bytes);
    const normalizedSha = 'c'.repeat(64);
    const parseJobClient = {
      documentParseJob: {
        findFirst: jest.fn(async () => ({
          id: 'parse-job-1',
          sourceDocumentId: 'source-1',
          provider: 'llamaparse',
          providerJobId: 'provider-1',
          mode: 'pdf_premium',
          resultType: 'json',
          pageStart: 1,
          pageEnd: 1,
          inputSha256: SOURCE_SHA,
          outputMarkdownS3Key: null,
          outputJsonS3Key: 'derived/result.json',
          status: 'succeeded',
          error: null,
          metadata: {
            parserVersion: 'llamaparse-v1',
            parserConfigSha256: CONFIG_SHA,
            normalizedResultSha256: normalizedSha,
            outputByteSha256: byteSha,
          },
        })),
      },
    };
    const byteLocatorReader = {
      read: jest.fn(async (locator: string) => ({
        locator,
        bytes,
        kind: 's3' as const,
        contentLength: bytes.length,
      })),
    };
    const adapter = new LlamaParseParserOutputProofAdapter({
      parseJobClient,
      byteLocatorReader,
      outputBucket: 'test-bucket',
      requireDeclarationBinding: true,
    });

    await expect(
      adapter.resolveParserOutput({
        parserRunId: 'llama-run-1',
        method: 'llamaparse',
        sourceDocumentId: 'source-1',
        providerJobId: 'provider-1',
        declaredOutputSha256: 'd'.repeat(64),
      }),
    ).rejects.toThrow(/does not match persisted normalized result SHA/);

    const proof = await adapter.resolveParserOutput({
      parserRunId: 'llama-run-1',
      method: 'llamaparse',
      sourceDocumentId: 'source-1',
      providerJobId: 'provider-1',
      declaredOutputSha256: normalizedSha,
    });
    expect(proof?.outputContentSha256).toBe(normalizedSha);
    expect(proof?.outputByteSha256).toBe(byteSha);
  });
});
