#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const shaIndex = args.indexOf('--sha');
const expectedSha = shaIndex >= 0 ? args[shaIndex + 1] : null;

function output(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `${command} failed\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function run(label, command, commandArgs, env = {}) {
  process.stdout.write(`\n== ${label} ==\n${[command, ...commandArgs].join(' ')}\n`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status ?? 1}`);
}

const head = output('git', ['rev-parse', 'HEAD']);
if (!expectedSha || expectedSha !== head) {
  process.stderr.write(`OUTREACH_V3_PHASE5_LOCAL_FAILED: expected exact --sha ${head}\n`);
  process.exit(2);
}
if (output('git', ['status', '--short'])) {
  process.stderr.write('OUTREACH_V3_PHASE5_LOCAL_FAILED: working tree must be clean\n');
  process.exit(3);
}

const evidenceDir = resolve(root, `.artifacts/outreach-v3-phase5-${head}`);
rmSync(evidenceDir, { recursive: true, force: true });
mkdirSync(evidenceDir, { recursive: true });

const summary = {
  schemaVersion: 1,
  sha: head,
  dbFree: false,
  phase2DbRegression: false,
  phase3ReasoningRegression: false,
  phase3CurrentUiRegression: false,
  noGenerationOrSend: true,
  noFinalUiImplementation: true,
  note: 'This harness is intentionally scaffolded for the owner-directed combined Phase 4-6 verification pass.',
};

try {
  run('Phase 5 DB-free closeout', 'node', ['scripts/verify-outreach-v3-phase5-code.mjs']);
  summary.dbFree = true;

  run('Phase 2 state/database regression', 'node', ['scripts/verify-outreach-v3-phase2-db.mjs']);
  summary.phase2DbRegression = true;

  run('Phase 3 reasoning local regression', 'node', [
    'scripts/run-outreach-v3-phase3-local.mjs',
    '--sha',
    head,
  ]);
  summary.phase3ReasoningRegression = true;

  run('Current Engagement UI local regression', 'node', [
    'scripts/run-engagement-phase3-local.mjs',
    '--sha',
    head,
  ]);
  summary.phase3CurrentUiRegression = true;

  writeFileSync(resolve(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write('\nOUTREACH_V3_PHASE5_AUTHORITATIVE_LOCAL_COMPLETE\n');
} catch (error) {
  writeFileSync(
    resolve(evidenceDir, 'failure.json'),
    `${JSON.stringify({ ...summary, error: error instanceof Error ? error.message : 'unknown' }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stderr.write(
    `\nOUTREACH_V3_PHASE5_LOCAL_FAILED:${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exit(1);
}
