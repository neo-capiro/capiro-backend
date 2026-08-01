/**
 * Static lint for PE production scripts (Phase K / closeout Phase 8).
 *
 * Does not require ESLint binary path stability across platforms. Enforces:
 *  - every catalogued PE production script exists
 *  - PE runtime writers contain no `_prisma_migrations` hand-edits / migrate resolve
 *    (gate/verify scripts that *mention* those tokens as assertions are excluded)
 *  - committed exact-SHA dollar loaders still appear in PE_EXACT_SHA_DOLLAR_LOADERS
 *  - no wildcard typecheck expansion tricks in package.json scripts for pe-scripts
 *
 * Exit 0 print PE_LINT_SCRIPTS_OK; else exit 1.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PE_PRODUCTION_SCRIPTS,
  PE_PRODUCTION_SCRIPT_HELPERS,
} from './lib/pe-production-scripts.js';
import { PE_EXACT_SHA_DOLLAR_LOADERS } from './lib/pe-exact-sha-loader-contract.js';
import {
  assertNoMigrationHistoryMutation,
  stripShellComments,
} from './lib/pe-migration-guards.js';

function apiRoot(): string {
  const cwd = process.cwd().replace(/\\/g, '/');
  return cwd.endsWith('/apps/api') ? process.cwd() : resolve(process.cwd(), 'apps/api');
}

function read(rel: string): string {
  return readFileSync(resolve(apiRoot(), rel), 'utf8').replace(/\r\n/g, '\n');
}

/** Gate/verify/docs scripts may mention forbidden tokens when asserting against them. */
const HISTORY_SCAN_EXEMPT = new Set([
  'scripts/verify-pe-phase-a-safety.ts',
  'scripts/verify-pe-phase-e-exact-sha.ts',
  'scripts/verify-pe-phase-k.ts',
  'scripts/verify-pe-phase-9.ts',
  'scripts/verify-pe-phase-10.ts',
  'scripts/lint-pe-scripts.ts',
  'scripts/verify-pe-migration-guards.ts',
  'scripts/measure-accuracy.ts',
  'scripts/diag-program-element-trust-baseline.ts',
]);

function main(): void {
  const root = apiRoot();
  for (const rel of [...PE_PRODUCTION_SCRIPTS, ...PE_PRODUCTION_SCRIPT_HELPERS]) {
    assert.equal(existsSync(resolve(root, rel)), true, `missing ${rel}`);
  }

  // Dollar loaders named in contract must still exist as production scripts
  for (const base of PE_EXACT_SHA_DOLLAR_LOADERS) {
    const rel = `scripts/${base}`;
    assert.equal(
      (PE_PRODUCTION_SCRIPTS as readonly string[]).includes(rel),
      true,
      `exact-SHA loader ${base} missing from PE_PRODUCTION_SCRIPTS`,
    );
  }

  // Runtime writer script bodies: forbid migration history mutation
  const snapshots = PE_PRODUCTION_SCRIPTS.filter((rel) => !HISTORY_SCAN_EXEMPT.has(rel)).map(
    (rel) => ({
      path: rel,
      source: read(rel),
    }),
  );
  const history = assertNoMigrationHistoryMutation(snapshots);
  assert.equal(history.ok, true, history.findings.map((f) => f.message).join('; '));

  // package.json pe gate scripts must name exact tokens (no globs)
  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  for (const key of [
    'typecheck:pe-scripts',
    'lint:pe-scripts',
    'test:pe-trust',
    'verify:pe-phase-k',
  ]) {
    assert.equal(typeof scripts[key], 'string', `package.json missing scripts.${key}`);
    assert.equal(scripts[key]!.includes('*'), false, `${key} must not use shell globs`);
  }

  // Entrypoint suite still forbids history mutation (inherit Phase A)
  const entrypoints = [
    'scripts/entrypoint.sh',
    'scripts/entrypoint-legacy.sh',
    'scripts/entrypoint-dispatcher.inc',
  ].map((p) => ({ path: p, source: stripShellComments(read(p)) }));
  const entryGuard = assertNoMigrationHistoryMutation(entrypoints);
  assert.equal(entryGuard.ok, true, entryGuard.findings.map((f) => f.message).join('; '));

  console.log('PE_LINT_SCRIPTS_OK');
}

main();
