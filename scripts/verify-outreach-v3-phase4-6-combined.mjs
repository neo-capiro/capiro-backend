#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHASE3_BASE = 'b043a995928314f7085b7f9df94bdba02cee9640';
const PHASE4_HEAD = '208dae611d9f5636f3b7507f8782ff7cc864c4ed';
const PHASE5_HEAD = '835cdef35cd8ecb23faf1b100ecfc743bcd31128';

function fail(message) {
  console.error(`OUTREACH_V3_PHASE4_6_COMBINED_FAILED:${message}`);
  process.exit(1);
}

function run(label, command, args, options = {}) {
  console.log(`\n== ${label} ==\n${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) fail(label);
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) fail(`${command}:${args.join(' ')}`);
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const exactHead = output('git', ['rev-parse', 'HEAD']);
const requestedHead = process.argv.includes('--sha')
  ? process.argv[process.argv.indexOf('--sha') + 1]
  : null;
if (requestedHead) assert(exactHead === requestedHead, `HEAD_MISMATCH:${exactHead}:${requestedHead}`);

for (const sha of [PHASE3_BASE, PHASE4_HEAD, PHASE5_HEAD]) {
  run(`Ancestor ${sha.slice(0, 12)}`, 'git', ['merge-base', '--is-ancestor', sha, exactHead]);
}

const required = [
  'docs/plans/outreach-v3/revised-phase-4-final-handoff.md',
  'docs/plans/outreach-v3/revised-phase-5-final-handoff.md',
  'docs/plans/outreach-v3/revised-phase-6-design-to-state-manifest.md',
  'scripts/verify-outreach-v3-phase4-code.mjs',
  'scripts/verify-outreach-v3-phase5-code.mjs',
  'scripts/verify-outreach-v3-phase6-code.mjs',
];
for (const relative of required) {
  assert(existsSync(path.join(ROOT, relative)), `MISSING:${relative}`);
}

const apiClient = readFileSync(
  path.join(ROOT, 'apps/web/src/pages/engagement/outreach/v3/outreach-v3-api.ts'),
  'utf8',
);
for (const forbidden of [
  'send-intents',
  'send-test',
  'draft-artifacts',
  'REQUEST_SAMPLE_GENERATION',
  'REQUEST_FULL_GENERATION',
  'REQUEST_SEND_REVIEW',
]) {
  assert(!apiClient.includes(forbidden), `PHASE6_AUTHORITY_LEAK:${forbidden}`);
}

run('Phase 4 code verifier', 'pnpm', ['verify:outreach-v3-phase-4']);
run('Phase 5 code verifier', 'pnpm', ['verify:outreach-v3-phase-5']);
run('Phase 6 code verifier', 'node', ['scripts/verify-outreach-v3-phase6-code.mjs']);
run('API build', 'pnpm', ['--filter', '@capiro/api', 'build']);
run('Web full test suite', 'pnpm', ['--filter', '@capiro/web', 'test']);
run('Web production build', 'pnpm', ['--filter', '@capiro/web', 'build']);
run('Repository whitespace', 'git', ['diff', '--check', `${PHASE3_BASE}...${exactHead}`]);

console.log(`\nOUTREACH_V3_PHASE4_6_COMBINED_CODE_COMPLETE:${exactHead}`);
console.log('NOTE: deployed authenticated browser acceptance and independent review remain separate gates.');
