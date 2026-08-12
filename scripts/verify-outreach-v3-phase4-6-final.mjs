#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHASE3_HEAD = 'b043a995928314f7085b7f9df94bdba02cee9640';
const PHASE4_HEAD = '208dae611d9f5636f3b7507f8782ff7cc864c4ed';
const PHASE5_HEAD = '835cdef35cd8ecb23faf1b100ecfc743bcd31128';

function run(label, command, args, options = {}) {
  console.log(`\n== ${label} ==\n${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    console.error(`OUTREACH_V3_PHASE4_6_FINAL_FAILED:${label}`);
    process.exit(result.status ?? 1);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
}

const head = output('git', ['rev-parse', 'HEAD']);
const shaIndex = process.argv.indexOf('--sha');
if (shaIndex !== -1 && process.argv[shaIndex + 1] !== head) {
  console.error(`OUTREACH_V3_PHASE4_6_FINAL_FAILED:HEAD_MISMATCH:${process.argv[shaIndex + 1]}:${head}`);
  process.exit(1);
}

for (const sha of [PHASE3_HEAD, PHASE4_HEAD, PHASE5_HEAD]) {
  run(`Ancestor ${sha.slice(0, 12)}`, 'git', ['merge-base', '--is-ancestor', sha, head]);
}

run('Phase 4 target intelligence', 'pnpm', ['verify:outreach-v3-phase-4'], {
  env: { OUTREACH_V3_PHASE4_SCOPE_END: PHASE4_HEAD },
});
run('Phase 5 context and strategy', 'pnpm', ['verify:outreach-v3-phase-5'], {
  env: { OUTREACH_V3_PHASE5_SCOPE_END: PHASE5_HEAD },
});
run('Phase 6 conversational UI', 'node', [
  'scripts/verify-outreach-v3-phase6-final.mjs',
  '--sha',
  head,
]);
run('API build', 'pnpm', ['--filter', '@capiro/api', 'build']);
run('Web full tests', 'pnpm', ['--filter', '@capiro/web', 'test']);
run('Web build', 'pnpm', ['--filter', '@capiro/web', 'build']);
run('Combined diff whitespace', 'git', ['diff', '--check', `${PHASE3_HEAD}...${head}`]);

console.log(`\nOUTREACH_V3_PHASE4_6_FINAL_CODE_COMPLETE:${head}`);
console.log('DEPLOYED_BROWSER_ACCEPTANCE:PENDING');
console.log('INDEPENDENT_VALIDATION:PENDING');
