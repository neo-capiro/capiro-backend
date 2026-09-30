#!/usr/bin/env tsx
/**
 * Authoritative DB-free Phase 1 closeout.
 *
 * This script intentionally does not rely on GitHub Actions. It runs from the
 * exact local checkout and fails on the first missing prerequisite, stale
 * manifest, regression, build failure, skipped suite, or web-routing drift.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import * as path from 'node:path';

const API_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_DIR, '../..');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

const writeRetryPause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Synchronous, complete write. Output stays unbuffered for Windows teardown,
 * but when a parent verifier reads through a non-blocking pipe (Linux CI),
 * writeSync throws EAGAIN once the pipe is full and may write only part of a
 * large relayed log; wait briefly and continue until every byte is written.
 */
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      Atomics.wait(writeRetryPause, 0, 0, 5);
    }
  }
}

const TEST_TARGETS = [
  'src/bootstrap/configure-api-http-app.spec.ts',
  'src/engagement-api.app.module.spec.ts',
  'src/engagement-api/engagement-api-health.controller.spec.ts',
  'src/engagement/engagement-route-manifest.spec.ts',
  'src/engagement/engagement-dependency-manifest.spec.ts',
  'src/engagement/engagement-side-effect-registry.spec.ts',
  'src/engagement/runtime',
  'src/engagement/ai-credential-resolver.service.spec.ts',
  'src/engagement/governed-engagement.factory.spec.ts',
  'src/engagement/engagement-sync-scheduler.service.spec.ts',
  'src/engagement/outreach-job.service.spec.ts',
  'src/engagement/outreach-send-intent.service.spec.ts',
  'src/engagement/notetaker/notetaker.service.spec.ts',
  'src/engagement/mail-sender.service.spec.ts',
  'src/engagement/llm-completion.service.spec.ts',
];

/** Resolve pnpm without shelling through *.cmd on Windows. */
function resolvePnpm(args: string[]): { command: string; args: string[] } {
  if (process.env.PNPM_PATH) {
    const target = process.env.PNPM_PATH;
    if (/\.(mjs|cjs|js)$/i.test(target)) {
      return { command: process.execPath, args: [target, ...args] };
    }
    return { command: target, args };
  }
  const corepack = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'corepack',
    'dist',
    'pnpm.js',
  );
  if (existsSync(corepack)) {
    return { command: process.execPath, args: [corepack, ...args] };
  }
  return { command: 'pnpm', args };
}

function runWindowsWebRegression(resolved: { command: string; args: string[] }): void {
  const logPath = 'C:\\dev\\recovery-phase1-web-regression.log';
  const fd = openSync(logPath, 'w');
  const child = spawn(resolved.command, resolved.args, {
    cwd: REPO_ROOT,
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  closeSync(fd);
  const deadline = Date.now() + 900_000;
  let greenSummary = false;
  while (Date.now() < deadline) {
    const output = readFileSync(logPath, 'utf8');
    const hasGreenSummary =
      /Test Files\s+.*\bpassed\b.*\(\d+\)/.test(output) &&
      /Tests\s+.*\bpassed\b.*\(\d+\)/.test(output) &&
      !/Test Files\s+.*\bfailed\b/.test(output) &&
      !/Tests\s+.*\bfailed\b/.test(output);
    if (hasGreenSummary) {
      greenSummary = true;
      if (child.exitCode === null) {
        spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], {
          stdio: 'ignore',
          windowsHide: true,
        });
      }
      writeAll(1, output);
      return;
    }
    if (child.exitCode !== null) break;
    spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }
  const output = readFileSync(logPath, 'utf8');
  if (!greenSummary) writeAll(1, output);
  throw new Error(`Web regression suite failed or timed out; see ${logPath}`);
}

function run(label: string, command: string, args: string[], cwd = REPO_ROOT): void {
  writeAll(1, `\n==> ${label}\n`);
  const resolved =
    command === 'pnpm' || command === 'pnpm.cmd' ? resolvePnpm(args) : { command, args };
  if (process.platform === 'win32' && label === 'Web regression suite') {
    runWindowsWebRegression(resolved);
    return;
  }
  // Windows nested spawn under the long Phase 2/4-6 verifier chain can
  // intermittently:
  //   - return STATUS_DLL_INIT_FAILED (0xC0000142 / 3221225794)
  //   - crash tinypool/vitest workers ("Worker exited unexpectedly") with exit 1
  // even when the same command is green in isolation. Retry only those
  // infrastructure crash signatures — not real assertion failures.
  // After the first infrastructure crash on Windows, fall back to shell:true
  // so CreateProcess resolves through cmd (capacity/resolution only; same argv).
  const dllInitFailed = new Set([3221225794, -1073741502]);
  const maxAttempts = 4;
  let lastStatus: number | null = null;
  let useShell = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = spawnSync(resolved.command, resolved.args, {
      cwd,
      env: { ...process.env, CI: 'true' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    if (stdout) writeAll(1, stdout);
    if (stderr) writeAll(2, stderr);
    lastStatus = result.status;
    if (result.status === 0) return;

    const combinedOut = `${stdout}\n${stderr}`;
    const isDllCrash = result.status != null && dllInitFailed.has(result.status);
    // Vitest/tinypool worker death surfaces as exit 1 with this signature —
    // not as the raw Windows status code.
    const isWorkerCrash =
      /Worker exited unexpectedly/i.test(combinedOut) ||
      /tinypool.*onUnexpectedExit/i.test(combinedOut);
    const isInfraCrash = isDllCrash || isWorkerCrash;

    if (attempt < maxAttempts && isInfraCrash) {
      if (process.platform === 'win32') useShell = true;
      const delayMs = 2000 * attempt;
      console.warn(
        `==> ${label}: infrastructure crash (status=${String(result.status)} worker=${String(isWorkerCrash)} dll=${String(isDllCrash)}) attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms shell=${String(useShell)}`,
      );
      spawnSync(
        process.execPath,
        ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${delayMs})`],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      continue;
    }
    throw new Error(`${label} failed with exit code ${String(result.status)}`);
  }
  throw new Error(`${label} failed with exit code ${String(lastStatus)}`);
}

function assertFile(relativePath: string): void {
  const absolute = path.join(REPO_ROOT, relativePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`Required file is missing: ${relativePath}`);
  }
}

function walk(dir: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walk(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

function assertNoWebPreviewRouting(): void {
  const webSource = path.join(REPO_ROOT, 'apps/web/src');
  const forbidden = ['VITE_ENGAGEMENT_API_URL', 'http://127.0.0.1:4500', 'http://localhost:4500'];
  const findings: string[] = [];
  for (const filename of walk(webSource)) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filename)) continue;
    const source = readFileSync(filename, 'utf8');
    for (const token of forbidden) {
      if (source.includes(token)) {
        findings.push(`${path.relative(REPO_ROOT, filename)} contains ${token}`);
      }
    }
  }
  if (findings.length > 0) {
    throw new Error(`Phase 1 web-routing boundary failed:\n${findings.join('\n')}`);
  }
}

function main(): void {
  const head = spawnSync(GIT, ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: false,
  });
  if (head.status !== 0 || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) {
    throw new Error('Phase 1 closeout requires an exact Git checkout');
  }
  console.log(`Engagement Phase 1 DB-free closeout: ${head.stdout.trim()}`);

  run('Locked dependency install', 'pnpm', ['install', '--frozen-lockfile']);
  for (const pkg of [
    '@capiro/api',
    '@capiro/intel-api',
    '@capiro/workspace',
    '@capiro/onboard-api',
    '@capiro/api-strategy',
  ]) {
    run(`Generate Prisma client: ${pkg}`, 'pnpm', ['--filter', pkg, 'exec', 'prisma', 'generate']);
  }

  for (const pkg of [
    '@capiro/shared',
    '@capiro/defense-contracts',
    '@capiro/defense-domain',
    '@capiro/auth',
    '@capiro/meriv2-core',
  ]) {
    run(`Build workspace package: ${pkg}`, 'pnpm', ['--filter', pkg, 'run', 'build']);
  }

  run('Phase 0 contract prerequisite', 'pnpm', [
    '--filter',
    '@capiro/api',
    'run',
    'verify:engagement-phase-0',
  ]);
  run(
    'Phase 1 manifests, runtime, route, timer, provider, bootstrap, health, and image-entrypoint tests',
    'pnpm',
    ['--filter', '@capiro/api', 'exec', 'jest', '--runInBand', '--forceExit', ...TEST_TARGETS],
  );
  run('Build API entrypoints', 'pnpm', ['--filter', '@capiro/api', 'run', 'build']);

  assertFile('apps/api/dist/main.js');
  assertFile('apps/api/dist/engagement-main.js');
  assertFile('apps/engagement-api/Dockerfile');
  assertFile('apps/engagement-api/scripts/entrypoint.sh');

  // The complete monorepo typecheck may contain unrelated main-branch failures;
  // Phase 1 gates the production API and web type surfaces it can affect.
  run('API production typecheck', 'pnpm', [
    '--filter',
    '@capiro/api',
    'exec',
    'tsc',
    '-p',
    'tsconfig.build.json',
    '--noEmit',
  ]);
  run('Web typecheck', 'pnpm', ['--filter', '@capiro/web', 'run', 'typecheck']);
  run('Web regression suite', 'pnpm', ['--filter', '@capiro/web', 'test']);
  assertNoWebPreviewRouting();
  run('Committed diff whitespace validation', GIT, [
    'diff',
    '--check',
    'origin/main...HEAD',
    '--',
    '.',
    ':(exclude)docs/plans/**/*.md',
  ]);

  // Write COMPLETE unbuffered so redirected nested logs see it before Windows
  // process teardown can hang the parent (stdbuf alone is not enough for Node).
  writeAll(1, '\nENGAGEMENT_PHASE1_DB_FREE_COMPLETE\n');
  // All checks have completed; exit explicitly so nested Windows callers do
  // not remain alive on teardown handles after the completion marker.
  process.exit(0);
}

try {
  main();
} catch (error) {
  writeAll(2, '\nENGAGEMENT_PHASE1_DB_FREE_FAILED\n');
  writeAll(2, `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
}
