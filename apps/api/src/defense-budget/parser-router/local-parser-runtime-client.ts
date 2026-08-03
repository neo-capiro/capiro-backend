/**
 * Workstream E — Local parser runtime client.
 *
 * Bridges the Node-side router to the isolated Python parser runtime
 * via file/job-envelope transport. Node writes one job JSON file and
 * invokes the parser runtime executable. Python writes one canonical
 * JSON result file plus optional debug artifacts under a caller-provided
 * output directory.
 *
 * Required command shape:
 *   capiro-defense-budget-parser run --job /work/job.json --out /work/result.json
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseParserRuntimeJobV1,
  parseParserRuntimeResultV1,
  type ParserRuntimeJobV1,
  type ParserRuntimeResultV1,
} from './parser-runtime-contract-v1.js';

/* ------------------------------------------------------------------ */
/* Local parser runtime client                                          */
/* ------------------------------------------------------------------ */

export interface LocalParserRuntimeClientOptions {
  /** Path to the parser executable or command. */
  command?: string;
  /** Working directory for job/result files. */
  workDir: string;
  /** Timeout in milliseconds (default 5 min). */
  timeoutMs?: number;
}

export interface ExecuteJobOptions {
  job: ParserRuntimeJobV1;
}

export interface ExecuteJobResult {
  result: ParserRuntimeResultV1;
  exitCode: number;
  stderr: string;
}

/**
 * Client that communicates with the isolated Python parser runtime
 * via file/job-envelope transport.
 */
export class LocalParserRuntimeClient {
  private readonly command: string;
  private readonly workDir: string;
  private readonly timeoutMs: number;

  constructor(opts: LocalParserRuntimeClientOptions) {
    this.command = opts.command ?? 'capiro-defense-budget-parser';
    this.workDir = opts.workDir;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

    // Ensure work directory exists
    mkdirSync(this.workDir, { recursive: true });
  }

  /**
   * Execute a parser job by writing it to a file, invoking the Python
   * runtime, and reading the result file.
   */
  async executeJob(opts: ExecuteJobOptions): Promise<ExecuteJobResult> {
    // Validate the job
    const job = parseParserRuntimeJobV1(opts.job);

    // Write job file
    const jobPath = join(this.workDir, 'job.json');
    const resultPath = join(this.workDir, 'result.json');
    writeFileSync(jobPath, JSON.stringify(job, null, 2), 'utf8');

    // Invoke the Python runtime
    const { exitCode, stderr } = await this.invokeRuntime([
      'run',
      '--job', jobPath,
      '--out', resultPath,
    ]);

    // Read and validate the result
    const rawResult = readFileSync(resultPath, 'utf8');
    const result = parseParserRuntimeResultV1(JSON.parse(rawResult));

    return { result, exitCode, stderr };
  }

  /**
   * Validate a job without executing the parser.
   */
  async validateJob(jobPath: string): Promise<{ valid: boolean; exitCode: number; stderr: string }> {
    const { exitCode, stderr } = await this.invokeRuntime([
      'validate-job',
      '--job', jobPath,
    ]);
    return { valid: exitCode === 0, exitCode, stderr };
  }

  /**
   * Run page profiling on a source PDF.
   */
  async profileJob(jobPath: string, resultPath: string): Promise<{ exitCode: number; stderr: string }> {
    const { exitCode, stderr } = await this.invokeRuntime([
      'profile',
      '--job', jobPath,
      '--out', resultPath,
    ]);
    return { exitCode, stderr };
  }

  /**
   * Invoke the Python runtime with the given arguments.
   */
  private invokeRuntime(args: string[]): Promise<{ exitCode: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, args, {
        cwd: this.workDir,
        timeout: this.timeoutMs,
        env: { ...process.env },
      });

      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      proc.on('error', (err) => {
        reject(new Error(`failed to start parser runtime: ${err.message}`));
      });

      proc.on('close', (code) => {
        resolve({ exitCode: code ?? 1, stderr });
      });
    });
  }
}
