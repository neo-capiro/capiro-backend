/** File-envelope client for the isolated Python parser runtime. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseParserRuntimeJobV1,
  parseParserRuntimeResultV1,
  type ParserRuntimeJobV1,
  type ParserRuntimeResultV1,
} from './parser-runtime-contract-v1.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';

export interface LocalParserRuntimeClientOptions {
  command?: string;
  commandArgs?: string[];
  cwd?: string;
  workDir: string;
  timeoutMs?: number;
}

export interface ExecuteJobResult {
  result: ParserRuntimeResultV1;
  exitCode: number;
  stderr: string;
}

export interface ParserRuntimeVersionInfoV1 {
  runtimeVersion: string;
  engines: Partial<Record<ExtractionMethodV1, string>>;
}

export class LocalParserRuntimeClient {
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly cwd: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: LocalParserRuntimeClientOptions) {
    this.command = options.command ?? 'capiro-defense-budget-parser';
    this.commandArgs = options.commandArgs ?? [];
    this.cwd = options.cwd ?? options.workDir;
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    mkdirSync(options.workDir, { recursive: true });
  }

  async executeJob(input: { job: ParserRuntimeJobV1 }): Promise<ExecuteJobResult> {
    const job = parseParserRuntimeJobV1(input.job);
    const safeJobId = job.jobId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const jobPath = join(this.options.workDir, `${safeJobId}.job.json`);
    const resultPath = join(this.options.workDir, `${safeJobId}.result.json`);
    writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');

    const processResult = await this.invokeRuntime([
      'run',
      '--job',
      jobPath,
      '--out',
      resultPath,
    ]);
    if (processResult.exitCode !== 0 && processResult.exitCode !== 5) {
      throw new Error(
        `parser runtime exited ${processResult.exitCode}: ${processResult.stderr || 'no stderr'}`,
      );
    }
    const result = parseParserRuntimeResultV1(
      JSON.parse(readFileSync(resultPath, 'utf8')),
    );
    if (result.engine !== job.engine) {
      throw new Error(
        `parser method relabeling detected: job=${job.engine} result=${result.engine}`,
      );
    }
    if (result.inputSourceSha256 !== job.sourceSha256) {
      throw new Error('parser result source SHA does not match the submitted job');
    }
    if (
      result.parserVersion !== job.parserVersion ||
      result.parserConfigSha256 !== job.parserConfigSha256
    ) {
      throw new Error('parser result version/config identity does not match the submitted job');
    }
    if (JSON.stringify(result.requestedPages) !== JSON.stringify(job.requestedPages)) {
      throw new Error('parser result requested pages do not match the submitted job');
    }
    return { ...processResult, result };
  }

  async validateJob(jobPath: string) {
    const result = await this.invokeRuntime(['validate-job', '--job', jobPath]);
    return { valid: result.exitCode === 0, ...result };
  }

  async profileJob(jobPath: string, resultPath: string) {
    return this.invokeRuntime(['profile', '--job', jobPath, '--out', resultPath]);
  }

  async getVersionInfo(): Promise<ParserRuntimeVersionInfoV1> {
    const result = await this.invokeRuntime(['version', '--json'], true);
    if (result.exitCode !== 0) {
      throw new Error(`parser runtime version query failed: ${result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { runtimeVersion?: unknown }).runtimeVersion !== 'string' ||
      typeof (parsed as { engines?: unknown }).engines !== 'object' ||
      (parsed as { engines?: unknown }).engines === null
    ) {
      throw new Error('parser runtime returned invalid version metadata');
    }
    return parsed as ParserRuntimeVersionInfoV1;
  }

  private invokeRuntime(
    args: string[],
    captureStdout = false,
  ): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    return new Promise((resolve, reject) => {
      const processHandle = spawn(this.command, [...this.commandArgs, ...args], {
        cwd: this.cwd,
        timeout: this.timeoutMs,
        env: { ...process.env },
      });
      let stderr = '';
      let stdout = '';
      processHandle.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      processHandle.stdout?.on('data', (chunk: Buffer) => {
        if (captureStdout) stdout += chunk.toString('utf8');
      });
      processHandle.on('error', (error) => {
        reject(new Error(`failed to start parser runtime: ${error.message}`));
      });
      processHandle.on('close', (code) => {
        resolve({ exitCode: code ?? 1, stderr, stdout });
      });
    });
  }
}
