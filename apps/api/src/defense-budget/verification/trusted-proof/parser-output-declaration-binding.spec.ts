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

function identity(overrides: Partial<ParserRunIdentityV1> = {}): ParserRunIdentityV1 {
  return {
    sourceSha256: SOURCE_SHA,
    method: 'deterministic_pdfplumber',
    parserVersion: '1.0.0',
    parserConfigSha256: CONFIG_SHA,
    pages: [1],
    runtimeContractVersion: 'defense_budget_parser_job_v1',
    ...overrides,
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
    requestedPages: [...runIdentity.pages],
    succeededPages: [...runIdentity.pages],
    failedPages: [],
    pages: runIdentity.pages.map((page) => ({
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
      pagesProcessed: runIdentity.pages.length,
      pagesSucceeded: runIdentity.pages.length,
      pagesFailed: 0,
      engineVersion: runIdentity.parserVersion,
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
    const llamaIdentity = identity({
      method: 'llamaparse',
      parserVersion: 'llamaparse-v1',
    });
    const normalizedResult = resultFor(llamaIdentity);
    const bytes = Buffer.from(JSON.stringify(normalizedResult), 'utf8');
    const byteSha = sha256Bytes(bytes);
    const normalizedSha = normalizedResult.contentSha256;
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
            parserVersion: normalizedResult.parserVersion,
            parserConfigSha256: normalizedResult.parserConfigSha256,
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
    ).rejects.toThrow(/does not match independently recomputed normalized result SHA/);

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
