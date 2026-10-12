/**
 * Fixture tests for the five runner adapters.
 *
 * These prove ACCEPTANCE behaviour (nested names, duplicate multiplicity,
 * cross-worktree path normalisation, status mapping, collected-not-passed for
 * Python) against checked-in runner reports — they never execute a workspace
 * suite, so they are safe to run without node_modules or credentials.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRun, parseReport, parsePytestCollect, extractNodeTestGlob } from './lib/adapters.mjs';
import { discoverTargets } from './lib/discovery.mjs';
import { eventsToTests } from './node-test-reporter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const ROOT = 'C:/dev/main/cleanup-test-proof-20261007';
// The REAL workspace root (this file lives at scripts/test-proof/), so the
// discovered @capiro/e2e target is the ACTUAL source-bound one.
const REPO_ROOT = path.resolve(HERE, '..', '..');
const jestCtx = { packageDirAbs: `${ROOT}/apps/api`, packageDirRel: 'apps/api', reportPath: null };
const webCtx = { packageDirAbs: `${ROOT}/apps/web`, packageDirRel: 'apps/web', reportPath: null };
const pyCtx = { packageDirAbs: `${ROOT}/apps/defense-budget-parser`, packageDirRel: 'apps/defense-budget-parser', reportPath: null };
const pwCtx = { packageDirAbs: `${ROOT}/apps/e2e`, packageDirRel: 'apps/e2e', reportPath: null };

function read(p) {
  return fs.readFileSync(path.join(FIX, p), 'utf8');
}

test('jest adapter: keeps duplicate fullName occurrences and normalises suite paths across worktrees', () => {
  const target = { package: '@capiro/api', runner: 'jest', tier: 'test' };
  const r = parseReport(target, { text: read('jest-report.json') }, jestCtx);
  assert.equal(r.tests.length, 6, 'all occurrences preserved');

  const alphaRenders = r.tests.filter((t) => t.fullName === 'Alpha renders');
  assert.equal(alphaRenders.length, 2, 'two identical fullName tests across suites are NOT collapsed');
  assert.deepEqual(alphaRenders.map((t) => t.suite).sort(), ['src/alpha.spec.ts', 'src/beta.spec.ts']);
  assert.deepEqual(alphaRenders.map((t) => t.status).sort(), ['failed', 'passed']);

  const dup = r.tests.filter((t) => t.fullName === 'duplicate name');
  assert.equal(dup.length, 2, 'two identical fullName tests in the SAME suite are not collapsed');

  assert.equal(r.tests.find((t) => t.fullName === 'Alpha nested deep').status, 'skipped');
  assert.equal(r.tests.find((t) => t.fullName === 'todo case').status, 'todo');
  // The second suite came from a DIFFERENT worktree root; the path is relative
  // to the package so the roots do not differ.
  assert.ok(r.tests.every((t) => !t.suite.includes('OTHER-WORKTREE')));
  assert.equal(r.counts.total, 6);
});

test('vitest adapter: parses the jest-shaped vitest JSON reporter', () => {
  const target = { package: '@capiro/web', runner: 'vitest', tier: 'test' };
  const r = parseReport(target, { text: read('vitest-report.json') }, webCtx);
  assert.equal(r.tests.length, 3);
  assert.equal(r.tests.find((t) => t.fullName === 'Widget adds').status, 'passed');
  assert.equal(r.tests.find((t) => t.fullName === 'Widget multiplies').status, 'skipped');
  assert.equal(r.tests.find((t) => t.fullName === 'Widget pending').status, 'skipped', 'vitest pending is a skip, mapped to the canonical skipped status');
  assert.equal(r.tests[0].suite, 'src/Widget.test.tsx');
});

test('pytest adapter: node ids are COLLECTED, not passed; headers/warnings ignored', () => {
  const target = { package: 'capiro-defense-budget-parser', runner: 'pytest', tier: 'pytest-collect' };
  const r = parseReport(target, { text: read('pytest-collect.txt') }, pyCtx);
  assert.equal(r.tests.length, 4, 'four collected node ids');
  assert.ok(r.tests.every((t) => t.status === 'collected'), 'collected IDs never claimed as executed/passed');
  assert.ok(r.tests.some((t) => t.fullName === 'test_main[case-a]'));
  assert.ok(r.tests.some((t) => t.fullName === 'test_main[case-b]'));
  assert.ok(r.tests.some((t) => t.suite === 'tests/test_contracts.py' && t.fullName === 'TestContracts::test_roundtrip'));
  assert.ok(!r.tests.some((t) => t.suite.includes('====') || t.suite.includes('collected')), 'summary lines are not tests');
  assert.ok(r.warnings.some((w) => w.kind === 'module-without-tests'), 'module with no tests is noted, not turned into a test');
});

test('playwright adapter: nested suites, project multiplicity, cross-worktree path', () => {
  const target = { package: '@capiro/e2e', runner: 'playwright', tier: 'playwright-list' };
  const r = parseReport(target, { text: read('playwright-list.json') }, pwCtx);
  assert.equal(r.tests.length, 4);
  const home = r.tests.filter((t) => t.fullName === 'home renders');
  assert.equal(home.length, 2, 'same title in two projects is two occurrences');
  assert.deepEqual(home.map((t) => t.project).sort(), ['desktop', 'mobile']);
  const inner = r.tests.find((t) => t.suite === 'routes.spec.ts' && t.fullName === 'nested group > inner renders');
  assert.ok(inner, 'nested suite title is part of the full name');
  assert.equal(inner.status, 'skipped');
  const auth = r.tests.find((t) => t.fullName === 'sign-in');
  assert.equal(auth.suite, 'auth.spec.ts', 'path normalised from a foreign worktree');
  assert.equal(auth.status, 'failed', 'unexpected maps to failed');
});

test('buildRun: @capiro/e2e runs its own launcher, never the raw external CLI', () => {
  // Exercise the ACTUAL source-bound @capiro/e2e target as the REAL run/dump
  // path discovers it (dynamic discovery over the live workspace), NOT a
  // specially-fabricated target: the discovered target carries the
  // `e2e-playwright-wrapper` adapter, which is exactly what routes buildRun
  // back through the package's OWN launcher.
  const { targets } = discoverTargets({ root: REPO_ROOT });
  const target = targets.find((t) => t.package === '@capiro/e2e' && t.tier === 'test');
  assert.ok(target, 'the real @capiro/e2e test target must be discovered');
  assert.equal(target.adapter, 'e2e-playwright-wrapper', 'the real target carries its native wrapper adapter');
  assert.equal(target.runner, 'playwright', 'classified as its real runner');

  const packageDirAbs = path.resolve(REPO_ROOT, target.packageDir);
  const run = buildRun(target, { root: REPO_ROOT, packageDirAbs, outFile: 'O.json' });
  assert.match(run.cmd, /run-playwright\.mjs/, 'the runner is the package launcher');
  assert.doesNotMatch(run.cmd, /--glob/, 'the launcher owns glob resolution');
  // NEVER the raw external CLI path — the launcher resolves the shared external
  // runtime fail-closed on its own.
  assert.doesNotMatch(run.cmd, /@playwright\/test\/cli\.js/, 'never the raw external Playwright CLI');
  assert.equal(run.cwd, packageDirAbs, 'runs from the real package directory');
  assert.ok(run.cmd.startsWith('node '), 'still the node launcher invocation');

  // NEGATIVE / PATH OBLIGATION: no blanket raw-CLI redirect. A foreign package,
  // a foreign package directory, or a non-launcher command must fall through to
  // the generic external-CLI branch (or an explicit adapter), never be silently
  // claimed by the @capiro/e2e launcher.
  const foreign = { package: '@capiro/other', packageDir: 'apps/other', runner: 'playwright', tier: 'test' };
  const foreignRun = buildRun(foreign, { root: REPO_ROOT, packageDirAbs: path.resolve(REPO_ROOT, 'apps/other'), outFile: 'O.json', playwrightCli: 'C:/dev/node_modules/@playwright/test/cli.js' });
  assert.doesNotMatch(foreignRun.cmd, /run-playwright\.mjs/, 'a foreign package must NOT be routed through the e2e launcher');
  assert.match(foreignRun.cmd, /@playwright\/test\/cli\.js/, 'a foreign playwright target keeps the raw external CLI');
});

test('node:test adapter: nested describe reconstructed from the event stream; duplicates kept; suite container excluded', () => {
  const events = JSON.parse(read('node-test-events.json'));
  const tests = eventsToTests(events);
  assert.equal(tests.length, 5, 'root file node + suite container are not tests');
  const names = tests.map((t) => t.fullName).sort();
  assert.deepEqual(names, [
    'suite > duplicate name',
    'suite > duplicate name',
    'suite > nested > deep one',
    'suite > nested > todo test',
    'suite > skipped one',
  ]);
  const dup = tests.filter((t) => t.fullName === 'suite > duplicate name');
  assert.deepEqual(dup.map((t) => t.status).sort(), ['failed', 'passed']);
  assert.equal(tests.find((t) => t.fullName.endsWith('todo test')).status, 'todo');
  assert.equal(tests.find((t) => t.fullName.endsWith('deep one')).status, 'passed');
  assert.equal(tests.find((t) => t.fullName === 'suite > skipped one').status, 'skipped');

  // And the same records survive the canonical node:test report parser.
  const target = { package: '@capiro/defense-api', runner: 'node:test', tier: 'test' };
  const r = parseReport(target, { text: JSON.stringify({ files: [{ suite: 'src/a.spec.ts', tests }] }) }, {
    packageDirAbs: `${ROOT}/apps/defense-api`,
    packageDirRel: 'apps/defense-api',
    reportPath: null,
  });
  assert.equal(r.tests.length, 5);
  assert.equal(r.tests[0].suite, 'src/a.spec.ts');
});

test('buildRun preserves each package command/config tier and adds only the report flags', () => {
  const mk = (runner, command) => ({ package: 'p', packageDir: 'd', runner, tier: 'test', command });

  const jest = buildRun(mk('jest', 'jest -c jest.jest-style.config.cjs'), { root: ROOT, packageDirAbs: `${ROOT}/infra/cdk`, outFile: 'O.json' });
  assert.match(jest.cmd, /pnpm exec jest -c jest\.jest-style\.config\.cjs --json --outputFile=O\.json/);

  const apiJest = buildRun(mk('jest', 'jest --detectOpenHandles --forceExit'), { root: ROOT, packageDirAbs: `${ROOT}/apps/api`, outFile: 'O.json' });
  assert.match(apiJest.cmd, /jest --detectOpenHandles --forceExit --json --outputFile=O\.json/, 'existing flags are preserved');

  const vitest = buildRun(mk('vitest', 'vitest run --poolOptions.threads.singleThread --testTimeout=20000'), { root: ROOT, packageDirAbs: `${ROOT}/apps/web`, outFile: 'O.json' });
  assert.match(vitest.cmd, /vitest run --poolOptions\.threads\.singleThread --testTimeout=20000 --reporter=json --outputFile=O\.json/);

  const pytest = buildRun(mk('pytest', 'uv run pytest'), { root: ROOT, packageDirAbs: `${ROOT}/apps/defense-budget-parser`, outFile: 'O.json' });
  assert.match(pytest.cmd, /^uv run pytest --collect-only -q$/);

  const nodeTest = buildRun(mk('node:test', 'tsx --test src/**/*.spec.ts'), { root: ROOT, packageDirAbs: `${ROOT}/apps/defense-api`, outFile: 'O.json' });
  assert.match(nodeTest.cmd, /run-node-test\.mjs/);
  assert.match(nodeTest.cmd, /--glob src\/\*\*\/\*\.spec\.ts/);

  const pw = buildRun(mk('playwright', 'playwright test --list --reporter=json'), { root: ROOT, packageDirAbs: `${ROOT}/apps/e2e`, outFile: 'O.json', playwrightCli: 'C:/dev/node_modules/@playwright/test/cli.js' });
  assert.match(pw.cmd, /--list --reporter=json/);
  assert.match(pw.cmd, /C:\/dev\/node_modules\/@playwright\/test\/cli\.js/);

  assert.equal(extractNodeTestGlob('tsx --test src/**/*.spec.ts'), 'src/**/*.spec.ts');

  // Native infra/cdk adaptation: the constructs target routes to the dedicated
  // node:test adapter wrapper, NOT the generic tsx glob runner.
  const cdk = { package: '@capiro/infra-cdk', packageDir: 'infra/cdk', runner: 'node:test', tier: 'test:constructs', command: 'node scripts/run-construct-tests.cjs', adapter: 'cdk-constructs' };
  const cdkRun = buildRun(cdk, { root: ROOT, packageDirAbs: `${ROOT}/infra/cdk`, outFile: 'O.json' });
  assert.match(cdkRun.cmd, /run-cdk-constructs\.mjs/);
  assert.match(cdkRun.cmd, /--package-dir /);
  assert.doesNotMatch(cdkRun.cmd, /--glob /);
});

test('parse failure surfaces as a thrown error (target later recorded as non-passing scope)', () => {
  const target = { package: 'p', runner: 'jest', tier: 'test' };
  assert.throws(() => parseReport(target, { text: '{not json' }, jestCtx));
});

test('pytest parser: an empty listing yields zero tests, not a pass', () => {
  const target = { package: 'p', runner: 'pytest', tier: 'pytest-collect' };
  const r = parseReport(target, { text: 'no tests ran in 0.01s\n' }, pyCtx);
  assert.equal(r.tests.length, 0);
});
