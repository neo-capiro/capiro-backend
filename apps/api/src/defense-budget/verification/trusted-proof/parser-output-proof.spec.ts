/**
 * R8.2 Workstream C — independent parser-output proof.
 *
 * No parser run receives `proofStatus: 'verified'` unless independently
 * persisted output bytes were loaded and verified. Covers the required test
 * list:
 *
 *   1. local parser output missing (legacy);
 *   2. local parser output byte mismatch;
 *   3. local parser config mismatch;
 *   4. local parser version mismatch;
 *   5. source SHA mismatch;
 *   6. output locator points to wrong object;
 *   7. LlamaParse row exists but object is missing;
 *   8. LlamaParse object hash mismatch;
 *   9. provider job mismatch;
 *   10. incomplete page coverage;
 *   11. valid persisted parser output succeeds.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ParserRunProofResolver, type ParseJobRow } from './parser-run-proof-resolver.js';
import {
  FilesystemParserOutputProofAdapter,
  LlamaParseParserOutputProofAdapter,
  CompositeParserOutputProofSource,
} from './parser-output-proof-adapters.js';
import { FilesystemParserArtifactStore } from '../../parser-router/parser-artifact-store.js';
import {
  computeParserRunId,
  sealParserRuntimeResult,
  type ParserRuntimeResultV1,
  type ParserRunIdentityV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import { computeArtifactContentSha256 } from '../../contracts/extraction-artifact-v1.semantic.js';

const SOURCE_SHA = 'a'.repeat(64);
const OTHER_SOURCE_SHA = 'b'.repeat(64);
const CONFIG_SHA = 'c'.repeat(64);
const OTHER_CONFIG_SHA = 'd'.repeat(64);

function makeArtifact(overrides: Partial<DefenseBudgetExtractionArtifactV1> = {}) {
  const artifact = {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: 'dbx1_c',
    contentSha256: '0'.repeat(64),
    source: {
      manifestDocumentKey: 'r1_army_fy2027',
      sourceDocumentId: 'sd-1',
      sourcePdfSha256: SOURCE_SHA,
      sourceLocator: '/r1.pdf',
      fiscalYear: 2027,
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r1',
    },
    parserRuns: [],
    evidence: [],
    sourceFacts: [],
    assertions: [],
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: 0,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
    ...overrides,
  } as unknown as DefenseBudgetExtractionArtifactV1;
  const contentSha = computeArtifactContentSha256(artifact);
  artifact.contentSha256 = contentSha;
  for (const run of artifact.parserRuns) {
    run.outputArtifactSha256 = contentSha;
  }
  return artifact;
}

function makeIdentity(overrides: Partial<ParserRunIdentityV1> = {}): ParserRunIdentityV1 {
  return {
    sourceSha256: SOURCE_SHA,
    method: 'deterministic_pdfplumber',
    parserVersion: '1.0',
    parserConfigSha256: CONFIG_SHA,
    pages: [1],
    runtimeContractVersion: 'defense_budget_parser_job_v1',
    ...overrides,
  };
}

function makeResult(identity: ParserRunIdentityV1): ParserRuntimeResultV1 {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'job-1',
    engine: identity.method,
    parserVersion: identity.parserVersion,
    parserConfigSha256: identity.parserConfigSha256,
    inputSourceSha256: identity.sourceSha256,
    requestedPages: [...identity.pages],
    succeededPages: [...identity.pages],
    failedPages: [],
    pages: identity.pages.map((page: number) => ({
      page,
      blocks: [],
      tables: [],
      images: [],
      evidencePrecision: 'page_only' as const,
      warnings: [],
    })),
    warnings: [],
    metrics: {
      durationMillis: 5,
      pagesProcessed: identity.pages.length,
      pagesSucceeded: identity.pages.length,
      pagesFailed: 0,
      engineVersion: '1.0',
    },
  });
}

function makeParseJob(overrides: Partial<ParseJobRow> = {}): ParseJobRow {
  return {
    id: 'pj-1',
    sourceDocumentId: 'sd-1',
    provider: 'llamaparse',
    providerJobId: 'job-A',
    mode: 'pdf_premium',
    resultType: 'json',
    pageStart: 1,
    pageEnd: 1,
    inputSha256: SOURCE_SHA,
    outputMarkdownS3Key: null,
    outputJsonS3Key: 'derived/out.json',
    status: 'succeeded',
    error: null,
    ...overrides,
  };
}

describe('R8.2-C local parser output proof (real content-addressed store)', () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r82c-store-'));
  });

  afterEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  async function seedStore(identity: ParserRunIdentityV1) {
    const store = new FilesystemParserArtifactStore(storeDir);
    const result = makeResult(identity);
    await store.putVerified({ identity, result, resultJson: JSON.stringify(result) });
    return { store, result };
  }

  function artifactWithRun(identity: ParserRunIdentityV1) {
    const parserRunId = computeParserRunId(identity);
    const artifact = makeArtifact({
      parserRuns: [
        {
          parserRunId,
          method: identity.method,
          parserVersion: identity.parserVersion,
          parserConfigSha256: identity.parserConfigSha256,
          inputSourceSha256: identity.sourceSha256,
          outputArtifactSha256: '0'.repeat(64),
          pageRanges: [{ startPage: 1, endPage: identity.pages.length }],
        },
      ],
    });
    return { artifact, parserRunId };
  }

  it('1. local parser output missing (legacy) -> missing, never verified', async () => {
    const identity = makeIdentity();
    const { artifact } = artifactWithRun(identity);
    // Store is empty: the output was never persisted independently.
    const adapter = new FilesystemParserOutputProofAdapter(storeDir);
    const resolver = new ParserRunProofResolver(undefined, adapter);
    const result = await resolver.resolve({ artifact, actualSourcePdfSha256: SOURCE_SHA });
    expect(result.parserRuns[0]!.proofStatus).toBe('missing');
    expect(result.findings.some((f) => f.code === 'parse_output_missing')).toBe(true);
  });

  it('2. local parser output byte mismatch -> mismatch', async () => {
    const identity = makeIdentity();
    const { result: seededResult } = await seedStore(identity);
    const { artifact } = artifactWithRun(identity);
    // Tamper with the persisted output bytes after persistence.
    const descriptorPath = path.join(
      storeDir,
      `source_sha256=${SOURCE_SHA}`,
      `method=deterministic_pdfplumber`,
      `config_sha256=${CONFIG_SHA}`,
      'pages=1',
      'result.json',
    );
    const tampered = JSON.stringify({
      ...seededResult,
      warnings: [{ code: 'x', message: 'y', pages: [1] }],
    });
    fs.writeFileSync(descriptorPath, tampered, 'utf8');

    const adapter = new FilesystemParserOutputProofAdapter(storeDir);
    const resolver = new ParserRunProofResolver(undefined, adapter);
    const result = await resolver.resolve({ artifact, actualSourcePdfSha256: SOURCE_SHA });
    expect(result.parserRuns[0]!.proofStatus).toBe('mismatch');
  });

  it('3. local parser config mismatch -> mismatch', async () => {
    // Store persisted with CONFIG_SHA, artifact declares OTHER_CONFIG_SHA
    // under the run ID computed from CONFIG_SHA.
    const identity = makeIdentity();
    await seedStore(identity);
    const parserRunId = computeParserRunId(identity);
    const artifact = makeArtifact({
      parserRuns: [
        {
          parserRunId,
          method: identity.method,
          parserVersion: identity.parserVersion,
          parserConfigSha256: OTHER_CONFIG_SHA, // declared config differs
          inputSourceSha256: SOURCE_SHA,
          outputArtifactSha256: '0'.repeat(64),
          pageRanges: [{ startPage: 1, endPage: 1 }],
        },
      ],
    });
    const adapter = new FilesystemParserOutputProofAdapter(storeDir);
    const resolver = new ParserRunProofResolver(undefined, adapter);
    const result = await resolver.resolve({ artifact, actualSourcePdfSha256: SOURCE_SHA });
    expect(result.parserRuns[0]!.proofStatus).toBe('mismatch');
    expect(result.findings.some((f) => f.code === 'parser_config_mismatch')).toBe(true);
  });

  it('4. local parser version mismatch -> mismatch', async () => {
    const identity = makeIdentity();
    await seedStore(identity);
    const parserRunId = computeParserRunId(identity);
    const artifact = makeArtifact({
      parserRuns: [
        {
          parserRunId,
          method: identity.method,
          parserVersion: '2.0', // declared version differs
          parserConfigSha256: identity.parserConfigSha256,
          inputSourceSha256: SOURCE_SHA,
          outputArtifactSha256: '0'.repeat(64),
          pageRanges: [{ startPage: 1, endPage: 1 }],
        },
      ],
    });
    const adapter = new FilesystemParserOutputProofAdapter(storeDir);
    const resolver = new ParserRunProofResolver(undefined, adapter);
    const result = await resolver.resolve({ artifact, actualSourcePdfSha256: SOURCE_SHA });
    expect(result.parserRuns[0]!.proofStatus).toBe('mismatch');
    expect(result.findings.some((f) => f.code === 'parser_version_mismatch')).toBe(true);
  });

  it('5. source SHA mismatch between persisted output and actual bytes -> mismatch', async () => {
    // Store persisted against OTHER_SOURCE_SHA; the verification resolved
    // actual source bytes with SOURCE_SHA.
    const identity = makeIdentity({ sourceSha256: OTHER_SOURCE_SHA });
    await seedStore(identity);
    const parserRunId = computeParserRunId(identity);
    const artifact = makeArtifact({
      parserRuns: [
        {
          parserRunId,
          method: identity.method,
          parserVersion: identity.parserVersion,
          parserConfigSha256: identity.parserConfigSha256,
          inputSourceSha256: SOURCE_SHA,
          outputArtifactSha256: '0'.repeat(64),
          pageRanges: [{ startPage: 1, endPage: 1 }],
        },
      ],
    });
    const adapter = new FilesystemParserOutputProofAdapter(storeDir);
    const resolver = new ParserRunProofResolver(undefined, adapter);
    const result = await resolver.resolve({ artifact, actualSourcePdfSha256: SOURCE_SHA });
    expect(result.parserRuns[0]!.proofStatus).toBe('mismatch');
    expect(result.findings.some((f) => f.code === 'parse_input_sha_mismatch')).toBe(true);
  });

  it('6. output locator points to wrong object -> missing (identity binding)', async () => {
    const identity = makeIdentity();
    await seedStore(identity);
    // Artifact declares a parser run ID that matches NO persisted record.
    const artifact = makeArtifact({
      parserRuns: [
        {
          parserRunId: 'pr1_' + 'e'.repeat(64),
          method: identity.method,
          parserVersion: identity.parserVersion,
          parserConfigSha256: identity.parserConfigSha256,
          inputSourceSha256: SOURCE_SHA,
          outputArtifactSha256: '0'.repeat(64),
          pageRanges: [{ startPage: 1, endPage: 1 }],
        },
      ],
    });
    const adapter = new FilesystemParserOutputProofAdapter(storeDir);
    const resolver = new ParserRunProofResolver(undefined, adapter);
    const result = await resolver.resolve({ artifact, actualSourcePdfSha256: SOURCE_SHA });
    expect(result.parserRuns[0]!.proofStatus).toBe('missing');
    expect(result.parserRuns[0]!.proofStatus).not.toBe('verified');
  });

  it('11. valid persisted parser output succeeds', async () => {
    const identity = makeIdentity();
    await seedStore(identity);
    const { artifact, parserRunId } = artifactWithRun(identity);
    const adapter = new FilesystemParserOutputProofAdapter(storeDir);
    const resolver = new ParserRunProofResolver(undefined, adapter);
    const result = await resolver.resolve({ artifact, actualSourcePdfSha256: SOURCE_SHA });
    expect(result.parserRuns[0]!.proofStatus).toBe('verified');
    expect(result.parserRuns[0]!.persistedParseJobId).toBe(parserRunId);
    expect(result.parserRuns[0]!.outputLocator).toContain('result.json');
    expect(result.findings).toHaveLength(0);
  });

  it('10. incomplete page coverage -> mismatch', async () => {
    const identity = makeIdentity({ pages: [1] });
    await seedStore(identity);
    const parserRunId = computeParserRunId(identity);
    const artifact = makeArtifact({
      parserRuns: [
        {
          parserRunId,
          method: identity.method,
          parserVersion: identity.parserVersion,
          parserConfigSha256: identity.parserConfigSha256,
          inputSourceSha256: SOURCE_SHA,
          outputArtifactSha256: '0'.repeat(64),
          pageRanges: [{ startPage: 1, endPage: 1 }],
        },
      ],
      // Evidence attributed to the run on a page the output never covered.
      evidence: [
        {
          evidenceId: 'ev-1',
          sourcePdfSha256: SOURCE_SHA,
          parserRunId,
          granularity: 'page_only',
          page: 9,
        },
      ],
    });
    const adapter = new FilesystemParserOutputProofAdapter(storeDir);
    const resolver = new ParserRunProofResolver(undefined, adapter);
    const result = await resolver.resolve({ artifact, actualSourcePdfSha256: SOURCE_SHA });
    expect(result.parserRuns[0]!.proofStatus).toBe('mismatch');
    expect(result.findings.some((f) => f.code === 'parse_page_coverage_incomplete')).toBe(true);
  });
});

describe('R8.2-C LlamaParse parser output proof', () => {
  function makeByteReader(bytes: Buffer | null) {
    return {
      async read(locator: string) {
        if (!bytes) throw new Error(`S3 object not found: ${locator}`);
        return {
          locator,
          bytes,
          kind: 's3' as const,
          contentLength: bytes.length,
        };
      },
    };
  }

  function makeParseJobClient(job: ParseJobRow | null) {
    return { documentParseJob: { findFirst: jest.fn(async () => job) } };
  }

  function llamaRun(
    overrides: Partial<DefenseBudgetExtractionArtifactV1['parserRuns'][number]> = {},
  ) {
    return makeArtifact({
      parserRuns: [
        {
          parserRunId: 'run-llama-1',
          method: 'llamaparse',
          parserVersion: '2026-07',
          parserConfigSha256: CONFIG_SHA,
          inputSourceSha256: SOURCE_SHA,
          outputArtifactSha256: '0'.repeat(64),
          pageRanges: [{ startPage: 1, endPage: 1 }],
          providerJobId: 'job-A',
          ...overrides,
        },
      ],
    });
  }

  it('7. row exists but output object is missing -> never verified', async () => {
    const adapter = new LlamaParseParserOutputProofAdapter({
      parseJobClient: makeParseJobClient(makeParseJob()),
      byteLocatorReader: makeByteReader(null),
      outputBucket: 'bucket',
    });
    const resolver = new ParserRunProofResolver(makeParseJobClient(makeParseJob()), adapter);
    const result = await resolver.resolve({
      artifact: llamaRun(),
      actualSourcePdfSha256: SOURCE_SHA,
      sourceDocumentId: 'sd-1',
    });
    expect(result.parserRuns[0]!.proofStatus).not.toBe('verified');
    expect(['missing', 'mismatch']).toContain(result.parserRuns[0]!.proofStatus);
  });

  it('8. LlamaParse object hash mismatch (declared byte SHA binding) -> mismatch', async () => {
    const outputBytes = Buffer.from('{"markdown":"# R-1"}');
    const adapter = new LlamaParseParserOutputProofAdapter({
      parseJobClient: makeParseJobClient(makeParseJob()),
      byteLocatorReader: makeByteReader(outputBytes),
      outputBucket: 'bucket',
    });
    const resolver = new ParserRunProofResolver(makeParseJobClient(makeParseJob()), adapter);
    const artifact = llamaRun({
      metadata: { parserOutputByteSha256: 'f'.repeat(64) },
    });
    const result = await resolver.resolve({
      artifact,
      actualSourcePdfSha256: SOURCE_SHA,
      sourceDocumentId: 'sd-1',
    });
    expect(result.parserRuns[0]!.proofStatus).toBe('mismatch');
    expect(result.findings.some((f) => f.code === 'parse_output_sha_mismatch')).toBe(true);
  });

  it('9. provider job mismatch -> mismatch with provider_job_mismatch finding', async () => {
    const outputBytes = Buffer.from('{"markdown":"# R-1"}');
    // Row exists for a DIFFERENT provider job than declared.
    const job = makeParseJob({ providerJobId: 'job-B' });
    const adapter = new LlamaParseParserOutputProofAdapter({
      parseJobClient: makeParseJobClient(job),
      byteLocatorReader: makeByteReader(outputBytes),
      outputBucket: 'bucket',
    });
    const resolver = new ParserRunProofResolver(makeParseJobClient(job), adapter);
    const result = await resolver.resolve({
      artifact: llamaRun(), // declares providerJobId 'job-A'
      actualSourcePdfSha256: SOURCE_SHA,
      sourceDocumentId: 'sd-1',
    });
    expect(result.parserRuns[0]!.proofStatus).toBe('mismatch');
    expect(result.findings.some((f) => f.code === 'provider_job_mismatch')).toBe(true);
  });

  it('valid persisted LlamaParse output succeeds', async () => {
    const outputBytes = Buffer.from('{"markdown":"# R-1"}');
    const job = makeParseJob();
    const adapter = new LlamaParseParserOutputProofAdapter({
      parseJobClient: makeParseJobClient(job),
      byteLocatorReader: makeByteReader(outputBytes),
      outputBucket: 'bucket',
    });
    const resolver = new ParserRunProofResolver(makeParseJobClient(job), adapter);
    const result = await resolver.resolve({
      artifact: llamaRun(),
      actualSourcePdfSha256: SOURCE_SHA,
      sourceDocumentId: 'sd-1',
    });
    expect(result.parserRuns[0]!.proofStatus).toBe('verified');
    expect(result.parserRuns[0]!.persistedParseJobId).toBe('pj-1');
    expect(result.parserRuns[0]!.outputLocator).toBe('s3://bucket/derived/out.json');
  });
});

describe('R8.2-C composite proof source routing', () => {
  it('routes llamaparse to the llamaparse source and manual never loads bytes', async () => {
    const local = { resolveParserOutput: jest.fn(async () => null) };
    const llama = { resolveParserOutput: jest.fn(async () => null) };
    const composite = new CompositeParserOutputProofSource({
      localSource: local,
      llamaParseSource: llama,
    });
    await composite.resolveParserOutput({
      parserRunId: 'r1',
      method: 'llamaparse',
      sourceDocumentId: 'sd-1',
      declaredOutputSha256: 'x'.repeat(64),
    });
    expect(llama.resolveParserOutput).toHaveBeenCalledTimes(1);
    expect(local.resolveParserOutput).not.toHaveBeenCalled();

    const manual = await composite.resolveParserOutput({
      parserRunId: 'r2',
      method: 'manual',
      sourceDocumentId: 'sd-1',
      declaredOutputSha256: 'x'.repeat(64),
    });
    expect(manual).toBeNull();
    expect(local.resolveParserOutput).not.toHaveBeenCalled();

    await composite.resolveParserOutput({
      parserRunId: 'r3',
      method: 'camelot',
      sourceDocumentId: 'sd-1',
      declaredOutputSha256: 'x'.repeat(64),
    });
    expect(local.resolveParserOutput).toHaveBeenCalledTimes(1);
  });
});
