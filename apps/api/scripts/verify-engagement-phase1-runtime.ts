#!/usr/bin/env tsx
/**
 * Authoritative DB-free Phase 1 closeout.
 *
 * This script intentionally does not rely on GitHub Actions. It runs from the
 * exact local checkout and fails on the first missing prerequisite, regression,
 * stale manifest, build failure, or web-routing drift.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

const API_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_DIR, '../..');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

const TEST_TARGETS = [
  'src/bootstrap/configure-api-http-app.spec.ts',
  'src/engagement-api.app.module.spec.ts',
  'src/engagement-api/engagement-api-health.controller.spec.ts',
  'src/engagement/runtime',
  'src/engagement/engagement-sync-scheduler.service.spec.ts',
  'src/engagement/outreach-job.service.spec.ts',
  'src/engagement/outreach-send-intent.service.spec.ts',
  'src/engagement/notetaker/notetaker.service.spec.ts',
  'src/engagement/mail-sender.service.spec.ts',
  'src/engagement/llm-completion.service.spec.ts',
];

function run(label: string, command: string, args: string[], cwd = REPO_ROOT): void {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, CI: 'true' },
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${String(result.status)}`);
  }
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
  const forbidden = [
    'VITE_ENGAGEMENT_API_URL',
    'X-Capiro-Engagement-Preview',
    'http://127.0.0.1:4500',
    'http://localhost:4500',
  ];
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

  run('Locked dependency install', PNPM, ['install', '--frozen-lockfile']);
  for (const pkg of [
    '@capiro/api',
    '@capiro/intel-api',
    '@capiro/workspace',
    '@capiro/onboard-api',
    '@capiro/api-strategy',
  ]) {
    run(`Generate Prisma client: ${pkg}`, PNPM, ['--filter', pkg, 'exec', 'prisma', 'generate']);
  }

  run('Phase 0 contract prerequisite', PNPM, [
    '--filter',
    '@capiro/api',
    'run',
    'verify:engagement-phase-0',
  ]);
  run(
    'Phase 1 runtime, route, timer, provider, bootstrap, health, and image-entrypoint tests',
    PNPM,
    [
      '--filter',
      '@capiro/api',
      'exec',
      'jest',
      '--runInBand',
      '--forceExit',
      ...TEST_TARGETS,
    ],
  );
  run('Build API entrypoints', PNPM, ['--filter', '@capiro/api', 'run', 'build']);

  assertFile('apps/api/dist/main.js');
  assertFile('apps/api/dist/engagement-main.js');
  assertFile('apps/engagement-api/Dockerfile');
  assertFile('apps/engagement-api/scripts/entrypoint.sh');

  run('Repository typecheck', PNPM, ['turbo', 'run', 'typecheck']);
  run('Web regression suite', PNPM, ['--filter', '@capiro/web', 'test']);
  assertNoWebPreviewRouting();
  run('Whitespace validation', GIT, ['diff', '--check']);

  console.log('\nENGAGEMENT_PHASE1_DB_FREE_COMPLETE');
}

try {
  main();
} catch (error) {
  console.error('\nENGAGEMENT_PHASE1_DB_FREE_FAILED');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
