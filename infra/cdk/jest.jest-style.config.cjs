/**
 * jest, restricted to the specs jest can actually run.
 *
 * See scripts/cdk-spec-runners.cjs for the full explanation. Short version:
 * infra/cdk/test mixes jest-style and node:test-style specs, and jest reports
 * "Your test suite must contain at least one test" (exit 1) for every
 * node:test file it collects — a false negative that hid the fact that those
 * files' assertions were never executed by CI at all.
 *
 * This config reuses the base jest.config.cjs verbatim (same rootDir,
 * transform and testMatch) and only adds ignore patterns for the node:test
 * half, which `test:constructs` runs instead. The partition is computed by
 * reading the files, so adding a spec in either style needs no edit here.
 */
const path = require('node:path');
const base = require('./jest.config.cjs');
const { PACKAGE_ROOT, classifySpecs } = require('./scripts/cdk-spec-runners.cjs');

/**
 * jest matches testPathIgnorePatterns as regexes against the resolved test
 * path, which on Windows contains backslashes. Anchor on the basename only,
 * so the pattern is separator-agnostic.
 */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nodeTestIgnorePatterns = classifySpecs().nodeTest.map(
  (file) => `${escapeRegExp(path.basename(file))}$`,
);

module.exports = {
  ...base,
  testPathIgnorePatterns: [...(base.testPathIgnorePatterns ?? ['/node_modules/']), ...nodeTestIgnorePatterns],
  rootDir: base.rootDir ?? PACKAGE_ROOT,
};
