#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  'pnpm',
  [
    '-C',
    'apps/api',
    'exec',
    'jest',
    '--runInBand',
    '--forceExit',
    'src/outreach-v3/reasoning/outreach-reasoning-encrypted-content.spec.ts',
    'src/outreach-v3/reasoning/openai-outreach-reasoning.provider.spec.ts',
  ],
  {
    cwd: ROOT,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  console.error('OUTREACH_V3_PHASE3_PROVIDER_CONTRACT_REJECTED');
  process.exit(result.status ?? 1);
}
console.log('OUTREACH_V3_PHASE3_PROVIDER_CONTRACT_COMPLETE');
