#!/usr/bin/env tsx
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Authoritative DB-free Phase 1 closeout.
 *
 * This script intentionally does not rely on GitHub Actions. It runs from the
 * exact local checkout and fails on the first missing prerequisite, stale
 * manifest, regression, build failure, skipped suite, or web-routing drift.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import * as path from 'node:path';
import { runVerifierProcess } from './lib/engagement-verifier-process';
import { engagementPhase1Scope, engagementPhase1Marker, engagementPhase1QualificationPlan, type EngagementPhase1Scope } from './engagement-phase1-qualification-plan';

const USAGE = 'Usage: tsx scripts/verify-engagement-phase1-runtime.ts (--run [--backend-only | --frontend-only] | --help)';
if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log(USAGE);
  process.exit(0);
}
let SCOPE: EngagementPhase1Scope;
try {
  SCOPE = engagementPhase1Scope(process.argv.slice(2));
} catch {
  console.error(USAGE);
  process.exit(2);
}

const API_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_DIR, '../..');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

const TEST_TARGETS = [
  'scripts/lib/engagement-verifier-process.spec.ts',
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
  'src/engagement/outreach-job.spec.ts',
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

async function run(
  label: string,
  command: string,
  args: string[],
  cwd = REPO_ROOT,
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  console.log(`\n==> ${label}`);
  const resolved =
    command === 'pnpm' || command === 'pnpm.cmd' ? resolvePnpm(args) : { command, args };
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
    const result = await runVerifierProcess(resolved.command, resolved.args, {
      cwd,
      env: { ...process.env, CI: 'true', ...env },
      shell: useShell,
      maxBufferBytes: 64 * 1024 * 1024,
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
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
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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

async function main(): Promise<void> {
  const head = spawnSync(GIT, ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: false,
  });
  if (head.status !== 0 || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) {
    throw new Error('Phase 1 closeout requires an exact Git checkout');
  }
  console.log(`Engagement Phase 1 DB-free closeout: ${head.stdout.trim()}`);

  for (const step of engagementPhase1QualificationPlan(SCOPE, GIT, TEST_TARGETS)) {
    if (step.kind === 'command') {
      await run(step.label, step.command, step.args, REPO_ROOT, step.env ?? {});
    } else if (step.kind === 'required-file') {
      assertFile(step.relativePath);
    } else {
      assertNoWebPreviewRouting();
    }
  }

  // Write COMPLETE unbuffered so redirected nested logs see it before Windows
  // process teardown can hang the parent (stdbuf alone is not enough for Node).
  writeSync(1, `\n${engagementPhase1Marker(SCOPE, 'complete')}\n`);
  // All checks have completed; exit explicitly so nested Windows callers do
  // not remain alive on teardown handles after the completion marker.
  process.exit(0);
}

void main().catch((error) => {
  writeSync(2, `\n${engagementPhase1Marker(SCOPE, 'failed')}\n`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
