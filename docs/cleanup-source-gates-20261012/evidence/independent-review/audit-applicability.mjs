import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { buildScope } from '/workspace/capirov2-cleanup-gate-reference/scripts/cleanup-gates/lib/scope.mjs';
import { resolveRequiredCoverageScope, ARCHITECTURE_GUARDS } from '/workspace/capirov2-cleanup-gate-reference/scripts/cleanup-gates/gate-config.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
const require = createRequire(import.meta.url);
const yaml = require('/workspace/capirov2/node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/index.js');
const main = '4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace';
const source = '243248e726243c44bd4b9d24fd1ed220da18c56a';
const tree = 'd8f01afa7eca0e6571e7ed3669905fea3491bbdd';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const recorded = '/workspace/capirov2-cleanup-source-gates/docs/cleanup-source-gates-20261012/evidence';
assert.equal(git('rev-parse', 'HEAD'), source);
assert.equal(git('rev-parse', 'HEAD^{tree}'), tree);
assert.equal(git('diff', '--name-only', '11903f32f6257a47e42f49c1abe92c0e0fb0e4fb', source, '--', ':!docs'), '');

function runs(file) {
  const document = yaml.parse(fs.readFileSync(file, 'utf8'));
  return Object.entries(document.jobs ?? {}).flatMap(([job, value]) =>
    (value.steps ?? []).filter(step => typeof step.run === 'string').map(step => ({
      job, name: step.name ?? null,
      run: step.run.split('\n').filter(line => !/^\s*#/.test(line)).join('\n'),
    })));
}
const steps = runs(path.join(root, '.github/workflows/ci-pr.yml'));
const exactPackageTest = (packageName, packageDir) => steps.filter(step =>
  new RegExp(`\\bpnpm\\b[^\\n]*(?:--filter[ =]+["']?${packageName}(?=[\\s"'])|(?:-C|--dir)[ =]+["']?${packageDir}(?=[\\s"']))[^\\n]*(?:\\btest\\b|\\bjest\\b|\\bvitest\\b|--test\\b)`).test(step.run));
const directCI = {
  api: exactPackageTest('@capiro/api', 'apps/api'),
  apiStrategy: exactPackageTest('@capiro/api-strategy', 'apps/api-strategy'),
  web: exactPackageTest('@capiro/web', 'apps/web'),
  defense: exactPackageTest('@capiro/defense-api', 'apps/defense-api'),
};
assert.deepEqual(Object.fromEntries(Object.entries(directCI).map(([key, value]) => [key, value.length > 0])), { api: false, apiStrategy: true, web: false, defense: false });
const workflows = fs.readdirSync(path.join(root, '.github/workflows')).filter(name => /\.ya?ml$/.test(name));
const guardCI = ARCHITECTURE_GUARDS.map(guard => ({ guard, workflows: workflows.filter(name => runs(path.join(root, '.github/workflows', name)).some(step => step.run.includes(guard))) }));
assert.equal(guardCI.filter(item => item.workflows.length === 0).length, 3);

const sourceCarrierPaths = [
  'scripts/cleanup-gates/gate.mjs', 'docs/plans/cleanup1-coverage-baseline.json',
  'scripts/cleanup-gates/verify-baseline.mjs', 'scripts/test-proof/run-fixtures.mjs',
  'scripts/cleanup-gates/pinned-visual-controls.mjs', 'apps/e2e/lib/render-context-controls.mjs',
  'scripts/cleanup-gates/standalone-node.test.mjs', 'apps/e2e/package.json',
  'apps/e2e/scripts/guard-route-coverage.mjs', 'apps/e2e/baselines/manifest.json',
  '.github/workflows/defense-budget-parser-ci.yml',
];
const ownedRuntimeEvidencePaths = ['apps/e2e/reports/regression-evidence.json', 'docs/plans/cleanup1-script-smoke-evidence.json'];
const absentAt = (ref, file) => {
  try { git('cat-file', '-e', `${ref}:${file}`); return false; } catch { return true; }
};
for (const file of sourceCarrierPaths) { assert.ok(absentAt(source, file)); assert.ok(absentAt(main, file)); }
for (const file of ownedRuntimeEvidencePaths) assert.ok(absentAt(source, file));
const scope = buildScope(root);
assert.equal(scope.ok, true);
assert.equal(scope.testBearingPackages.length, 13);
assert.deepEqual(scope.unexplainedUnsupported, []);
const coverage = resolveRequiredCoverageScope(root);
assert.equal(coverage.problems.length, 4);
for (const file of ['package.json', '.github/workflows/ci-pr.yml', 'apps/api/package.json', 'apps/web/package.json', 'apps/workspace/package.json', 'apps/onboard-web/package.json']) {
  assert.equal(git('show', `${source}:${file}`), git('show', `${main}:${file}`));
}

const child = JSON.parse(fs.readFileSync(path.join(recorded, 'cleanup-reference-fixture-child-error.json')));
assert.equal(child.generatedReport, null);
assert.match(child.stdout, /mkdir '\/home\/agent\/\.local\/share\/pnpm'/);
assert.match(child.stdout, /pnpm\.mjs install/);
const diagnostic = JSON.parse(fs.readFileSync(path.join(recorded, 'cleanup-reference-fixture-diagnostic.json')));
assert.equal(diagnostic.sourceHead, '03d85a40e390f8f52614aab20427a3a9433786bb');
assert.equal(diagnostic.dump.targets[0].status, 'error');
assert.equal(diagnostic.dump.targets[0].counts.total, 0);
const correctedMetadata = fs.readdirSync(recorded).filter(name => /^cleanup-reference.*\.command\.json$/.test(name)).map(name => {
  const item = JSON.parse(fs.readFileSync(path.join(recorded, name)));
  assert.equal(item.measuredSource, '03d85a40e390f8f52614aab20427a3a9433786bb');
  assert.equal(item.targetIntegratedSource, source);
  assert.equal(item.nativeAcceptance, false);
  if (item.initialRunnerDeclaredSource) assert.equal(item.initialRunnerDeclaredSource, source);
  return { file: name, measuredSource: item.measuredSource, originalDeclaredSource: item.initialRunnerDeclaredSource ?? null };
});

console.log(JSON.stringify({
  measuredSource: source, measuredTree: tree, toolingSource: '03d85a40e390f8f52614aab20427a3a9433786bb',
  execution: 'Independent YAML parsing and unchanged published discovery predicates only; no leaf runner/database/provider command executed.',
  directCI, guardCI, inheritedMissingSourceCarrier: sourceCarrierPaths,
  unrunOwnedRuntimeEvidence: ownedRuntimeEvidencePaths,
  inheritedCoverageScriptProblems: coverage.problems,
  discoveredTestBearingPackages: scope.testBearingPackages, unsupportedRunners: scope.unexplainedUnsupported,
  referenceFixtureFailureClassification: 'Environment/toolchain: implicit pnpm install failed before fixture JSON; reference run is not RC acceptance.',
  referenceMetadataCorrection: correctedMetadata, nativeAcceptance: false, fullCleanupAcceptance: false,
}, null, 2));
