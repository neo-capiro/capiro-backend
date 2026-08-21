#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(scriptDir, 'verify-phase8-session9-db.sh');
const result = spawnSync('bash', [target], { stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(`SESSION9_DB_REHEARSAL_BLOCKED: could not run bash (${result.error.message})`);
  process.exit(2);
}
process.exit(result.status ?? 1);
