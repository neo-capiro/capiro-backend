#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { requirePhase8DbRun } from './lib/phase8-db-wrapper-cli.mjs';

requirePhase8DbRun('verify-phase8-session7-db.mjs', process.argv.slice(2));

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(scriptDir, 'verify-phase8-session7-db.sh');
const result = spawnSync('bash', [target], { stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(`SESSION7_DB_REHEARSAL_BLOCKED: could not run bash (${result.error.message})`);
  process.exit(2);
}
process.exit(result.status ?? 1);
