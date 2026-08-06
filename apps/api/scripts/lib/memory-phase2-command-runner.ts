import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const MEMORY_PHASE2_COMMAND_MAX_BUFFER = 64 * 1024 * 1024;

export interface MemoryPhase2PnpmInvocation {
  command: string;
  prefixArgs: string[];
  shell: boolean;
  source: 'explicit-corepack-js' | 'bundled-corepack-js' | 'pnpm-path' | 'windows-shell';
}

export interface ResolveMemoryPhase2PnpmOptions {
  platform?: NodeJS.Platform;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

export interface MemoryPhase2CommandInput {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  shell?: boolean;
  maxBuffer?: number;
  spawn?: typeof spawnSync;
}

export interface MemoryPhase2CommandOutput {
  stdout: string;
  stderr: string;
}

export function resolveMemoryPhase2Pnpm(
  options: ResolveMemoryPhase2PnpmOptions = {},
): MemoryPhase2PnpmInvocation {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  const explicit = env.CAPIRO_COREPACK_PNPM_JS?.trim();
  if (explicit) {
    const candidate = isAbsolute(explicit) ? explicit : resolve(explicit);
    if (!exists(candidate)) {
      throw new Error(`CAPIRO_COREPACK_PNPM_JS does not exist: ${candidate}`);
    }
    return {
      command: execPath,
      prefixArgs: [candidate],
      shell: false,
      source: 'explicit-corepack-js',
    };
  }

  const executableDirectory = dirname(execPath);
  const nodeHome = dirname(executableDirectory);
  const candidates = [
    join(executableDirectory, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
    join(nodeHome, 'lib', 'node_modules', 'corepack', 'dist', 'pnpm.js'),
    join(nodeHome, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
  ];
  const bundled = candidates.find((candidate) => exists(candidate));
  if (bundled) {
    return {
      command: execPath,
      prefixArgs: [bundled],
      shell: false,
      source: 'bundled-corepack-js',
    };
  }

  return platform === 'win32'
    ? { command: 'pnpm', prefixArgs: [], shell: true, source: 'windows-shell' }
    : { command: 'pnpm', prefixArgs: [], shell: false, source: 'pnpm-path' };
}

export function runMemoryPhase2Command(
  input: MemoryPhase2CommandInput,
): MemoryPhase2CommandOutput {
  const spawn = input.spawn ?? spawnSync;
  const env = { ...process.env, ...input.env };
  const result = spawn(input.command, input.args, {
    cwd: input.cwd,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: input.shell === true,
    windowsHide: true,
    maxBuffer: input.maxBuffer ?? MEMORY_PHASE2_COMMAND_MAX_BUFFER,
  });
  const stdout = asText(result.stdout);
  const stderr = asText(result.stderr);
  const redactions = sensitiveValues(env);

  if (result.error) {
    const code =
      'code' in result.error && result.error.code ? ` [${String(result.error.code)}]` : '';
    throw new Error(
      `${input.command} could not start${code}: ${redact(result.error.message, redactions)}`,
    );
  }
  if (result.status !== 0) {
    const termination = result.signal
      ? `signal ${result.signal}`
      : `exit ${String(result.status)}`;
    throw new Error(
      [
        `${input.command} ${redact(input.args.join(' '), redactions)} failed with ${termination}.`,
        stdout ? `stdout:\n${redact(stdout, redactions)}` : '',
        stderr ? `stderr:\n${redact(stderr, redactions)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return {
    stdout: redact(stdout, redactions),
    stderr: redact(stderr, redactions),
  };
}

function asText(value: string | Buffer | null | undefined): string {
  if (typeof value === 'string') return value;
  return value ? value.toString('utf8') : '';
}

function sensitiveValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        typeof value === 'string' &&
        value.length >= 8 &&
        /(?:DATABASE_URL|PASSWORD|TOKEN|SECRET|PRIVATE_KEY|API_KEY)$/i.test(name),
    )
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

function redact(value: string, redactions: string[]): string {
  let result = value;
  for (const secret of redactions) result = result.split(secret).join('[REDACTED]');
  return result;
}
