#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 helpExit=0 */
/**
 * Compatibility entrypoint for the former whole-code mirror parity check.
 * Verify canonical runtime ownership, immutable retirement/test provenance and
 * the unchanged retained fixture/data bytes. No second implementation executes.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { inspectDefenseRuntimeSourceOwnership } from './lib/defense-runtime-source-ownership.mjs';

const usage = 'Usage: node scripts/verify-defense-budget-mirror-parity.mjs (no arguments verifies canonical source ownership and retained fixture parity)';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
if (args.length !== 0) {
  console.error(usage);
  process.exit(2);
}

function resolveRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) && fs.existsSync(path.join(dir, 'apps/defense-api'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

console.error(usage);
const result = inspectDefenseRuntimeSourceOwnership(resolveRepoRoot());
if (result.errors.length) {
  for (const error of result.errors) console.error(`- ${error}`);
  console.error('FAILURE: canonical Defense source ownership or retained data parity failed.');
  process.exit(1);
}
console.log(
  `CANONICAL_DEFENSE_SOURCE_PASS: ${result.counts.retiredCodeFiles} removed code twins, ` +
  `${result.counts.retainedCanonicalTests} retained canonical specs, ${result.counts.retainedDataFiles} unchanged data files, ` +
  `${result.counts.replayFixtures} replay fixtures; baseline ${result.baseline}`,
);
