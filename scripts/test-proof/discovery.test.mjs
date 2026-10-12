/**
 * Fixture tests for dynamic discovery and path normalisation.
 *
 * The discovery fixture is an ISOLATED project tree created in a temp dir, so
 * the test proves "a package another author adds is picked up, and one that
 * cannot be classified is reported rather than silently skipped" without
 * touching the real workspace.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTargets, splitSegments, resolveSegment, classifyRunner, matchNativeAdapter } from './lib/discovery.mjs';
import { normalizeSuitePath } from './lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function makeFixtureWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-discovery-'));
  writeTree(root, {
    'package.json': JSON.stringify({ name: 'root', scripts: { test: 'turbo run test' } }),
    'apps/svc-jest/package.json': JSON.stringify({ name: '@fix/jest', scripts: { test: 'jest --ci' } }),
    'apps/svc-vitest/package.json': JSON.stringify({ name: '@fix/vitest', scripts: { test: 'vitest run' } }),
    'apps/svc-node/package.json': JSON.stringify({ name: '@fix/node', scripts: { test: 'tsx --test src/**/*.spec.ts' } }),
    'apps/agg/package.json': JSON.stringify({ name: '@fix/agg', scripts: { test: 'turbo run test' } }),
    'apps/unknown/package.json': JSON.stringify({ name: '@fix/unknown', scripts: { test: 'mystery-runner --go' } }),
    'apps/no-tests/package.json': JSON.stringify({ name: '@fix/notests', scripts: { build: 'tsc' } }),
    'infra/hybrid/package.json': JSON.stringify({
      name: '@fix/hybrid',
      scripts: {
        test: 'pnpm run test:jest && pnpm run test:constructs',
        'test:jest': 'jest -c jest.jest-style.config.cjs',
        'test:constructs': 'node scripts/run-construct-tests.cjs',
      },
    }),
    'apps/py-app/pyproject.toml': '[project]\nname = "fix-py"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    'apps/py-app/tests/test_a.py': 'def test_a():\n    assert True\n',
    'apps/pw-app/package.json': JSON.stringify({ name: '@fix/pw', scripts: {} }),
    'apps/pw-app/playwright.config.ts': 'export default {};\n',
  });
  return root;
}

test('discovery: picks up every package at run time, including infra/python/playwright', () => {
  const root = makeFixtureWorkspace();
  try {
    const { targets, scope } = discoverTargets({ root });
    const byPackage = new Map(targets.map((t) => [t.package, t]));
    assert.equal(byPackage.get('@fix/jest').runner, 'jest');
    assert.equal(byPackage.get('@fix/vitest').runner, 'vitest');
    assert.equal(byPackage.get('@fix/node').runner, 'node:test');
    assert.equal(byPackage.get('fix-py').runner, 'pytest');
    assert.equal(byPackage.get('@fix/pw').runner, 'playwright');
    // The default tier is the package's own `test` script; the hybrid package's
    // jest half is picked up under its own script name.
    assert.equal(byPackage.get('@fix/hybrid').runner, 'jest');
    assert.equal(byPackage.get('@fix/hybrid').tier, 'test:jest');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovery: unclassifiable command is explicit non-passing scope, never skipped', () => {
  const root = makeFixtureWorkspace();
  try {
    const { scope } = discoverTargets({ root });
    const names = scope.unsupported.map((u) => u.package);
    assert.ok(names.includes('@fix/unknown'), 'unknown runner reported');
    assert.ok(names.includes('@fix/hybrid'), 'hybrid constructs tier reported');
    assert.ok(scope.aggregators.some((a) => a.package === 'root'), 'root turbo aggregator recorded');
    assert.ok(scope.noTestScript.some((n) => n.package === '@fix/notests'), 'package with no test script recorded');
    assert.ok(scope.pythonApps.some((p) => p.package === 'fix-py'));
    assert.ok(scope.playwrightApps.some((p) => p.package === '@fix/pw'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovery: a newly added package is discovered (no checked-in list)', () => {
  const root = makeFixtureWorkspace();
  try {
    const before = discoverTargets({ root }).targets.map((t) => t.package);
    writeTree(root, { 'apps/added/package.json': JSON.stringify({ name: '@fix/added', scripts: { test: 'jest' } }) });
    const after = discoverTargets({ root }).targets.map((t) => t.package);
    assert.ok(!before.includes('@fix/added'));
    assert.ok(after.includes('@fix/added'), 'new package appears without editing the tool');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('splitSegment/resolveSegment/classifyRunner behave for real command shapes', () => {
  assert.deepEqual(splitSegments('a && b && c'), ['a', 'b', 'c']);
  const scripts = { test: 'pnpm run test:jest && pnpm run test:constructs', 'test:jest': 'jest -c x.cjs' };
  assert.equal(resolveSegment('pnpm run test:jest', scripts).command, 'jest -c x.cjs');
  assert.equal(resolveSegment('pnpm run test:jest', scripts).tier, 'test:jest');
  assert.equal(classifyRunner('jest --ci'), 'jest');
  assert.equal(classifyRunner('vitest run'), 'vitest');
  assert.equal(classifyRunner('tsx --test src/**/*.spec.ts'), 'node:test');
  assert.equal(classifyRunner('uv run pytest'), 'pytest');
  assert.equal(classifyRunner('playwright test --list'), 'playwright');
  assert.equal(classifyRunner('node scripts/run.cjs'), null);
});

test('normalizeSuitePath: strips the package prefix, foreign roots, and separators', () => {
  const abs = 'C:/dev/main/cleanup-test-proof-20261007/apps/api';
  const rel = 'apps/api';
  assert.equal(normalizeSuitePath('C:/dev/main/cleanup-test-proof-20261007/apps/api/src/a.spec.ts', abs, rel), 'src/a.spec.ts');
  assert.equal(normalizeSuitePath('C:\\dev\\OTHER\\apps/api/src/b.spec.ts', abs, rel), 'src/b.spec.ts');
  assert.equal(normalizeSuitePath('src/c.spec.ts', abs, rel), 'src/c.spec.ts');
  // Same logical file from two different worktree roots normalises equal.
  assert.equal(
    normalizeSuitePath('C:/dev/main/cleanup-test-proof-20261007/apps/api/src/x.spec.ts', abs, rel),
    normalizeSuitePath('C:/dev/main/other-worktree/apps/api/src/x.spec.ts', abs, rel),
  );
});

test('native adapter: infra/cdk constructs driver is classified as node:test, never waived', () => {
  // Against the REAL workspace: the bespoke constructs driver must appear as a
  // first-class node:test target with its adapter, and must NOT appear in the
  // unsupported/waiver list.
  const { targets, scope } = discoverTargets({ root: REPO_ROOT });
  const cdk = targets.find((t) => t.package === '@capiro/infra-cdk' && t.tier === 'test:constructs');
  assert.ok(cdk, 'infra/cdk constructs target must be discovered');
  assert.equal(cdk.runner, 'node:test', 'classified as its real runner');
  assert.equal(cdk.adapter, 'cdk-constructs', 'native adapter recorded');
  assert.ok(
    !scope.unsupported.some((u) => u.package === '@capiro/infra-cdk'),
    'constructs driver must not be reported as unsupported scope (no quirk waiver)',
  );

  // The adapter is package-scoped: another package with the same command is not
  // silently claimed.
  assert.ok(matchNativeAdapter('@capiro/infra-cdk', 'infra/cdk', 'node scripts/run-construct-tests.cjs'));
  assert.equal(matchNativeAdapter('@capiro/web', 'apps/web', 'node scripts/run-construct-tests.cjs'), null);
  assert.equal(matchNativeAdapter('@capiro/infra-cdk', 'infra/cdk', 'node scripts/other.cjs'), null);
});

test('native adapter: @capiro/e2e Playwright launcher is classified as playwright, never waived', () => {
  // Against the REAL workspace: the post-integration @capiro/e2e `test` script
  // (`node scripts/run-playwright.mjs test`) carries no raw runner token, but it
  // IS a real Playwright suite. It must be represented as a first-class target
  // with its real runner and its native wrapper adapter — and must NEVER appear
  // in the unsupported/waiver list (that would be an unsupported-runner waiver).
  const { targets, scope } = discoverTargets({ root: REPO_ROOT });
  const e2e = targets.find((t) => t.package === '@capiro/e2e' && t.tier === 'test');
  assert.ok(e2e, '@capiro/e2e test target must be discovered');
  assert.equal(e2e.runner, 'playwright', 'classified as its real runner');
  assert.equal(e2e.adapter, 'e2e-playwright-wrapper', 'native wrapper adapter recorded');
  assert.ok(
    !scope.unsupported.some((u) => u.package === '@capiro/e2e'),
    '@capiro/e2e launcher must not be reported as unsupported scope (no quirk waiver, no relaxation)',
  );
  assert.ok(scope.discoveredPackages.includes('@capiro/e2e'), 'the e2e package stays in the discovered set');
});

test('native adapter match is source-bound: wrong package/path/command cannot match', () => {
  // POSITIVE — the exact wrapper command for the exact package/dir (with and
  // without the explicit `test` argument).
  assert.ok(matchNativeAdapter('@capiro/e2e', 'apps/e2e', 'node scripts/run-playwright.mjs test'), 'exact wrapper matches');
  assert.ok(matchNativeAdapter('@capiro/e2e', 'apps/e2e', 'node scripts/run-playwright.mjs'), 'launcher without the arg matches');
  // ADVERSE — wrong package with the identical command.
  assert.equal(matchNativeAdapter('@capiro/web', 'apps/web', 'node scripts/run-playwright.mjs test'), null, 'wrong package must not match');
  // ADVERSE — correct package name but a foreign package dir.
  assert.equal(matchNativeAdapter('@capiro/e2e', 'apps/other', 'node scripts/run-playwright.mjs test'), null, 'wrong package dir must not match');
  // ADVERSE — lookalike paths.
  assert.equal(matchNativeAdapter('@capiro/e2e', 'apps/e2e', 'node scripts/run-playwright-extra.mjs test'), null, 'lookalike script must not match');
  assert.equal(matchNativeAdapter('@capiro/e2e', 'apps/e2e', 'node other/run-playwright.mjs test'), null, 'foreign path must not match');
  // ADVERSE — same path but a different sub-command / extra flags. In
  // particular a snapshot-update invocation must NOT be claimed as the canonical
  // test target (regression mode must never regenerate golden bytes).
  assert.equal(matchNativeAdapter('@capiro/e2e', 'apps/e2e', 'node scripts/run-playwright.mjs build'), null, 'wrong sub-command must not match');
  assert.equal(matchNativeAdapter('@capiro/e2e', 'apps/e2e', 'node scripts/run-playwright.mjs test --update-snapshots'), null, 'snapshot-update flags must not match the canonical target');
});
