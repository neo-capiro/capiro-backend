/** Test-only Phase 9 CLI fixtures. All operator filesystem and process effects are mocked. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import * as catalog from './pe-phase-9-rehearsal-catalog.js';
import * as rehearsal from './pe-phase-9-rehearsal.js';
import * as runner from './pe-phase-9-runner.js';
import * as evidenceModule from './pe-phase-9-evidence.js';

const CLI_SOURCE = readFileSync(resolve(__dirname, '../verify-pe-phase-9.ts'), 'utf8');
export const API_PACKAGE = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
);
export const HEAD_SHA = 'a'.repeat(40);
export const MAIN_SHA = 'b'.repeat(40);
export const BASE_SHA = 'c'.repeat(40);
const EXIT = Symbol('fixture process.exit');

export interface ShellCall {
  command: string;
  cwd: string;
  timeout: number;
  shell: string;
  env: NodeJS.ProcessEnv;
}

export interface CliFixture {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  dockerAvailable?: boolean;
  tipPaths?: string[];
  changedPaths?: string[];
  baseResults?: Record<string, number>;
  packageScripts?: Record<string, string>;
  failure?: (call: ShellCall) => number | undefined;
  output?: string;
}

export interface CliResult {
  commands: ShellCall[];
  spawns: Array<{ command: string; args: string[] }>;
  writes: Map<string, string>;
  logs: string[];
  errors: string[];
  warnings: string[];
  exitCode?: number;
  error?: unknown;
}

function fixtureGit(args: string[], fixture: CliFixture): string {
  if (args[0] === 'ls-tree')
    return (fixture.tipPaths ?? ['apps/api/src/program-element/example.ts']).join('\n');
  if (args[0] === 'diff') return (fixture.changedPaths ?? []).join('\n');
  if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? HEAD_SHA : MAIN_SHA;
  if (args[0] === 'merge-base') return BASE_SHA;
  throw new Error(`Unexpected fixture git arguments: ${args.join(' ')}`);
}

function fixtureFs(result: CliResult, fixture: CliFixture) {
  return {
    existsSync: (path: string) =>
      path === '/fixture/pnpm-workspace.yaml' || path === '/fixture/base-results.json',
    mkdirSync: () => undefined,
    writeFileSync: (path: string, value: string) => result.writes.set(path, value),
    readFileSync: (path: string) => {
      if (path === '/fixture/base-results.json') return JSON.stringify(fixture.baseResults ?? {});
      if (path === '/fixture/apps/api/package.json')
        return JSON.stringify({ scripts: fixture.packageScripts ?? API_PACKAGE.scripts });
      throw new Error(`Unexpected fixture file read: ${path}`);
    },
    readdirSync: () => {
      throw new Error('Unexpected fallback filesystem walk');
    },
    statSync: () => {
      throw new Error('Unexpected fallback filesystem stat');
    },
  };
}

function fixtureProcesses(result: CliResult, fixture: CliFixture) {
  return {
    spawnSync: (command: string, args: string[]) => {
      result.spawns.push({ command, args });
      if (command === 'git')
        return { status: 0, stdout: `${fixtureGit(args, fixture)}\n`, stderr: '' };
      if (command === 'docker' && args.join(' ') === 'info')
        return { status: fixture.dockerAvailable === false ? 1 : 0, stdout: '', stderr: '' };
      throw new Error(`Unexpected fixture process: ${command}`);
    },
    execSync: (command: string, options: Omit<ShellCall, 'command'>) => {
      const call = { command, ...options };
      result.commands.push(call);
      const status = fixture.failure?.(call);
      if (status !== undefined)
        throw { status, stdout: 'fixture stdout', stderr: 'fixture stderr' };
      return fixture.output ?? 'fixture shell passed\n';
    },
  };
}

/** Execute the actual operator, with an allowlist that refuses every other import. */
export function exerciseCli(
  argv: string[],
  fixture: CliFixture = {},
  source = CLI_SOURCE,
): CliResult {
  const result: CliResult = {
    commands: [],
    spawns: [],
    writes: new Map(),
    logs: [],
    errors: [],
    warnings: [],
  };
  const imports: Record<string, unknown> = {
    'node:assert': require('node:assert'),
    'node:path': require('node:path'),
    'node:fs': fixtureFs(result, fixture),
    'node:child_process': fixtureProcesses(result, fixture),
    './lib/pe-phase-9-rehearsal-catalog.js': catalog,
    './lib/pe-phase-9-rehearsal.js': rehearsal,
    './lib/pe-phase-9-runner.js': runner,
    './lib/pe-phase-9-evidence.js': evidenceModule,
  };
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  try {
    runInNewContext(
      output,
      {
        exports: {},
        require: (name: string) => {
          if (!Object.hasOwn(imports, name)) throw new Error(`Disallowed operator import: ${name}`);
          return imports[name];
        },
        process: {
          argv: ['node', 'verify-pe-phase-9.ts', ...argv],
          env: { ...fixture.env },
          platform: fixture.platform ?? 'linux',
          cwd: () => fixture.cwd ?? '/fixture',
          exit: (code: number) => {
            result.exitCode = code;
            throw EXIT;
          },
        },
        console: {
          log: (...args: unknown[]) => result.logs.push(args.join(' ')),
          error: (...args: unknown[]) => result.errors.push(args.join(' ')),
          warn: (...args: unknown[]) => result.warnings.push(args.join(' ')),
        },
      },
      { timeout: 5_000 },
    );
  } catch (error) {
    if (error !== EXIT) result.error = error;
  }
  return result;
}

export function evidence(result: CliResult, scope: 'full' | 'backend' = 'full') {
  const suffix = scope === 'backend' ? 'phase-9-backend' : 'phase-9';
  const json = result.writes.get(
    `/fixture/docs/verification/program-elements-trust/${suffix}/phase-9-rehearsal-summary.json`,
  );
  expect(json).toBeDefined();
  return JSON.parse(json!);
}

export function expectSuccess(result: CliResult, marker: string): void {
  expect(result.error).toBeUndefined();
  expect(result.exitCode).toBeUndefined();
  expect(result.errors).toEqual([]);
  expect(result.logs).toContain(marker);
}
