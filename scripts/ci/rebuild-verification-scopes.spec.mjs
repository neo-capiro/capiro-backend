import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { restoreReviewedPeManifest } from '../lib/reviewed-pe-manifest-contract.mjs';
import { restoreBackendWorkspaceSource } from '../lib/backend-workspace-retirement.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = '5470c6df029c9553dd49e531229c3c91b26275ef';
const before = (path) =>
  execFileSync('git', ['show', `${baseline}:${path}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
// Compare canonical Git text, including when a Windows checkout uses CRLF.
// The manifest/workspace retirement inverse separately verifies exact identities.
const current = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const originalPackage = JSON.parse(before('package.json'));
const actualPackage = JSON.parse(restoreReviewedPeManifest(current('package.json'), 'root'));
const backendPackage = JSON.parse(current('package.json'));
const quarantinedWorkflow = 'docs/backend-repository-split-preparation-20261013/quarantine/github-workflows/ci-pr.yml.disabled';
const aliasKeys = ['typecheck:backend', 'typecheck:frontend'];
for (const [prefix, phases] of [
  ['verify:engagement-phase-', [1, 2, 3]],
  ['verify:outreach-v3-phase-', [1, 3, 4]],
])
  for (const phase of phases)
    for (const scope of ['backend', 'frontend']) {
      aliasKeys.push(`${prefix}${phase}:${scope}`);
    }
const guardAlias = 'gate:cleanup4:verification-scopes';
// PR2435 added these four independently reviewed operators after this guard's
// original baseline. Recognize exactly their commands before the original
// package inverse; every other alias and all package metadata remain checked.
const phase26Aliases = {
  'validate:knowledge-plane:phase26:backend': 'node scripts/validate-knowledge-plane-phase26.mjs --run --backend-only',
  'validate:knowledge-plane:phase26:backend:typing': 'node scripts/validate-knowledge-plane-phase26.mjs --run --backend-only --skip-tests',
  'validate:knowledge-plane:phase26:backend:source': 'node scripts/validate-knowledge-plane-phase26.mjs --run --backend-only --source-only',
  'validate:knowledge-plane:phase26:frontend': 'node scripts/validate-knowledge-plane-phase26.mjs --run --frontend-only',
};
const webStart = before('.github/workflows/ci-pr.yml').indexOf('      # CleanUp1 §5.3.2');
const webEnd = before('.github/workflows/ci-pr.yml').indexOf('      # CleanUp1 §5.3.3', webStart);
const webStep = before('.github/workflows/ci-pr.yml').slice(webStart, webEnd);

function assertPackagePreserved(pkg) {
  const inverse = structuredClone(pkg);
  for (const [key, command] of Object.entries(phase26Aliases)) {
    assert.equal(Object.hasOwn(originalPackage.scripts, key), false);
    assert.equal(inverse.scripts[key], command, key);
    delete inverse.scripts[key];
  }
  for (const key of [...aliasKeys, guardAlias]) {
    assert.equal(Object.hasOwn(originalPackage.scripts, key), false);
    assert.equal(typeof inverse.scripts[key], 'string');
    delete inverse.scripts[key];
  }
  assert.deepEqual(inverse, originalPackage);
}

function assertWorkflowPreserved(source) {
  const frontIndex = source.indexOf('\n  frontend:\n');
  assert.ok(frontIndex > 0, 'retained frontend needs an independent job');
  let inverse = source.slice(0, frontIndex).trimEnd() + '\n';
  const mappings = [
    [
      '      - name: Guard rebuild verification scope composition\n        run: pnpm gate:cleanup4:verification-scopes\n\n',
      '',
    ],
    [
      '      - name: Typecheck backend workspaces (turbo)\n        run: pnpm typecheck:backend',
      '      - name: Typecheck (turbo)\n        run: pnpm turbo run typecheck --concurrency=1',
    ],
    [
      '        run: pnpm verify:engagement-phase-1:backend\n',
      '        run: pnpm verify:engagement-phase-1\n',
    ],
    [
      '        run: pnpm verify:engagement-phase-2:backend\n',
      '        run: pnpm verify:engagement-phase-2\n',
    ],
  ];
  for (const [from, to] of mappings) {
    assert.equal(inverse.split(from).length, 2, `one declared CI hunk: ${from}`);
    inverse = inverse.replace(from, to);
  }
  const anchor = '      # CleanUp1 §5.3.3';
  assert.equal(inverse.split(anchor).length, 2);
  inverse = inverse.replace(anchor, webStep + anchor);
  assert.equal(
    inverse,
    before('.github/workflows/ci-pr.yml'),
    'all prior backend/trigger/condition/guard bytes retained',
  );
  const expectedFrontend = current('scripts/ci/__fixtures__/rebuild-verification-frontend.job.yml');
  assert.equal(
    source.slice(frontIndex),
    expectedFrontend,
    'exact prerequisite, independent frontend and original Web test union',
  );
}

test('destination package preserves all 107 existing aliases and all metadata', () => {
  assert.equal(Object.keys(originalPackage.scripts).length, 107);
  assert.equal(aliasKeys.length, 14);
  assertPackagePreserved(actualPackage);
  assert.equal(
    actualPackage.scripts[guardAlias],
    'node --test scripts/ci/rebuild-verification-scopes.spec.mjs',
  );
});

test('only the four reviewed Phase26 aliases extend the original package inverse', () => {
  assert.equal(Object.keys(phase26Aliases).length, 4);
  for (const key of Object.keys(phase26Aliases)) {
    const missing = structuredClone(actualPackage);
    delete missing.scripts[key];
    assert.throws(() => assertPackagePreserved(missing));
    const changed = structuredClone(actualPackage);
    changed.scripts[key] += ' --skip-tests';
    assert.throws(() => assertPackagePreserved(changed));
  }
  const extra = structuredClone(actualPackage);
  extra.scripts['validate:unreviewed'] = 'node scripts/unreviewed.mjs';
  assert.throws(() => assertPackagePreserved(extra));
  const changedMetadata = structuredClone(actualPackage);
  changedMetadata.engines.node = '>=1';
  assert.throws(() => assertPackagePreserved(changedMetadata));
});

test('Phase1 scoped operands retain one explicit run and every current syntax check', () => {
  const full = originalPackage.scripts['verify:engagement-phase-1'].split(' && ');
  assert.equal(full.length, 7);
  assert.equal((full[0].match(/(?:^|\s)--run(?:\s|$)/g) ?? []).length, 1);
  assert.equal(
    actualPackage.scripts['verify:engagement-phase-1:backend'],
    [full[0] + ' --backend-only', ...full.slice(1, 5)].join(' && '),
  );
  assert.equal(
    actualPackage.scripts['verify:engagement-phase-1:frontend'],
    [full[0] + ' --frontend-only', ...full.slice(5)].join(' && '),
  );
});

test('all twelve scoped verification aliases bind one run and exactly one declared scope', () => {
  for (const key of aliasKeys.filter((key) => key.startsWith('verify:'))) {
    const first = actualPackage.scripts[key].split(' && ')[0];
    assert.equal((first.match(/(?:^|\s)--run(?:\s|$)/g) ?? []).length, 1, key);
    const scope = key.endsWith(':backend') ? '--backend-only' : '--frontend-only';
    assert.equal(first.trim().endsWith(scope), true, key);
    assert.equal((first.match(/--(?:backend|frontend)-only/g) ?? []).length, 1, key);
  }
  for (const scope of ['backend', 'frontend']) {
    assert.equal(
      actualPackage.scripts[`verify:engagement-phase-2:${scope}`],
      `bash scripts/verify-engagement-phase2-code.sh --run --${scope}-only`,
    );
  }
});

// Identity mapping: the former 19/17/Web+Onboard case now measures explicit
// workspace membership: 18 typed packages, 16 backend, retained Onboard and E2E.
test('current 18 typed workspaces partition 16 backend plus retained Onboard/E2E with Web excluded', () => {
  const names = [];
  for (const group of ['apps', 'packages', 'infra'])
    for (const directory of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      if (`${group}/${directory.name}` === 'apps/web') continue;
      let data;
      try {
        data = JSON.parse(current(`${group}/${directory.name}/package.json`));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (data.scripts?.typecheck) names.push(data.name);
    }
  assert.equal(names.length, 18);
  assert.ok(names.includes('@capiro/api') && names.includes('@capiro/onboard-api'));
  for (const name of ['@capiro/e2e', '@capiro/onboard-web']) assert.ok(names.includes(name));
  assert.equal(names.includes('@capiro/web'), false);
  assert.equal(existsSync(join(root, 'apps/web/package.json')), false);
  assert.deepEqual(names.filter(name => !['@capiro/e2e', '@capiro/onboard-web'].includes(name)).sort(), [
    '@capiro/api', '@capiro/api-strategy', '@capiro/auth', '@capiro/clio-sandbox',
    '@capiro/defense-api', '@capiro/defense-client', '@capiro/defense-contracts',
    '@capiro/defense-domain', '@capiro/infra-cdk', '@capiro/intel-api',
    '@capiro/meriv2-core', '@capiro/meriv2-orchestrator', '@capiro/onboard-api',
    '@capiro/shared', '@capiro/strategy-verifier', '@capiro/workspace',
  ].sort());
  assert.equal(
    backendPackage.scripts['typecheck:backend'],
    'turbo run typecheck --concurrency=1 --filter="!@capiro/onboard-web" --filter="!@capiro/e2e"',
  );
  assert.equal(
    backendPackage.scripts['typecheck:frontend'],
    'turbo run typecheck --concurrency=1 --filter=@capiro/onboard-web',
  );
  assert.equal(restoreBackendWorkspaceSource(current('pnpm-workspace.yaml'), 'pnpm-workspace.yaml'), before('pnpm-workspace.yaml'));
});

// Identity mapping: the former active-CI case retains its byte/union assertions
// against the inert preparation quarantine and now also proves it is inactive.
test('quarantined CI retains exactly the destination scope hunk union and every old guard/test/condition', () => {
  assert.equal(existsSync(join(root, '.github/workflows/ci-pr.yml')), false);
  assertWorkflowPreserved(current(quarantinedWorkflow));
});

test('source contract refuses dropping any old gate or metadata, narrowing a backend test, or coupling frontend status', () => {
  for (const key of [
    'gate:cleanup4:tango-page-leaves',
    'gate:cleanup4:strategy-template-metadata',
    'gate:cleanup4:workspace-product-metadata',
    'gate:cleanup4:meri-local-dispatch',
    'verify:engagement-phase-1',
  ]) {
    const mutated = structuredClone(actualPackage);
    delete mutated.scripts[key];
    assert.throws(() => assertPackagePreserved(mutated));
  }
  const mutatedPackage = structuredClone(actualPackage);
  mutatedPackage.packageManager = 'pnpm@99';
  assert.throws(() => assertPackagePreserved(mutatedPackage));
  const workflow = current(quarantinedWorkflow);
  for (const mutate of [
    (text) => text.replace('run: pnpm gate:cleanup4:meri-local-dispatch', 'run: true'),
    (text) =>
      text.replace(
        'run: pnpm --filter @capiro/api test',
        'run: pnpm --filter @capiro/api test --only',
      ),
    (text) => text.replace("${{ toJSON(github.event.pull_request.draft) == 'false' }}", 'false'),
    (text) => text.replace('ready_for_review', 'closed'),
    (text) => text.replace('\n  frontend:\n', '\n  frontend:\n    needs: verify\n'),
    (text) => text.replace('run: pnpm --filter @capiro/web test', 'run: true'),
  ])
    assert.throws(() => assertWorkflowPreserved(mutate(workflow)));
});
