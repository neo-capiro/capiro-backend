/**
 * Which runner owns which spec in infra/cdk/test.
 *
 * WHY THIS EXISTS (Meri/Hermes Phase 1, required fix 6b)
 * -----------------------------------------------------
 * infra/cdk/test contains specs written in TWO mutually incompatible styles:
 *
 *   * jest style   — `describe()` / `test()` from jest's injected globals.
 *   * node:test    — `import test from 'node:test'` + `node:assert/strict`.
 *
 * `infra/cdk/package.json`'s "test" script was `jest`, and jest's
 * `testMatch` collected BOTH. A node:test spec registers its cases with
 * Node's own test runner, so jest sees a file that declared nothing and
 * reports:
 *
 *     Your test suite must contain at least one test.
 *
 * ...and exits 1. Measured on this branch before the fix:
 * `npx jest` in infra/cdk => 15 failed suites, 6 passed, 29 tests, exit 1.
 * Every one of the 15 "failures" is a false negative: the assertions inside
 * those files were never executed at all. That included
 * `test/meri-hermes-worker-fleet.spec.ts`, so the Meri/Hermes worker-fleet
 * construct had ZERO executing coverage in CI even though its 9 assertions
 * pass when run by the right runner.
 *
 * Rather than hard-code two file lists that drift the moment somebody adds a
 * spec, this module PARTITIONS the directory by reading each file and looking
 * for a `node:test` import. The partition is total and disjoint: every
 * `test/**\/*.spec.ts` lands in exactly one runner, so a newly added spec can
 * never be silently collected by neither.
 *
 * Consumed by:
 *   * scripts/run-construct-tests.cjs   (runs the node:test half)
 *   * jest.jest-style.config.cjs        (ignores the node:test half)
 */
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(PACKAGE_ROOT, 'test');

/**
 * Matches `from 'node:test'` / `from "node:test"` and
 * `require('node:test')`, in either quote style, tolerating extra spaces.
 * Deliberately NOT a bare substring search for "node:test": this file and
 * the workflow comments mention that string in prose, and a spec that only
 * discusses node:test in a comment should not be routed away from jest.
 */
const NODE_TEST_IMPORT = /(?:from\s*|require\s*\(\s*)['"]node:test['"]/;

function listSpecFiles() {
  if (!fs.existsSync(TEST_DIR)) return [];
  return fs
    .readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => path.join(TEST_DIR, entry.name))
    .sort();
}

/**
 * @returns {{ nodeTest: string[], jest: string[] }} absolute paths, sorted.
 */
function classifySpecs() {
  const nodeTest = [];
  const jest = [];
  for (const file of listSpecFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    (NODE_TEST_IMPORT.test(source) ? nodeTest : jest).push(file);
  }
  return { nodeTest, jest };
}

module.exports = { PACKAGE_ROOT, TEST_DIR, classifySpecs, listSpecFiles };
