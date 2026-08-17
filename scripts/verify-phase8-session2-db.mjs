#!/usr/bin/env node
// Thin wrapper so `pnpm verify:phase8-session2:db` stays the stable entry
// point while the actual disposable-database rehearsal (docker + psql, same
// convention as apps/api/scripts/pe-budget-phase7-migration-rehearsal.sh)
// lives in a real bash script rather than being reimplemented in JS.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(scriptDir, 'verify-phase8-session2-db.sh');

const result = spawnSync('bash', [target], { stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(`SESSION2_DB_REHEARSAL_BLOCKED: could not run bash (${result.error.message})`);
  process.exit(2);
}
process.exit(result.status ?? 1);
