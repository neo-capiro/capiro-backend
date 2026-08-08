#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shaIndex = process.argv.indexOf('--sha');
const requestedSha = shaIndex >= 0 ? process.argv[shaIndex + 1] : null;
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
if (!requestedSha || requestedSha !== head) {
  console.error(`--sha must equal exact HEAD (${head})`);
  process.exit(1);
}

function run(label, command, args) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})`);
}

try {
  run('DB-free Phase 1 gate', 'pnpm', ['verify:outreach-v3-phase-1']);
  run('current/future owner fake rehearsal', 'node', ['scripts/run-outreach-v3-p1-owner-rehearsal.mjs']);
  run('authoritative Phase 3 dual-runtime/browser regression', 'pnpm', [
    'verify:engagement-phase-3:local',
    '--',
    '--sha',
    head,
  ]);
  console.log('\nOUTREACH_V3_PHASE1_AUTHORITATIVE_LOCAL_COMPLETE');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
