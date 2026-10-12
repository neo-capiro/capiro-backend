#!/usr/bin/env node
/**
 * Run the test-proof fixture tests with a single dependency-free command.
 *
 *   node scripts/test-proof/run-fixtures.mjs
 *
 * Discovers every `*.test.mjs` under scripts/test-proof/ and hands the explicit
 * file list to Node's test runner. Exits with the runner's exit code so a red
 * fixture fails the caller. No workspace dependencies, no credentials.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(HERE, f));

if (files.length === 0) {
  process.stderr.write('run-fixtures: no *.test.mjs files found\n');
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
