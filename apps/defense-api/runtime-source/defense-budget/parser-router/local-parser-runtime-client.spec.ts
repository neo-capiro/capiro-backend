/**
 * Phase 10B-17 Blocker 1 -- LocalParserRuntimeClient must not discard a
 * validly-written, schema-conformant result just because every requested
 * page in that one engine step failed (CLI exit 6 / TOTAL_FAILURE). See
 * `executeJob`'s inline comment for the full root-cause explanation: this
 * is what let a single escalation-tier engine failure (e.g. an OCR engine
 * genuinely unavailable for a subset of pages) abort an entire multi-step,
 * 170-page parse plan and discard already-successful earlier steps' real
 * results.
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalParserRuntimeClient } from './local-parser-runtime-client.js';
import {
  computeParserConfigSha256,
  computeResultContentSha256,
  type ParserRuntimeJobV1,
} from './parser-runtime-contract-v1.js';

jest.mock('node:child_process');
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function fakeChildProcess(exitCode: number, stderr = ''): ReturnType<typeof spawn> {
  const proc = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  setImmediate(() => {
    if (stderr) (proc as unknown as { stderr: EventEmitter }).stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode);
  });
  return proc;
}

const SOURCE_SHA = 'a'.repeat(64);
const PARSER_CONFIG_SHA = computeParserConfigSha256({ tableStrategy: 'lines' });

function buildJob(requestedPages: number[]): ParserRuntimeJobV1 {
  return {
    schemaVersion: 'defense_budget_parser_job_v1',
    jobId: 'test-job',
    sourcePath: '/tmp/source.pdf',
    sourceSha256: SOURCE_SHA,
    engine: 'paddleocr',
    requestedPages,
    parserVersion: 'paddleocr-pp-structure-v3-cpu',
    parserConfig: { tableStrategy: 'lines' },
    parserConfigSha256: PARSER_CONFIG_SHA,
    outputDirectory: '/tmp',
    includeDebugArtifacts: false,
  };
}

function totalFailureResult(requestedPages: number[]) {
  const withoutSha = {
    schemaVersion: 'defense_budget_parser_result_v1' as const,
    jobId: 'test-job',
    engine: 'paddleocr' as const,
    parserVersion: 'paddleocr-pp-structure-v3-cpu',
    parserConfigSha256: PARSER_CONFIG_SHA,
    inputSourceSha256: SOURCE_SHA,
    requestedPages,
    succeededPages: [],
    failedPages: requestedPages.map((page) => ({
      page,
      code: 'model_unavailable' as const,
      message: 'PaddleOCR is not installed. Install with: pip install paddleocr paddlepaddle',
    })),
    pages: [],
    warnings: [],
    metrics: {
      durationMillis: 42,
      pagesProcessed: requestedPages.length,
      pagesSucceeded: 0,
      pagesFailed: requestedPages.length,
      engineVersion: 'paddleocr-pp-structure-v3-cpu',
      modelVersions: null,
    },
  };
  const contentSha256 = computeResultContentSha256(withoutSha);
  return { ...withoutSha, contentSha256 };
}

describe('LocalParserRuntimeClient -- exit code 6 (TOTAL_FAILURE) handling', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'local-parser-runtime-client-test-'));
    mockSpawn.mockReset();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns the real per-page failedPages result on exit 6 when the CLI wrote a valid result (graceful degradation)', async () => {
    const job = buildJob([11, 12, 13]);
    const resultPath = join(workDir, 'test-job.result.json');
    writeFileSync(resultPath, JSON.stringify(totalFailureResult(job.requestedPages)), 'utf8');
    mockSpawn.mockImplementation(() => fakeChildProcess(6, 'no stderr'));

    const client = new LocalParserRuntimeClient({ workDir });
    const execution = await client.executeJob({ job });

    expect(execution.exitCode).toBe(6);
    expect(execution.result.succeededPages).toEqual([]);
    expect(execution.result.failedPages).toHaveLength(3);
    expect(execution.result.failedPages.every((f) => f.code === 'model_unavailable')).toBe(true);
  });

  it('still throws on exit 6 when no valid result was ever written (genuine uncaught exception before dispatch)', async () => {
    const job = buildJob([11, 12, 13]);
    // Deliberately do NOT write a result file at resultPath -- simulates
    // cli.py's `except Exception` branch, which also returns exit 6 but
    // never reaches `_write_result`.
    mockSpawn.mockImplementation(() => fakeChildProcess(6, 'parser error: something raised'));

    const client = new LocalParserRuntimeClient({ workDir });
    await expect(client.executeJob({ job })).rejects.toThrow(/parser runtime exited 6/);
  });

  it('still throws immediately on a genuine contract violation (exit 2) without attempting to read a result', async () => {
    const job = buildJob([11, 12, 13]);
    const resultPath = join(workDir, 'test-job.result.json');
    // Even if a stale/unrelated file exists at this path, exit 2 must never
    // be treated as a valid, schema-conformant result.
    writeFileSync(resultPath, JSON.stringify(totalFailureResult(job.requestedPages)), 'utf8');
    mockSpawn.mockImplementation(() => fakeChildProcess(2, 'contract/argument failure: bad job'));

    const client = new LocalParserRuntimeClient({ workDir });
    await expect(client.executeJob({ job })).rejects.toThrow(/parser runtime exited 2/);
  });

  it('exit 5 (PARTIAL) behavior is unchanged: reads the mixed succeeded/failed result', async () => {
    const job = buildJob([11, 12, 13]);
    const resultPath = join(workDir, 'test-job.result.json');
    const withoutSha = {
      ...totalFailureResult(job.requestedPages),
      succeededPages: [11],
      failedPages: totalFailureResult(job.requestedPages).failedPages.slice(1),
    };
    delete (withoutSha as { contentSha256?: string }).contentSha256;
    const contentSha256 = computeResultContentSha256(withoutSha as never);
    writeFileSync(resultPath, JSON.stringify({ ...withoutSha, contentSha256 }), 'utf8');
    mockSpawn.mockImplementation(() => fakeChildProcess(5, 'no stderr'));

    const client = new LocalParserRuntimeClient({ workDir });
    const execution = await client.executeJob({ job });
    expect(execution.result.succeededPages).toEqual([11]);
    expect(execution.result.failedPages).toHaveLength(2);
  });

  it('exit 0 (SUCCESS) behavior is unchanged', async () => {
    const job = buildJob([11]);
    const resultPath = join(workDir, 'test-job.result.json');
    const withoutSha = { ...totalFailureResult(job.requestedPages), succeededPages: [11], failedPages: [] };
    delete (withoutSha as { contentSha256?: string }).contentSha256;
    const contentSha256 = computeResultContentSha256(withoutSha as never);
    writeFileSync(resultPath, JSON.stringify({ ...withoutSha, contentSha256 }), 'utf8');
    mockSpawn.mockImplementation(() => fakeChildProcess(0));

    const client = new LocalParserRuntimeClient({ workDir });
    const execution = await client.executeJob({ job });
    expect(execution.result.succeededPages).toEqual([11]);
    expect(execution.result.failedPages).toEqual([]);
  });

  it('rejects any other unrecognized exit code without attempting to read a result', async () => {
    const job = buildJob([11]);
    mockSpawn.mockImplementation(() => fakeChildProcess(99, 'unexpected'));
    const client = new LocalParserRuntimeClient({ workDir });
    await expect(client.executeJob({ job })).rejects.toThrow(/parser runtime exited 99/);
  });
});
