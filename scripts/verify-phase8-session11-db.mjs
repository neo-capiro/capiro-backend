#!/usr/bin/env node
// Thin wrapper so `pnpm verify:phase8-session11:db` stays the stable entry
// point while the actual disposable-database rehearsal (docker + psql, same
// convention as every prior Phase 8 session) lives in a real bash script.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(scriptDir, 'verify-phase8-session11-db.sh');
const result = spawnSync('bash', [target], { stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(`SESSION11_DB_REHEARSAL_BLOCKED: could not run bash (${result.error.message})`);
  process.exit(2);
}
process.exit(result.status ?? 1);
